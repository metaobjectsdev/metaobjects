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

    /// <summary>CREATE VIEW for a projection; best-effort SELECT from passthrough origins.</summary>
    public static string CreateView(MetaObject projection, MetaRoot root, Action<string> warn)
    {
        var view = projection.DbView!;
        var cols = new List<string>();
        string? baseEntity = null;
        bool complex = false;

        foreach (var f in projection.Fields().Where(f => CSharpNaming.ScalarFor(f.SubType) is not null))
        {
            var origin = f.OwnChildren().FirstOrDefault(c => c.Type == TYPE_ORIGIN);
            if (origin is MetaPassthroughOrigin pt && pt.Via is null && pt.From is { } from && from.Contains('.'))
            {
                var dot = from.IndexOf('.');
                var ent = from[..dot];
                var srcCol = from[(dot + 1)..];
                baseEntity ??= ent;
                if (ent != baseEntity) { complex = true; break; }
                cols.Add($"  {srcCol} AS {Col(f)}");
            }
            else
            {
                complex = true; // aggregate / @via / collection / no origin -> needs join/agg SQL
                break;
            }
        }

        if (complex || baseEntity is null || cols.Count == 0)
        {
            warn($"meta migrate: view \"{view}\" needs aggregate/relationship-path SQL — emitted as TODO.");
            return $"-- TODO CREATE VIEW {view}: derive SELECT from aggregate/@via/collection origins\n" +
                   $"--      (passthrough-from-single-base views are generated; this projection needs join/aggregate SQL).\n";
        }

        var baseTable = root.FindObject(baseEntity)?.DbTable ?? baseEntity;
        return $"CREATE VIEW {view} AS\nSELECT\n{string.Join(",\n", cols)}\nFROM {baseTable};\n";
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
