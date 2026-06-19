// DB concern constants — physical DB column attr keys.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/db/db-constants.ts.
//
// NOTE: these attrs are DB-domain. As in TS (dbProvider) and Java (CoreDBMetaDataProvider),
// they are registered onto every field subtype by DbMetaDataProvider (DbProvider.cs) via
// TypeRegistry.Extend — NOT on core field schema. The default loader registry composes that
// provider; the schemas themselves live in DbSchema.cs. These constants remain the
// cross-language home for the attr keys + the @dbColumnType value set.

using System.Collections.Generic;

namespace MetaObjects.Persistence.Db;

/// <summary>DB-domain physical-column attr keys on fields.</summary>
public static class DbConstants
{
    /// <summary>Custom DB column name override on a field (source-v2 attr <c>@column</c>).</summary>
    public const string FIELD_ATTR_COLUMN     = "column";
    /// <summary>When true, suppress the @filterable-without-index Loader warning (Project D drift check).</summary>
    public const string FIELD_ATTR_DB_INDEXED = "db.indexed";

    // -----------------------------------------------------------------------
    // Physical RDB index/constraint attrs the db provider adds to identity.*
    // (TypeRegistry.Extend on identity subtypes) — pure physical-storage
    // concerns, NOT core identity. Mirror the TS db.json identity extends.
    // -----------------------------------------------------------------------

    /// <summary>identity.secondary: per-field index-key sort direction array ('asc' | 'desc'), positional to @fields.</summary>
    public const string IDENTITY_ATTR_ORDERS           = "orders";
    /// <summary>identity.secondary: partial-index predicate (raw SQL). When set, the index covers only matching rows.</summary>
    public const string IDENTITY_ATTR_WHERE            = "where";
    /// <summary>identity.secondary: raw key EXPRESSION for a functional/expression index (used instead of @fields).</summary>
    public const string IDENTITY_ATTR_EXPR             = "expr";
    /// <summary>identity.secondary: index access method (e.g. "gin"); default "btree".</summary>
    public const string IDENTITY_ATTR_USING            = "using";
    /// <summary>identity.reference: physical FK constraint-name override. Absent =&gt; the auto-derived default.</summary>
    public const string IDENTITY_ATTR_CONSTRAINT_NAME  = "constraintName";

    // -----------------------------------------------------------------------
    // R6 Plan 2b — @dbColumnType physical column-type attribute (ADR-0013).
    //
    // The canonical *physical* escape hatch: selects the DB column type while
    // leaving the logical field subtype and its idiomatic native binding
    // (ADR-0001) untouched. A closed, validated, introspection-round-trippable
    // value set — no raw dialect passthrough (deferred). Own-only pairing
    // validation lives in ValidationPasses.ValidateDbColumnType.
    // -----------------------------------------------------------------------

    /// <summary>
    /// Physical DB column-type override on a field (<c>@dbColumnType</c>). Closed value
    /// set: <see cref="DB_COLUMN_TYPE_UUID"/> / <see cref="DB_COLUMN_TYPE_JSONB"/> /
    /// <see cref="DB_COLUMN_TYPE_TIMESTAMP_TZ"/>.
    /// </summary>
    public const string FIELD_ATTR_DB_COLUMN_TYPE = "dbColumnType";

    /// <summary><c>@dbColumnType: uuid</c> — native Postgres <c>uuid</c> column (legal on field.string).</summary>
    public const string DB_COLUMN_TYPE_UUID         = "uuid";
    /// <summary><c>@dbColumnType: jsonb</c> — genuinely-open JSON column (legal on field.string).</summary>
    public const string DB_COLUMN_TYPE_JSONB        = "jsonb";
    /// <summary><c>@dbColumnType: timestamp_with_tz</c> — <c>timestamp with time zone</c> column (legal on field.timestamp).</summary>
    public const string DB_COLUMN_TYPE_TIMESTAMP_TZ = "timestamp_with_tz";

    /// <summary>The closed set of legal <c>@dbColumnType</c> values.</summary>
    public static readonly IReadOnlyList<string> VALID_DB_COLUMN_TYPES = new[]
    {
        DB_COLUMN_TYPE_UUID,
        DB_COLUMN_TYPE_JSONB,
        DB_COLUMN_TYPE_TIMESTAMP_TZ,
    };
}
