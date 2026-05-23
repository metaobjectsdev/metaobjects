// PostgresSchema — emits Postgres DDL from metadata: CREATE TABLE per entity
// (columns/PK/NOT NULL/UNIQUE) and CREATE VIEW per read-only projection.
//
// Column + table names mirror the EF Core generators ([Table]/[Column] use the
// dbTable/dbColumn override or the raw name), so the generated entities map onto
// this schema. View SELECTs are derived from field origins for the common case
// (passthrough from a single base, no relationship hop); aggregate / @via /
// collection origins are flagged as a TODO rather than emitting incorrect SQL.

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

        foreach (var f in projection.Fields().Where(f => CSharpNaming.ScalarFor(f.SubType) is not null))
        {
            var origin = f.OwnChildren().FirstOrDefault(c => c.Type == TYPE_ORIGIN);

            if (origin is MetaPassthroughOrigin pt && pt.Via is null && pt.From is { } from && from.Contains('.'))
            {
                var (ent, field) = SplitDot(from);
                baseEntity ??= StripPkg(ent);
                if (StripPkg(ent) != baseEntity) { blocked = "passthrough from multiple base entities"; break; }
                cols.Add($"  {ResolveColumn(root.FindObject(baseEntity), field)} AS {Col(f)}");
            }
            else if (origin is MetaAggregateOrigin agg &&
                     agg.Agg is { } aggFn && agg.Of is { } of && agg.Via is { } via &&
                     of.Contains('.') && via.Contains('.'))
            {
                var (baseEnt, relName) = SplitDot(via);
                baseEntity ??= StripPkg(baseEnt);
                if (StripPkg(baseEnt) != baseEntity) { blocked = "aggregate over a different base entity"; break; }
                var sub = AggregateSubquery(root, baseEntity, relName, aggFn, of);
                if (sub is null) { blocked = $"unresolved FK for @via \"{via}\" (target needs an identity.reference back to {baseEntity})"; break; }
                cols.Add($"  {sub} AS {Col(f)}");
            }
            else
            {
                blocked = origin is MetaCollectionOrigin ? "collection origin (nested array)" : "field has no resolvable origin";
                break;
            }
        }

        if (blocked is not null || baseEntity is null || cols.Count == 0)
        {
            warn($"meta migrate: view \"{view}\" not generated — {blocked ?? "no derivable columns"}.");
            return $"-- TODO CREATE VIEW {view}: {blocked ?? "no derivable columns"}\n";
        }

        var baseTable = root.FindObject(baseEntity)?.DbTable ?? baseEntity;
        return $"CREATE VIEW {view} AS\nSELECT\n{string.Join(",\n", cols)}\nFROM {baseTable};\n";
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

    // Build a correlated-subquery aggregate over a to-many relationship, resolving
    // the FK from an identity.reference on the target entity.
    private static string? AggregateSubquery(MetaRoot root, string baseEntity, string relName, string aggFn, string of)
    {
        var baseObj = root.FindObject(baseEntity);
        var rel = baseObj?.Relationships().FirstOrDefault(r => r.Name == relName);
        if (baseObj is null || rel?.ObjectRef is not { } objRef) return null;
        var targetEntity = StripPkg(objRef);
        var targetObj = root.FindObject(targetEntity);
        if (targetObj is null) return null;

        var fkRef = targetObj.ReferenceIdentities()
            .FirstOrDefault(r => r.TargetEntity is { } te && StripPkg(te) == baseEntity);
        if (fkRef is null || fkRef.Fields.Count == 0) return null;

        var fkCol = ResolveColumn(targetObj, fkRef.Fields[0]);
        var parentField = fkRef.TargetFields.Count > 0
            ? fkRef.TargetFields[0]
            : baseObj.PrimaryIdentity()?.Fields.FirstOrDefault();
        if (parentField is null) return null;
        var parentCol = ResolveColumn(baseObj, parentField);

        var ofCol = ResolveColumn(targetObj, SplitDot(of).Tail);
        var targetTable = targetObj.DbTable ?? targetEntity;
        var baseTable = baseObj.DbTable ?? baseEntity;

        return $"(SELECT {aggFn}({targetTable}.{ofCol}) FROM {targetTable} " +
               $"WHERE {targetTable}.{fkCol} = {baseTable}.{parentCol})";
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
