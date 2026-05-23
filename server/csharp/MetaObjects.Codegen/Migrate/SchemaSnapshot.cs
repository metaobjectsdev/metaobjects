// Snapshot descriptors — the same shape for the expected schema (built from
// metadata) and the actual schema (from DB introspection). diff() compares two
// SchemaSnapshots symmetrically; emit() re-renders the resulting changes to SQL.
//
// Ported from typescript/packages/migrate-ts/src/types.ts. Closed value sets that
// TS models as string-literal unions (identity / default-kind / fk-action) are C#
// enums here — these are internal migration-model values, not metamodel wire strings.

namespace MetaObjects.Codegen.Migrate;

/// <summary>PK generation strategy that maps to a DB-side identity/default.</summary>
public enum IdentityKind { Increment, Uuid }

/// <summary>Whether a column default is a quoted literal or a raw SQL expression.</summary>
public enum DefaultKind { Literal, Expr }

/// <summary>Referential action for a foreign key.</summary>
public enum FkAction { Cascade, SetNull, Restrict, NoAction }

/// <summary>A full schema snapshot (tables only in this tier; views are deferred).</summary>
public sealed record SchemaSnapshot(IReadOnlyList<TableDescriptor> Tables);

/// <summary>
/// One table. <see cref="Schema"/> is the DB schema; null is normalized to the
/// Postgres default ("public") by diff/emit, so an expected snapshot (often null)
/// compares equal to an introspected one (always populated).
/// </summary>
public sealed record TableDescriptor(
    string Name,
    IReadOnlyList<ColumnDescriptor> Columns,
    IReadOnlyList<IndexDescriptor> Indexes,
    IReadOnlyList<FkDescriptor> ForeignKeys,
    IReadOnlyList<string> PrimaryKey,
    string? Schema = null);

/// <summary>One column. <see cref="Identity"/> null means a plain (non-generated) column.</summary>
public sealed record ColumnDescriptor(
    string Name,
    SqlType SqlType,
    bool Nullable,
    ColumnDefault? Default = null,
    IdentityKind? Identity = null);

/// <summary>A column default — a quoted literal or a raw SQL expression.</summary>
public sealed record ColumnDefault(DefaultKind Kind, string Value);

/// <summary>A (unique or non-unique) index over one or more columns.</summary>
public sealed record IndexDescriptor(string Name, IReadOnlyList<string> Columns, bool Unique);

/// <summary>A foreign-key constraint. Referential actions are optional.</summary>
public sealed record FkDescriptor(
    string Name,
    IReadOnlyList<string> Columns,
    string RefTable,
    IReadOnlyList<string> RefColumns,
    FkAction? OnDelete = null,
    FkAction? OnUpdate = null);
