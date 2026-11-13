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
    /// <summary><c>@flattenedColumnPrefix</c> on a <c>field.object @storage "flattened"</c>: the text before
    /// each member's column, verbatim (<c>""</c> allowed). Absent: the field's resolved column and
    /// <c>_</c> (<see cref="MetaObjects.Meta.PhysicalNaming.ResolveFlattenedColumnPrefix(MetaObjects.Core.Field.MetaField)"/>).</summary>
    public const string FIELD_ATTR_FLATTENED_COLUMN_PREFIX = "flattenedColumnPrefix";
    /// <summary>When true, suppress the @filterable-without-index Loader warning (Project D drift check).</summary>
    public const string FIELD_ATTR_DB_INDEXED = "db.indexed";

    /// <summary>
    /// ADR-0036 Wave 2 — the naive-timestamp opt-out on <c>field.timestamp</c> (<c>@localTime</c>,
    /// boolean). When true, the timestamp is a naive wall-clock value (<c>timestamp without time
    /// zone</c> + CLR <c>DateTime</c>); absent/false (the default) = an absolute instant
    /// (<c>timestamptz</c> + CLR <c>DateTimeOffset</c>). Replaces the retired
    /// <c>@dbColumnType: timestamp_with_tz</c> escape hatch.
    /// </summary>
    public const string FIELD_ATTR_LOCAL_TIME = "localTime";

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
    /// <summary>identity.primary (@generation "increment"): the sequence's first value. Absent → 1.</summary>
    public const string IDENTITY_ATTR_SEQUENCE_START   = "sequenceStart";
    /// <summary>identity.primary (@generation "increment"): the sequence's physical name. Absent → the database's default.</summary>
    public const string IDENTITY_ATTR_SEQUENCE_NAME    = "sequenceName";
    /// <summary>identity.reference: referential action on parent delete — the explicit per-FK override (ADR-0047).</summary>
    public const string IDENTITY_ATTR_ON_DELETE        = "onDelete";
    /// <summary>identity.reference: referential action on key update — the explicit per-FK override (ADR-0047).</summary>
    public const string IDENTITY_ATTR_ON_UPDATE        = "onUpdate";

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
    /// set: <see cref="DB_COLUMN_TYPE_UUID"/> / <see cref="DB_COLUMN_TYPE_JSONB"/>.
    /// Array-ness is derived from <c>isArray: true</c> on the field, not from a separate
    /// <c>uuid_array</c>/<c>text_array</c> value (removed in Phase 1 of the slim-and-derive pass).
    /// The retired <c>timestamp_with_tz</c> value is gone — timezone-awareness lives in
    /// field.timestamp (instant by default) + <c>@localTime</c> per ADR-0036 Wave 2.
    /// </summary>
    public const string FIELD_ATTR_DB_COLUMN_TYPE = "dbColumnType";

    /// <summary><c>@dbColumnType: uuid</c> — native Postgres <c>uuid</c> column (legal on field.string).</summary>
    public const string DB_COLUMN_TYPE_UUID         = "uuid";
    /// <summary><c>@dbColumnType: jsonb</c> — genuinely-open JSON column (legal on field.string).</summary>
    public const string DB_COLUMN_TYPE_JSONB        = "jsonb";

    /// <summary>rc.21 part B (U2): the text column spellings <c>@dbColumnType</c> takes on a field.string.</summary>
    public const string DB_COLUMN_TYPE_TEXT              = "text";
    public const string DB_COLUMN_TYPE_VARCHAR           = "varchar";
    public const string DB_COLUMN_TYPE_CHARACTER_VARYING = "character varying";

    /// <summary>The closed set of legal bare <c>@dbColumnType</c> values; the sized spellings
    /// <c>varchar(n)</c>, <c>character varying(n)</c> and <c>character(n)</c> are parsed by <see cref="ParseDbColumnType"/>.</summary>
    public static readonly IReadOnlyList<string> VALID_DB_COLUMN_TYPES = new[]
    {
        DB_COLUMN_TYPE_UUID,
        DB_COLUMN_TYPE_JSONB,
        DB_COLUMN_TYPE_TEXT,
        DB_COLUMN_TYPE_VARCHAR,
        DB_COLUMN_TYPE_CHARACTER_VARYING,
    };

    /// <summary>The sized spellings, as written in a message.</summary>
    public static readonly IReadOnlyList<string> DB_COLUMN_TYPE_SIZED_SPELLINGS = new[]
    {
        "varchar(n)", "character varying(n)", "character(n)",
    };

    /// <summary>A parsed <c>@dbColumnType</c>: <c>uuid</c>, <c>jsonb</c>, <c>text</c>, <c>varchar</c> or <c>char</c>, and a sized spelling's length.</summary>
    public sealed record ParsedDbColumnType(string Kind, int? Length);

    private static readonly System.Text.RegularExpressions.Regex SizedDbColumnType =
        new(@"^(varchar|character varying|character)\(([1-9][0-9]{0,8})\)$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// rc.21 part B (U2): parse a <c>@dbColumnType</c> value, or null for one that is not legal.
    /// Postgres's own spellings, matched exactly, as every port parses them (TS <c>parseDbColumnType</c>).
    /// </summary>
    public static ParsedDbColumnType? ParseDbColumnType(string value)
    {
        switch (value)
        {
            case DB_COLUMN_TYPE_UUID: return new("uuid", null);
            case DB_COLUMN_TYPE_JSONB: return new("jsonb", null);
            case DB_COLUMN_TYPE_TEXT: return new("text", null);
            case DB_COLUMN_TYPE_VARCHAR or DB_COLUMN_TYPE_CHARACTER_VARYING: return new("varchar", null);
        }
        var m = SizedDbColumnType.Match(value);
        if (!m.Success) return null;
        var n = int.Parse(m.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
        return m.Groups[1].Value == "character" ? new("char", n) : new("varchar", n);
    }
}
