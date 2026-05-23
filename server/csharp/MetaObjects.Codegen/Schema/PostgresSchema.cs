// PostgresSchema — emits Postgres DDL from metadata: CREATE TABLE per entity
// (columns/PK/NOT NULL/UNIQUE) and CREATE VIEW per read-only projection.
//
// Column + table names mirror the EF Core generators ([Table]/[Column] use the
// dbTable/dbColumn override or the raw name), so the generated entities map onto
// this schema. View SELECTs are derived from field origins: passthrough (plain
// column), passthrough-@via (to-one correlated subquery), aggregate (to-many
// correlated subquery), and collection (json_agg over a to-many). FK columns are
// resolved from identity.reference; an unresolvable origin leaves a TODO comment
// (+ warning) rather than emitting incorrect SQL.
//
// Shape note: aggregates use a correlated subquery per origin, not the TS
// reference's LEFT JOIN + GROUP BY (view-ddl-emit.ts). Both produce the same view
// rows; subqueries scope each to-many independently, so multiple aggregates over
// different relationships can't fan-out/double-count (the reason TS needs
// COUNT(DISTINCT), which still mis-sums SUM/AVG across joins). View DDL is a
// generated artifact, not a conformance-pinned invariant — the SQL form is free.

using System.Text;
using MetaObjects.Meta;
using static MetaObjects.Core.Field.FieldConstants;
using static MetaObjects.Shared.BaseTypes;

namespace MetaObjects.Codegen.Schema;

/// <summary>Postgres DDL generation from a loaded model.</summary>
public static class PostgresSchema
{
    /// <summary>Field subtype -> Postgres column type (varchar(n) when @maxLength is set).</summary>
    public static string PgType(MetaField field) => field.SubType switch
    {
        FIELD_SUBTYPE_STRING or FIELD_SUBTYPE_CLASS =>
            field.MaxLength is long n ? $"varchar({n})" : "text",
        FIELD_SUBTYPE_INT       => "integer",
        FIELD_SUBTYPE_SHORT     => "smallint",
        FIELD_SUBTYPE_BYTE      => "smallint",
        FIELD_SUBTYPE_LONG      => "bigint",
        FIELD_SUBTYPE_CURRENCY  => "bigint",      // integer minor units
        FIELD_SUBTYPE_DOUBLE    => "double precision",
        FIELD_SUBTYPE_FLOAT     => "real",
        FIELD_SUBTYPE_DECIMAL   => field.Precision is long p
            ? $"numeric({p}, {field.Scale ?? 0})" : "numeric",
        FIELD_SUBTYPE_BOOLEAN   => "boolean",
        FIELD_SUBTYPE_DATE      => "date",
        FIELD_SUBTYPE_TIME      => "time",
        FIELD_SUBTYPE_TIMESTAMP => "timestamp",
        _ => "text",
    };

    private static string Col(MetaField f) => f.DbColumn ?? f.Name;

    /// <summary>CREATE TABLE for a writable entity (columns + PK + NOT NULL + UNIQUE).</summary>
    public static string CreateTable(MetaObject entity)
    {
        var table = entity.DbTable ?? entity.Name;
        var pk = entity.PrimaryIdentity();
        var pkCols = (pk?.Fields ?? []).ToHashSet(StringComparer.Ordinal);

        var lines = new List<string>();
        foreach (var f in entity.Fields().Where(f => CSharpNaming.ScalarFor(f.SubType) is not null))
        {
            var notNull = CSharpNaming.IsRequired(entity, f) ? " NOT NULL" : string.Empty;
            lines.Add($"  {Col(f)} {PgType(f)}{notNull}");
        }
        if (pk is not null && pk.Fields.Count > 0)
        {
            var cols = entity.Fields().Where(f => pkCols.Contains(f.Name)).Select(Col);
            lines.Add($"  PRIMARY KEY ({string.Join(", ", cols)})");
        }

        var sb = new StringBuilder();
        sb.AppendLine($"CREATE TABLE {table} (");
        sb.AppendLine(string.Join(",\n", lines));
        sb.AppendLine(");");

        // UNIQUE indexes from secondary identities marked unique.
        foreach (var sec in entity.SecondaryIdentities().Where(i => i.Unique))
        {
            var cols = entity.Fields().Where(f => sec.Fields.Contains(f.Name)).Select(Col);
            sb.AppendLine($"CREATE UNIQUE INDEX {table}_{sec.Name}_uniq ON {table} ({string.Join(", ", cols)});");
        }
        return sb.ToString();
    }

    /// <summary>
    /// CREATE VIEW for a projection. Derives the SELECT from field origins:
    /// passthrough (single base) → a plain column; aggregate (@agg/@of/@via) → a
    /// correlated subquery whose FK is resolved from an identity.reference on the
    /// target entity. Multi-base, @via passthrough, collection, or an unresolvable
    /// FK leave the view as a TODO comment (+ warning) rather than wrong SQL.
    /// </summary>
    public static string CreateView(MetaObject projection, MetaRoot root, Action<string> warn)
    {
        var view = projection.DbView!;
        var cols = new List<string>();
        string? baseEntity = null;
        string? blocked = null;
        const string T = "t"; // target alias inside correlated subqueries (self-reference safe)

        string BaseTable() => root.FindObject(baseEntity!)?.DbTable ?? baseEntity!;

        foreach (var f in projection.Fields())
        {
            var origin = f.OwnChildren().FirstOrDefault(c => c.Type == TYPE_ORIGIN);

            // passthrough, no via → a plain column off the single base.
            if (origin is MetaPassthroughOrigin pt && pt.Via is null && pt.From is { } from && from.Contains('.'))
            {
                var (ent, field) = SplitDot(from);
                baseEntity ??= StripPkg(ent);
                if (StripPkg(ent) != baseEntity) { blocked = "passthrough from multiple base entities"; break; }
                cols.Add($"  {ResolveColumn(root.FindObject(baseEntity), field)} AS {Col(f)}");
            }
            // passthrough WITH via → forward a field from a to-one related entity (correlated subquery).
            else if (origin is MetaPassthroughOrigin ptv && ptv.Via is { } pvia && ptv.From is { } pfrom &&
                     pvia.Contains('.') && pfrom.Contains('.'))
            {
                var (baseEnt, relName) = SplitDot(pvia);
                baseEntity ??= StripPkg(baseEnt);
                if (StripPkg(baseEnt) != baseEntity) { blocked = "passthrough via a different base entity"; break; }
                if (ToOneFk(root, baseEntity, relName) is not { } fk)
                { blocked = $"unresolved to-one FK for @via \"{pvia}\" (base needs an identity.reference)"; break; }
                var srcCol = ResolveColumn(fk.Target, SplitDot(pfrom).Tail);
                cols.Add($"  (SELECT {T}.{srcCol} FROM {fk.TargetTable} {T} WHERE {T}.{fk.TargetKeyCol} = {BaseTable()}.{fk.BaseFkCol}) AS {Col(f)}");
            }
            // aggregate → count/sum/... over a to-many relationship (correlated subquery).
            else if (origin is MetaAggregateOrigin agg && agg.Agg is { } aggFn && agg.Of is { } of && agg.Via is { } via &&
                     of.Contains('.') && via.Contains('.'))
            {
                var (baseEnt, relName) = SplitDot(via);
                baseEntity ??= StripPkg(baseEnt);
                if (StripPkg(baseEnt) != baseEntity) { blocked = "aggregate over a different base entity"; break; }
                if (ToManyFk(root, baseEntity, relName) is not { } fk)
                { blocked = $"unresolved to-many FK for @via \"{via}\" (target needs an identity.reference back to {baseEntity})"; break; }
                var ofCol = ResolveColumn(fk.Target, SplitDot(of).Tail);
                cols.Add($"  (SELECT {aggFn}({T}.{ofCol}) FROM {fk.TargetTable} {T} WHERE {T}.{fk.FkCol} = {BaseTable()}.{fk.ParentCol}) AS {Col(f)}");
            }
            // collection → array of nested view-objects over a to-many relationship (json_agg).
            else if (origin is MetaCollectionOrigin coll && coll.Via is { } cvia && cvia.Contains('.') && f.ObjectRef is { } objRef)
            {
                var (baseEnt, relName) = SplitDot(cvia);
                baseEntity ??= StripPkg(baseEnt);
                if (StripPkg(baseEnt) != baseEntity) { blocked = "collection over a different base entity"; break; }
                var nested = root.FindObject(StripPkg(objRef));
                if (ToManyFk(root, baseEntity, relName) is not { } fk || nested is null)
                { blocked = $"unresolved collection @via \"{cvia}\" / @objectRef \"{objRef}\""; break; }
                var pairs = nested.Fields()
                    .Where(nf => CSharpNaming.ScalarFor(nf.SubType) is not null)
                    .Select(nf => $"'{nf.Name}', {T}.{ResolveColumn(fk.Target, nf.Name)}");
                cols.Add($"  (SELECT coalesce(json_agg(json_build_object({string.Join(", ", pairs)})), '[]'::json) " +
                         $"FROM {fk.TargetTable} {T} WHERE {T}.{fk.FkCol} = {BaseTable()}.{fk.ParentCol}) AS {Col(f)}");
            }
            else
            {
                blocked = "field has no resolvable origin";
                break;
            }
        }

        if (blocked is not null || baseEntity is null || cols.Count == 0)
        {
            warn($"meta migrate: view \"{view}\" not generated — {blocked ?? "no derivable columns"}.");
            return $"-- TODO CREATE VIEW {view}: {blocked ?? "no derivable columns"}\n";
        }

        return $"CREATE VIEW {view} AS\nSELECT\n{string.Join(",\n", cols)}\nFROM {BaseTable()};\n";
    }

    private static (string Head, string Tail) SplitDot(string s)
    {
        var i = s.IndexOf('.');
        return (s[..i], s[(i + 1)..]);
    }

    private static string StripPkg(string s)
    {
        var i = s.LastIndexOf("::", StringComparison.Ordinal);
        return i < 0 ? s : s[(i + 2)..];
    }

    private static string ResolveColumn(MetaObject? obj, string fieldName) =>
        obj?.Fields().FirstOrDefault(f => f.Name == fieldName)?.DbColumn ?? fieldName;

    // Resolve a to-many relationship to the FK that lives on the *target* entity:
    // the target carries an identity.reference back to the base. Used by aggregate
    // and collection origins (subquery scans the target, filtered by the base PK).
    private static (MetaObject Target, string TargetTable, string FkCol, string ParentCol)? ToManyFk(
        MetaRoot root, string baseEntity, string relName)
    {
        var baseObj = root.FindObject(baseEntity);
        var rel = baseObj?.Relationships().FirstOrDefault(r => r.Name == relName);
        if (baseObj is null || rel?.ObjectRef is not { } objRef) return null;
        var target = root.FindObject(StripPkg(objRef));
        if (target is null) return null;

        var fkRef = target.ReferenceIdentities()
            .FirstOrDefault(r => r.TargetEntity is { } te && StripPkg(te) == baseEntity);
        if (fkRef is null || fkRef.Fields.Count == 0) return null;

        var fkCol = ResolveColumn(target, fkRef.Fields[0]);
        var parentField = fkRef.TargetFields.Count > 0
            ? fkRef.TargetFields[0]
            : baseObj.PrimaryIdentity()?.Fields.FirstOrDefault();
        if (parentField is null) return null;

        return (target, target.DbTable ?? target.Name, fkCol, ResolveColumn(baseObj, parentField));
    }

    // Resolve a to-one relationship to the FK that lives on the *base* entity:
    // the base carries an identity.reference at the target. Used by passthrough-@via
    // origins (subquery selects from the target, joined on the base's FK column).
    private static (MetaObject Target, string TargetTable, string TargetKeyCol, string BaseFkCol)? ToOneFk(
        MetaRoot root, string baseEntity, string relName)
    {
        var baseObj = root.FindObject(baseEntity);
        var rel = baseObj?.Relationships().FirstOrDefault(r => r.Name == relName);
        if (baseObj is null || rel?.ObjectRef is not { } objRef) return null;
        var target = root.FindObject(StripPkg(objRef));
        if (target is null) return null;

        var fkRef = baseObj.ReferenceIdentities()
            .FirstOrDefault(r => r.TargetEntity is { } te && StripPkg(te) == StripPkg(objRef));
        if (fkRef is null || fkRef.Fields.Count == 0) return null;

        var baseFkCol = ResolveColumn(baseObj, fkRef.Fields[0]);
        var targetKeyField = fkRef.TargetFields.Count > 0
            ? fkRef.TargetFields[0]
            : target.PrimaryIdentity()?.Fields.FirstOrDefault();
        if (targetKeyField is null) return null;

        return (target, target.DbTable ?? target.Name, ResolveColumn(target, targetKeyField), baseFkCol);
    }

    /// <summary>Full schema DDL: tables for writable entities, then views for projections.</summary>
    public static string BuildSchema(MetaRoot root, Action<string>? warn = null)
    {
        var warnFn = warn ?? (_ => { });
        var sb = new StringBuilder();
        sb.AppendLine("-- Generated by MetaObjects meta migrate (Postgres). Do not edit by hand.");
        sb.AppendLine();

        foreach (var e in root.Objects().Where(o => o.IsEntity() && !o.IsReadOnlyProjection())
                     .OrderBy(o => o.Name, StringComparer.Ordinal))
        {
            sb.AppendLine(CreateTable(e));
        }
        foreach (var p in root.Objects().Where(o => o.IsReadOnlyProjection())
                     .OrderBy(o => o.Name, StringComparer.Ordinal))
        {
            sb.AppendLine(CreateView(p, root, warnFn));
        }
        return sb.ToString();
    }
}
