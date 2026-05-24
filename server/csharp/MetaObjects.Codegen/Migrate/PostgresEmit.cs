// PostgresEmit — renders a diff's Change list to up/down migration SQL for Postgres
// (in-place ALTER; no recreate-and-copy). Changes are staged so creates precede
// column edits precede renames precede index/FK ops precede drops; the down script
// runs in reverse.
//
// Ported from typescript/packages/migrate-ts/src/emit/postgres.ts. The SQLite
// recreate-and-copy path and its `recreatedTables` set are out of scope here.
//
// NOTE: this emitter's identifier conventions (quoted idents, UPPERCASE types,
// "{table}_pkey" PK constraint, raw index names) differ from the full-CREATE
// Schema/PostgresSchema. They must be reconciled before introspection-driven
// migration ships (see that file's header + the csharp-migration-pipeline-status
// memory) — ideally by routing full-CREATE through this pipeline too.

using System.Text;
using MetaObjects.Codegen.Schema;
using static MetaObjects.Persistence.Source.SourceConstants;

namespace MetaObjects.Codegen.Migrate;

/// <summary>Up + down migration SQL for a change list.</summary>
public sealed record EmitResult(string Up, string Down);

/// <summary>Renders changes to Postgres migration SQL.</summary>
public static class PostgresEmit
{
    public static EmitResult Render(IReadOnlyList<Change> changes)
    {
        // OrderBy is a stable sort, so insertion order is preserved within a stage.
        var sorted = changes.OrderBy(StageOf).ToList();
        var up = string.Join("\n\n", sorted.Select(RenderUp));
        var down = string.Join("\n\n", sorted.Select(RenderDown).Reverse());
        return new EmitResult(up, down);
    }

    private static int StageOf(Change c) => c switch
    {
        Change.CreateTable => 1,
        Change.AddColumn or Change.DropColumn or Change.ChangeColumnType
            or Change.ChangeColumnNullable or Change.ChangeColumnDefault => 2,
        Change.RenameColumn or Change.RenameTable => 3,
        Change.AddIndex or Change.DropIndex => 4,
        Change.AddFk or Change.DropFk => 5,
        Change.DropTable => 6,
        _ => 99,
    };

    private static string RenderUp(Change c) => c switch
    {
        Change.CreateTable x => RenderCreateTable(x.Table),
        Change.DropTable x => $"DROP TABLE {QualifiedTable(x.Table, x.Schema)};",
        Change.RenameTable x => $"ALTER TABLE {QualifiedTable(x.From, x.Schema)} RENAME TO {Quote(x.To)};",
        Change.AddColumn x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ADD COLUMN {RenderColumn(x.Column)};",
        Change.DropColumn x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} DROP COLUMN {Quote(x.Column)};",
        Change.RenameColumn x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} RENAME COLUMN {Quote(x.From)} TO {Quote(x.To)};",
        Change.ChangeColumnType x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} TYPE {PgType(x.To)};",
        Change.ChangeColumnNullable x => x.To
            ? $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} DROP NOT NULL;"
            : $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} SET NOT NULL;",
        Change.ChangeColumnDefault x => x.To is not null
            ? $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} SET DEFAULT {RenderDefault(x.To)};"
            : $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} DROP DEFAULT;",
        Change.AddIndex x => RenderCreateIndex(x.Table, x.Schema, x.Index),
        Change.DropIndex x => $"DROP INDEX {QualifiedIndex(x.Index, x.Schema)};",
        Change.AddFk x => RenderAddFk(x.Table, x.Schema, x.Fk),
        Change.DropFk x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} DROP CONSTRAINT {Quote(x.Fk)};",
        _ => throw new InvalidOperationException($"unhandled change kind: {c.GetType().Name}"),
    };

    private static string RenderDown(Change c) => c switch
    {
        Change.CreateTable x => $"DROP TABLE {QualifiedTable(x.Table.Name, x.Table.Schema)};",
        Change.DropTable x => $"-- WARNING: down migration cannot restore data\n-- TODO: restore table \"{x.Table}\" structure manually",
        Change.RenameTable x => $"ALTER TABLE {QualifiedTable(x.To, x.Schema)} RENAME TO {Quote(x.From)};",
        Change.AddColumn x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} DROP COLUMN {Quote(x.Column.Name)};",
        Change.DropColumn x => $"-- WARNING: down migration cannot restore data\n-- TODO: re-add dropped column \"{x.Column}\" manually with original type/nullable/default",
        Change.RenameColumn x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} RENAME COLUMN {Quote(x.To)} TO {Quote(x.From)};",
        Change.ChangeColumnType x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} TYPE {PgType(x.From)};",
        Change.ChangeColumnNullable x => x.From
            ? $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} DROP NOT NULL;"
            : $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} SET NOT NULL;",
        Change.ChangeColumnDefault x => x.From is not null
            ? $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} SET DEFAULT {RenderDefault(x.From)};"
            : $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} ALTER COLUMN {Quote(x.Column)} DROP DEFAULT;",
        Change.AddIndex x => $"DROP INDEX {QualifiedIndex(x.Index.Name, x.Schema)};",
        Change.DropIndex => "-- WARNING: down migration cannot restore the original index definition",
        Change.AddFk x => $"ALTER TABLE {QualifiedTable(x.Table, x.Schema)} DROP CONSTRAINT {Quote(x.Fk.Name)};",
        Change.DropFk => "-- WARNING: down migration cannot restore the original FK definition",
        _ => throw new InvalidOperationException($"unhandled change kind: {c.GetType().Name}"),
    };

    private static string RenderCreateTable(TableDescriptor t)
    {
        var lines = t.Columns.Select(c => "  " + RenderColumn(c)).ToList();
        if (t.PrimaryKey.Count > 0)
            lines.Add($"  CONSTRAINT {Quote(t.Name + "_pkey")} PRIMARY KEY ({string.Join(", ", t.PrimaryKey.Select(Quote))})");
        return $"CREATE TABLE {QualifiedTable(t.Name, t.Schema)} (\n{string.Join(",\n", lines)}\n);";
    }

    private static string RenderColumn(ColumnDescriptor c)
    {
        var s = $"{Quote(c.Name)} {PgType(c.SqlType)}";
        if (c.Identity == IdentityKind.Increment) s += " GENERATED BY DEFAULT AS IDENTITY";
        if (c.Identity == IdentityKind.Uuid) s += " DEFAULT gen_random_uuid()";
        if (!c.Nullable) s += " NOT NULL";
        // For uuid identity we already set DEFAULT gen_random_uuid(); don't duplicate.
        if (c.Default is not null && c.Identity != IdentityKind.Uuid)
            s += $" DEFAULT {RenderDefault(c.Default)}";
        return s;
    }

    private static string PgType(SqlType t) => t switch
    {
        SqlType.Text x => x.MaxLength is { } n ? $"VARCHAR({n})" : "TEXT",
        SqlType.Integer x => x.Bits == 64 ? "BIGINT" : "INTEGER",
        SqlType.Real => "DOUBLE PRECISION",
        SqlType.Numeric x => x switch
        {
            { Precision: { } p, Scale: { } s } => $"NUMERIC({p},{s})",
            { Precision: { } p } => $"NUMERIC({p})",
            _ => "NUMERIC",
        },
        SqlType.Boolean => "BOOLEAN",
        SqlType.Timestamp x => x.WithTimezone ? "TIMESTAMPTZ" : "TIMESTAMP",
        SqlType.Date => "DATE",
        SqlType.Json => "JSONB",
        SqlType.Blob => "BYTEA",
        SqlType.Uuid => "UUID",
        _ => throw new InvalidOperationException($"unhandled SqlType: {t.GetType().Name}"),
    };

    private static string RenderDefault(ColumnDefault d) =>
        d.Kind == DefaultKind.Expr ? d.Value : $"'{PgSql.Escape(d.Value)}'";

    private static string RenderCreateIndex(string table, string? schema, IndexDescriptor ix)
    {
        var u = ix.Unique ? "UNIQUE " : "";
        // The index name is unqualified in CREATE INDEX (Postgres places it in the
        // table's schema); only the ON clause needs qualification.
        return $"CREATE {u}INDEX {Quote(ix.Name)} ON {QualifiedTable(table, schema)} ({string.Join(", ", ix.Columns.Select(Quote))});";
    }

    private static string RenderAddFk(string table, string? schema, FkDescriptor fk)
    {
        var s = new StringBuilder();
        s.Append($"ALTER TABLE {QualifiedTable(table, schema)} ADD CONSTRAINT {Quote(fk.Name)} ");
        s.Append($"FOREIGN KEY ({string.Join(", ", fk.Columns.Select(Quote))}) ");
        // The ref table is assumed to live in the FK-owner's schema (no cross-schema FK yet).
        s.Append($"REFERENCES {QualifiedTable(fk.RefTable, schema)} ({string.Join(", ", fk.RefColumns.Select(Quote))})");
        if (fk.OnDelete is { } d) s.Append($" ON DELETE {FkActionSql(d)}");
        if (fk.OnUpdate is { } u) s.Append($" ON UPDATE {FkActionSql(u)}");
        return s.Append(';').ToString();
    }

    private static string FkActionSql(FkAction a) => a switch
    {
        FkAction.Cascade => "CASCADE",
        FkAction.SetNull => "SET NULL",
        FkAction.Restrict => "RESTRICT",
        FkAction.NoAction => "NO ACTION",
        _ => throw new InvalidOperationException($"unhandled FkAction: {a}"),
    };

    private static string Quote(string ident)
    {
        if (ident.Contains('"')) throw new InvalidOperationException($"unsafe identifier: {ident}");
        return $"\"{ident}\"";
    }

    // Quote a table identifier, prefixing the schema only when non-default ("public"/null).
    private static string QualifiedTable(string table, string? schema) =>
        string.IsNullOrEmpty(schema) || schema == DEFAULT_DB_SCHEMA_POSTGRES
            ? Quote(table)
            : $"{Quote(schema)}.{Quote(table)}";

    private static string QualifiedIndex(string index, string? schema) =>
        string.IsNullOrEmpty(schema) || schema == DEFAULT_DB_SCHEMA_POSTGRES
            ? Quote(index)
            : $"{Quote(schema)}.{Quote(index)}";
}
