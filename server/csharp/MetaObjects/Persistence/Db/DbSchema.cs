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
        Description: "Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy.");

    /// <summary><c>@db.indexed</c> — suppress the @filterable-without-index warning; on every field subtype.</summary>
    public static readonly AttrSchema DbIndexedSchema = new AttrSchema(
        Name: DbConstants.FIELD_ATTR_DB_INDEXED,
        ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
        Required: false,
        Description: "When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means).");

    /// <summary>
    /// R6 Plan 2b: <c>@dbColumnType</c> — physical DB column-type override on every field
    /// subtype. The legal value depends on the field's logical subtype, so the subtype × value
    /// pairing is validated own-only by the loader (ValidateDbColumnType → ERR_BAD_ATTR_VALUE),
    /// not by a flat AllowedValues set. The string ValueType keeps the schema's type check intact.
    /// </summary>
    public static readonly AttrSchema DbColumnTypeSchema = new AttrSchema(
        Name: DbConstants.FIELD_ATTR_DB_COLUMN_TYPE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description:
            "Physical DB column-type override (ADR-0013 escape hatch). Legal values are " +
            string.Join(" | ", DbConstants.VALID_DB_COLUMN_TYPES) + ", each legal only on a specific " +
            "logical field subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). " +
            "The logical field type and its native binding are unchanged.");

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

    /// <summary><c>@constraintName</c> — physical FK constraint-name override; on identity.reference.</summary>
    public static readonly AttrSchema ConstraintNameSchema = new AttrSchema(
        Name: DbConstants.IDENTITY_ATTR_CONSTRAINT_NAME,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Physical foreign-key constraint name override. Absent → the backend's auto-derived default (e.g. `<table>_<firstFkColumn>_fk`). Lets a model adopt an existing database whose FK constraints follow a different naming convention without a destructive rename. RDB-physical — contributed by the db provider.");
}
