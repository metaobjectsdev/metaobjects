// DB-domain attribute schemas — registered by DbMetaDataProvider (DbProvider.cs),
// NOT the core metamodel. Mirrors typescript/packages/metadata/src/persistence/db/db-schema.ts
// and Java's CoreDBMetaDataProvider field-attr declarations.

using MetaObjects.Core.Attr;

namespace MetaObjects.Persistence.Db;

/// <summary>
/// DB-domain field-attribute schemas. Registered onto every field subtype by
/// <see cref="DbMetaDataProvider"/> via <see cref="TypeRegistry.Extend"/> — a
/// domain concern, not a core field property.
/// </summary>
public static class DbSchema
{
    /// <summary><c>@column</c> — physical column-name override on every field subtype (source.rdb).</summary>
    public static readonly AttrSchema ColumnSchema = new AttrSchema(
        Name: DbConstants.FIELD_ATTR_COLUMN,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Physical column name for this field on an rdb source. Defaults to the field name under the project's naming.columns rule (the \"naming\" setting in .metaobjects/config.json).");

    /// <summary><c>@db.indexed</c> — suppress the @filterable-without-index warning; on every field subtype.</summary>
    public static readonly AttrSchema DbIndexedSchema = new AttrSchema(
        Name: DbConstants.FIELD_ATTR_DB_INDEXED,
        ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
        Required: false,
        Description: "When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means).");

    /// <summary>
    /// R6 Plan 2b: <c>@dbColumnType</c> — physical DB column-type override on every field
    /// subtype. The closed value set (ADR-0036 Wave 1) is <see cref="DbConstants.VALID_DB_COLUMN_TYPES"/>
    /// — surfaced as the manifest's <c>allowedValues</c>; the subtype × value pairing is
    /// validated own-only by the loader (ValidateDbColumnType → ERR_BAD_ATTR_VALUE).
    /// </summary>
    public static readonly AttrSchema DbColumnTypeSchema = new AttrSchema(
        Name: DbConstants.FIELD_ATTR_DB_COLUMN_TYPE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        AllowedValues: [.. DbConstants.VALID_DB_COLUMN_TYPES],
        Description:
            "Physical DB column-type override (ADR-0013 escape hatch). Legal values are uuid | jsonb, " +
            "both on field.string (uuid = native Postgres uuid column over a string-typed field; " +
            "jsonb = genuinely-open JSON column). The logical field type and its native binding are " +
            "unchanged. Native SQL arrays (uuid[]/text[]) are NOT declared here — they are derived from " +
            "a field subtype + isArray (ADR-0036 Wave 1). The retired timestamp_with_tz value is gone — " +
            "timezone-awareness lives in field.timestamp (instant by default) + @localTime (the naive " +
            "opt-out), per ADR-0036 Wave 2.");

    /// <summary>
    /// ADR-0036 Wave 2: <c>@localTime</c> — the naive-timestamp opt-out on <c>field.timestamp</c>
    /// (boolean, no allowedValues). Registered ONLY on field.timestamp by <see cref="DbMetaDataProvider"/>.
    /// </summary>
    public static readonly AttrSchema LocalTimeSchema = new AttrSchema(
        Name: DbConstants.FIELD_ATTR_LOCAL_TIME,
        ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
        Required: false,
        Description:
            "When true, the timestamp is a naive wall-clock value with no timezone (Postgres " +
            "`timestamp without time zone`); absent/false (the default) = an absolute instant " +
            "(`timestamptz`). ADR-0036 Wave 2 — replaces the retired @dbColumnType: timestamp_with_tz " +
            "escape hatch.");

    /// <summary>
    /// <c>@flattenedColumnPrefix</c> — the text before each member's column of a <c>field.object @storage
    /// "flattened"</c> (string, <c>""</c> allowed). Registered ONLY on field.object by
    /// <see cref="DbMetaDataProvider"/>.
    /// </summary>
    public static readonly AttrSchema FlattenedColumnPrefixSchema = new AttrSchema(
        Name: DbConstants.FIELD_ATTR_FLATTENED_COLUMN_PREFIX,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "On a field.object with @storage \"flattened\": the text put before each member's column, verbatim (\"\" allowed, so the members keep their own column names). Absent: this field's resolved column name and \"_\" (with @column \"bill\", the members are bill_<member column>). A fact about the owning table, so it lives on the embedding field, never on the value object. Refused on any other storage (ERR_FLATTENED_COLUMN_PREFIX_WITHOUT_FLATTENED_STORAGE).");

    // --- Physical RDB index/constraint attrs the db provider adds to identity.* ---

    /// <summary><c>@orders</c> — per-key index sort direction (asc|desc), positional to @fields; on identity.secondary.</summary>
    public static readonly AttrSchema OrdersSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_ORDERS,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        AllowedValues: ["asc", "desc"],
        Description: "Physical index-key sort direction, positional to @fields ('asc' | 'desc'). Omit for all-ascending (the default); a shorter array leaves trailing keys ascending. Drives DESC-ordered index keys (e.g. a recency index on a timestamp). RDB-physical — contributed by the db provider, not core identity.",
        IsArray: true);

    /// <summary><c>@where</c> — partial-index predicate (raw SQL); on identity.secondary.</summary>
    public static readonly AttrSchema WhereSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_WHERE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Partial-index predicate (raw SQL, e.g. \"delivered_at IS NULL\"). When set, the index covers only rows matching the predicate — smaller and cheaper for queries that always filter on it. Absent = a full index over every row. RDB-physical — contributed by the db provider.");

    /// <summary><c>@expr</c> — raw key expression for a functional/expression index; on identity.secondary.</summary>
    public static readonly AttrSchema ExprSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_EXPR,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Raw key EXPRESSION for a functional/expression index (e.g. \"lower(email)\"). Used INSTEAD of @fields — the index key is the expression rather than plain columns. RDB-physical — contributed by the db provider.");

    /// <summary><c>@using</c> — index access method (e.g. "gin"); default "btree"; on identity.secondary.</summary>
    public static readonly AttrSchema UsingSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_USING,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Index access method (e.g. \"gin\", \"gist\", \"hash\"); default \"btree\" (not rendered). Pair with @expr for e.g. a GIN index over an array/jsonb expression. RDB-physical — contributed by the db provider.");

    /// <summary><c>@constraintName</c> on a validator — the database name of the CHECK it generates.</summary>
    public static readonly AttrSchema ValidatorConstraintNameSchema = new AttrSchema(
        Name: Core.Validator.ValidatorConstants.VALIDATOR_ATTR_CONSTRAINT_NAME,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "The database name of the CHECK constraint this validator generates (numeric, length, regex and the cross-field validators; the others generate no CHECK). Absent: the derived <table>_<column>_<kind>_chk. Lets a model adopt a database whose CHECKs were named by hand. RDB-physical — contributed by the db provider.");

    /// <summary><c>@dbCheck</c> on a validator — <c>false</c> generates no database CHECK for it.</summary>
    public static readonly AttrSchema ValidatorDbCheckSchema = new AttrSchema(
        Name: Core.Validator.ValidatorConstants.VALIDATOR_ATTR_DB_CHECK,
        ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
        Required: false,
        Description: "false: this validator generates no database CHECK (meta migrate and a generated EF model leave it out). A numeric, length or regex validator is still enforced on every write by the generated app-level validators; a cross-field validator (comparison, requiredWhen, presentIff, atLeastOne) is enforced only by its CHECK, so on one of those false leaves the rule enforced nowhere. Absent: true. For a column whose legacy rows break the rule, which a CHECK would refuse on their next UPDATE even NOT VALID. Refused with @constraintName (ERR_CONSTRAINT_NAME_WITHOUT_CHECK). RDB-physical — contributed by the db provider.");

    /// <summary><c>@dbCheck</c> on a field.enum — <c>false</c> generates no membership CHECK.</summary>
    public static readonly AttrSchema EnumDbCheckSchema = new AttrSchema(
        Name: Core.Validator.ValidatorConstants.VALIDATOR_ATTR_DB_CHECK,
        ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
        Required: false,
        Description: "false: this enum's member list generates no database CHECK (meta migrate and a generated EF model leave it out); the generated app-level validation still holds every write to the members. Absent: true. For a column whose legacy rows hold values outside the members, which a CHECK would refuse on their next UPDATE even NOT VALID. Refused with @constraintName (ERR_CONSTRAINT_NAME_WITHOUT_CHECK). RDB-physical — contributed by the db provider.");

    /// <summary><c>@constraintName</c> on a field.enum — the database name of its membership CHECK.</summary>
    public static readonly AttrSchema EnumConstraintNameSchema = new AttrSchema(
        Name: Core.Validator.ValidatorConstants.VALIDATOR_ATTR_CONSTRAINT_NAME,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "The database name of the CHECK constraint this enum's member list generates. Absent: <table>_<column>_chk. Lets a model adopt a database whose CHECKs were named by hand. RDB-physical — contributed by the db provider.");

    /// <summary><c>@sequenceStart</c> — the first value of an increment key's sequence; on identity.primary.</summary>
    public static readonly AttrSchema SequenceStartSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_SEQUENCE_START,
        ValueType: AttrConstants.ATTR_SUBTYPE_LONG,
        Required: false,
        Description: "The first value an @generation \"increment\" key's sequence hands out (Postgres: GENERATED BY DEFAULT AS IDENTITY (START WITH n)). Absent: 1. Lets a model reproduce a table that keeps a low id range for seeded rows. Refused without @generation \"increment\" (ERR_SEQUENCE_WITHOUT_INCREMENT). RDB-physical — contributed by the db provider.");

    /// <summary><c>@sequenceName</c> — the physical name of an increment key's sequence; on identity.primary.</summary>
    public static readonly AttrSchema SequenceNameSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_SEQUENCE_NAME,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "The physical name of an @generation \"increment\" key's sequence (Postgres: GENERATED BY DEFAULT AS IDENTITY (SEQUENCE NAME ...)). Absent: the database's own default, <table>_<column>_seq on Postgres. Lets a model adopt a sequence that kept its name across a table rename. Refused without @generation \"increment\" (ERR_SEQUENCE_WITHOUT_INCREMENT). RDB-physical — contributed by the db provider.");

    /// <summary><c>@constraintName</c> — physical FK constraint-name override; on identity.reference.</summary>
    public static readonly AttrSchema ConstraintNameSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_CONSTRAINT_NAME,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Physical foreign-key constraint name override. Absent → the backend's auto-derived default (e.g. `<table>_<firstFkColumn>_fk`). Lets a model adopt an existing database whose FK constraints follow a different naming convention without a destructive rename. RDB-physical — contributed by the db provider.");

    /// <summary><c>@onDelete</c> — referential action on parent delete, the explicit per-FK override; on identity.reference (ADR-0047).</summary>
    public static readonly AttrSchema ReferenceOnDeleteSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_ON_DELETE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        AllowedValues: ["cascade", "set-null", "restrict", "no-action"],
        Description: "Referential action on parent delete, declared directly on the FK-defining reference — the explicit per-FK override (ADR-0047). Precedence: this attr → a correlated relationship's @onDelete (declared on either side of the FK) → the relationship's subtype default. Use for a reference-only FK (no relationship), an M:N junction's FK sides, or a per-FK override; prefer declaring the action on the relationship otherwise. RDB-physical — contributed by the db provider.");

    /// <summary><c>@onUpdate</c> — referential action on key update, the explicit per-FK override; on identity.reference (ADR-0047).</summary>
    public static readonly AttrSchema ReferenceOnUpdateSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_ON_UPDATE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        AllowedValues: ["cascade", "set-null", "restrict", "no-action"],
        Description: "Referential action on key update, declared directly on the FK-defining reference — the explicit per-FK override (ADR-0047). Same precedence as @onDelete; when only a correlated relationship is present, @onUpdate defaults to cascade. RDB-physical — contributed by the db provider.");
}
