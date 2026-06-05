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
}
