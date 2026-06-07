// M2MResolver — the C# runtime many-to-many query resolver (FR-018).
//
// This is the SHIPPING resolver a real C# adopter references at runtime: given a
// source entity id and an M:N relationship, traverse the junction/through entity
// and return the related target rows (the `GET /<source-plural>/{id}/<relation>`
// contract). It is the C# peer of the Java OMDB `M2MResolver` (the `omdb`
// data-access package), the TS `runtime-ts/src/n2m-resolver.ts`, the Kotlin
// `M2mJoinResolver`, and the Python ObjectManager m2m path.
//
// SITING. The resolver needs the loaded model (`MetaObject` / `MetaRoot`, which
// live in MetaObjects core) to derive junction FK direction, plus a live data
// connection. MetaObjects.Codegen references core and is the documented runtime
// home for consumer-referenced helpers (FilterParser, EfCoreFilterDispatch,
// ExtractObject) — mirroring the Java port's `om`/`omdb` siting and TS's
// `runtime-ts`. The resolver addresses the schema over the provider-neutral
// System.Data.Common abstraction (an open DbConnection the consumer supplies),
// so the shipping assembly takes NO Npgsql package dependency — a consumer hands
// it their NpgsqlConnection (or any ADO.NET connection).
//
// A M:N relationship declares only the slim FR-018 vocabulary on the source
// entity: @cardinality: "many" + @objectRef: <target> + @through: <junction>
// (plus optional @sourceRefField / @symmetric for self-joins). It does NOT
// restate the junction FK columns — those are DERIVED from the junction entity's
// two identity.reference children via the shared M2MDerivation helper (the SSOT
// for FK direction, the same one the loader validator + every other port use).
//
// Resolution has three modes (see the FR-018 design):
//   1. Hetero (source != target): junction WHERE sourceCol = source.pk, collect
//      targetCol, then target WHERE pk IN (...).
//   2. Directed self-join (@sourceRefField): identical traversal; M2MDerivation
//      has already picked which junction FK is the source side.
//   3. Symmetric self-join (@symmetric: true): single-row storage, union on read —
//      junction WHERE sourceCol = id OR targetCol = id; for each row the related
//      id is whichever FK column is NOT the source id (a self-pair where both
//      columns equal the source id yields the source id itself).

using System;
using System.Collections.Generic;
using System.Data.Common;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using MetaObjects.Core.Field;
using MetaObjects.Core.Relationship;
using MetaObjects.Meta;

namespace MetaObjects.Codegen.Runtime;

/// <summary>
/// Resolves a M:N relationship traversal against a live SQL database, deriving the
/// junction FK columns from metadata. Provider-neutral: the caller supplies an open
/// ADO.NET <see cref="DbConnection"/> (e.g. an <c>NpgsqlConnection</c>).
/// </summary>
public static class M2MResolver
{
    /// <summary>
    /// Traverse <paramref name="relationName"/> from the source record identified
    /// by <paramref name="sourceId"/>, returning the related target rows (each a
    /// metadata-field-keyed dictionary). Membership is a set; the caller compares
    /// order-independently.
    /// </summary>
    /// <param name="conn">an open ADO.NET connection (the consumer's, e.g. Npgsql).</param>
    /// <param name="root">the loaded model root (to find junction + target entities).</param>
    /// <param name="entityName">the source entity declaring the relationship.</param>
    /// <param name="sourceId">the source record key (a scalar; coerced to the PK's native type).</param>
    /// <param name="relationName">the M:N relationship name on the source entity.</param>
    public static async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> RelateAsync(
        DbConnection conn, MetaRoot root, string entityName, object? sourceId, string relationName)
    {
        var source = root.FindObject(entityName)
            ?? throw new InvalidOperationException($"relate: entity '{entityName}' not found in metadata");

        var rel = source.Relationships().FirstOrDefault(r => r.Name == relationName)
            ?? throw new InvalidOperationException(
                $"relate: relationship '{relationName}' not found on '{entityName}'");

        if (rel.Through is null)
            throw new InvalidOperationException(
                $"relate: relationship '{entityName}.{relationName}' is not M:N (no @through)");

        // Derive the [sourceField, targetField] junction FK fields from the
        // junction's two identity.reference children (hetero / directed / symmetric).
        var fields = M2MDerivation.DeriveM2MFields(rel, source, root);

        var junction = root.FindObject(rel.Through!)
            ?? throw new InvalidOperationException($"relate: junction '{rel.Through}' not found");
        var target = root.FindObject(rel.ObjectRef!)
            ?? throw new InvalidOperationException($"relate: target '{rel.ObjectRef}' not found");

        var junctionTable = TableOf(junction);
        var targetTable = TableOf(target);
        var sourceCol = ColumnOf(junction, fields.SourceField);
        var targetCol = ColumnOf(junction, fields.TargetField);
        var targetPkCol = ColumnOf(target, PrimaryKeyField(target));

        // The `by` id arrives as a scalar (often a string); coerce it to the source
        // entity's PK native type so the parameter binds with the right SQL type
        // (a string would make Postgres reject `bigint = text`).
        var sourcePkField = source.FindField(PrimaryKeyField(source));
        var typedSourceId = CoerceId(sourceId, sourcePkField);

        // 1. Query the junction for the related target ids.
        var relatedIds = rel.Symmetric
            ? await CollectSymmetricAsync(conn, junctionTable, sourceCol, targetCol, typedSourceId)
            : await CollectDirectedAsync(conn, junctionTable, sourceCol, targetCol, typedSourceId);

        if (relatedIds.Count == 0)
            return Array.Empty<IReadOnlyDictionary<string, object?>>();

        // 2. Load the target rows by PK.
        return await LoadByIdsAsync(conn, target, targetTable, targetPkCol, relatedIds);
    }

    // -----------------------------------------------------------------------
    // Junction traversal
    // -----------------------------------------------------------------------

    /// <summary>Hetero + directed self-join: junction WHERE sourceCol = id → targetCol.</summary>
    private static async Task<List<object>> CollectDirectedAsync(
        DbConnection conn, string junctionTable, string sourceCol, string targetCol, object? sourceId)
    {
        var sql = $"SELECT {Quote(targetCol)} FROM {Quote(junctionTable)} WHERE {Quote(sourceCol)} = @id";
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        AddParam(cmd, "id", sourceId);

        var ids = new List<object>();
        var seen = new HashSet<string>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            if (reader.IsDBNull(0)) continue;
            var v = reader.GetValue(0);
            if (seen.Add(KeyOf(v))) ids.Add(v);
        }
        return ids;
    }

    /// <summary>
    /// Symmetric union-on-read: junction WHERE sourceCol = id OR targetCol = id;
    /// for each row the related id is whichever column is NOT the source id. A
    /// self-pair row (both columns equal the source id) yields the source id.
    /// </summary>
    private static async Task<List<object>> CollectSymmetricAsync(
        DbConnection conn, string junctionTable, string sourceCol, string targetCol, object? sourceId)
    {
        var sql =
            $"SELECT {Quote(sourceCol)}, {Quote(targetCol)} FROM {Quote(junctionTable)} " +
            $"WHERE {Quote(sourceCol)} = @id OR {Quote(targetCol)} = @id";
        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        AddParam(cmd, "id", sourceId);

        var sourceKey = sourceId is null ? null : KeyOf(sourceId);
        var ids = new List<object>();
        var seen = new HashSet<string>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var a = reader.IsDBNull(0) ? null : reader.GetValue(0);
            var b = reader.IsDBNull(1) ? null : reader.GetValue(1);
            // The related endpoint is the column that is NOT the source id; when
            // `a` is the source, the other endpoint is `b` (and vice-versa). For a
            // self-pair both are the source id, so `other` resolves to the source.
            var aIsSource = a is not null && sourceKey is not null && KeyOf(a) == sourceKey;
            var other = aIsSource ? b : a;
            if (other is null) continue;
            if (seen.Add(KeyOf(other))) ids.Add(other);
        }
        return ids;
    }

    /// <summary>Load target rows WHERE pk = ANY(ids), keyed by metadata field name.</summary>
    private static async Task<IReadOnlyList<IReadOnlyDictionary<string, object?>>> LoadByIdsAsync(
        DbConnection conn, MetaObject target, string targetTable, string targetPkCol, List<object> ids)
    {
        // SELECT every scalar field column of the target, aliased back to the
        // metadata field name so the row shape matches the wire contract.
        var scalarFields = target.Fields().ToList();
        var selectList = string.Join(", ",
            scalarFields.Select(f => $"{Quote(ColumnOf(target, f.Name))} AS {Quote(f.Name)}"));
        var sql = $"SELECT {selectList} FROM {Quote(targetTable)} WHERE {Quote(targetPkCol)} = ANY(@ids)";

        await using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        // Bind a strongly-typed array — the FK values read from the junction are
        // already native (BIGINT → long etc.), so a homogeneous typed array lets
        // the provider infer the right element type (an object[] would not bind).
        AddParam(cmd, "ids", ToTypedArray(ids));

        var rows = new List<IReadOnlyDictionary<string, object?>>();
        await using var reader = await cmd.ExecuteReaderAsync();
        while (await reader.ReadAsync())
        {
            var row = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }

    // -----------------------------------------------------------------------
    // Metadata → physical-name resolution
    // -----------------------------------------------------------------------

    private static string TableOf(MetaObject obj) =>
        obj.DbTable ?? obj.DbView
        ?? throw new InvalidOperationException($"object '{obj.Name}' has no physical source name");

    // The corpus schema uses literal column naming (column == field name); honor an
    // explicit @column override if present.
    private static string ColumnOf(MetaObject obj, string fieldName)
    {
        var field = obj.FindField(fieldName);
        return field?.DbColumn ?? fieldName;
    }

    /// <summary>
    /// Coerce a `by`-id scalar to the source PK's native CLR type so the SQL
    /// parameter binds with the right type (string would trip <c>bigint = text</c>).
    /// </summary>
    private static object? CoerceId(object? raw, MetaField? pkField)
    {
        if (raw is null) return null;
        var subType = pkField?.SubType;
        var s = Convert.ToString(raw, CultureInfo.InvariantCulture)!;
        return subType switch
        {
            FieldConstants.FIELD_SUBTYPE_LONG => long.Parse(s, CultureInfo.InvariantCulture),
            FieldConstants.FIELD_SUBTYPE_INT  => int.Parse(s, CultureInfo.InvariantCulture),
            FieldConstants.FIELD_SUBTYPE_UUID => Guid.Parse(s),
            _ => raw,
        };
    }

    private static string PrimaryKeyField(MetaObject obj)
    {
        var pk = obj.PrimaryIdentity()
            ?? throw new InvalidOperationException($"entity '{obj.Name}' has no primary identity");
        if (pk.Fields.Count == 0)
            throw new InvalidOperationException($"entity '{obj.Name}' primary identity has no fields");
        return pk.Fields[0];
    }

    // String-coerced identity key — source ids (from input) and junction FK values
    // (from the driver) may differ in CLR type (long vs the same long boxed
    // differently); compare by string to bridge, mirroring the other ports.
    private static string KeyOf(object value) => Convert.ToString(value, CultureInfo.InvariantCulture)!;

    private static string Quote(string identifier) => "\"" + identifier.Replace("\"", "\"\"") + "\"";

    // Build a homogeneous typed array from collected FK values so the provider infers
    // the element type. All elements share one CLR type (one junction FK column).
    private static Array ToTypedArray(List<object> values)
    {
        var elementType = values[0].GetType();
        var arr = Array.CreateInstance(elementType, values.Count);
        for (int i = 0; i < values.Count; i++) arr.SetValue(values[i], i);
        return arr;
    }

    private static void AddParam(DbCommand cmd, string name, object? value)
    {
        var p = cmd.CreateParameter();
        p.ParameterName = name;
        p.Value = value ?? DBNull.Value;
        cmd.Parameters.Add(p);
    }
}
