// DB concern constants — physical DB column attr keys.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/persistence/db/db-constants.ts.
//
// NOTE: these attrs are DB-domain. In TS they are registered onto fields by a
// separate dbProvider; the C# loader+conformance milestone composes the core
// provider only (no fixture exercises a db provider), so these constants are
// consumed today by the loader's drift checks (@db.indexed) and downstream
// tooling, not by an attr schema. Kept here as the cross-language home.

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
