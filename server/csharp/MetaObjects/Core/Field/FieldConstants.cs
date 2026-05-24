// Field concern constants — the field subtypes, the field-level attr keys,
// AUTO_SET semantics, and currency attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/field/field-constants.ts.
// (DB-physical attrs @dbColumn / @db.indexed live in Persistence/Db/DbConstants.cs.)

using MetaObjects.Shared;

namespace MetaObjects.Core.Field;

/// <summary>
/// Field concern constants — the 16 field subtypes (plus the universal base),
/// the field-level attr keys, AUTO_SET semantics, and currency attrs.
/// </summary>
public static class FieldConstants
{
    // -----------------------------------------------------------------------
    // Field subtypes (16)
    // -----------------------------------------------------------------------

    public const string FIELD_SUBTYPE_STRING    = "string";
    public const string FIELD_SUBTYPE_INT       = "int";
    public const string FIELD_SUBTYPE_SHORT     = "short";
    public const string FIELD_SUBTYPE_BYTE      = "byte";
    public const string FIELD_SUBTYPE_LONG      = "long";
    public const string FIELD_SUBTYPE_DOUBLE    = "double";
    public const string FIELD_SUBTYPE_FLOAT     = "float";
    public const string FIELD_SUBTYPE_DECIMAL   = "decimal";
    public const string FIELD_SUBTYPE_BOOLEAN   = "boolean";
    public const string FIELD_SUBTYPE_DATE      = "date";
    public const string FIELD_SUBTYPE_TIME      = "time";
    public const string FIELD_SUBTYPE_TIMESTAMP = "timestamp";
    public const string FIELD_SUBTYPE_OBJECT    = "object";
    public const string FIELD_SUBTYPE_CLASS     = "class";
    public const string FIELD_SUBTYPE_CURRENCY  = "currency";
    public const string FIELD_SUBTYPE_ENUM      = "enum";

    public static readonly string[] FIELD_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        FIELD_SUBTYPE_STRING,
        FIELD_SUBTYPE_INT,
        FIELD_SUBTYPE_SHORT,
        FIELD_SUBTYPE_BYTE,
        FIELD_SUBTYPE_LONG,
        FIELD_SUBTYPE_DOUBLE,
        FIELD_SUBTYPE_FLOAT,
        FIELD_SUBTYPE_DECIMAL,
        FIELD_SUBTYPE_BOOLEAN,
        FIELD_SUBTYPE_DATE,
        FIELD_SUBTYPE_TIME,
        FIELD_SUBTYPE_TIMESTAMP,
        FIELD_SUBTYPE_OBJECT,
        FIELD_SUBTYPE_CLASS,
        FIELD_SUBTYPE_CURRENCY,
        FIELD_SUBTYPE_ENUM,
    ];

    // -----------------------------------------------------------------------
    // Field-level attrs (used by codegen-ts column mapper + Project D filter/sort)
    // -----------------------------------------------------------------------

    public const string FIELD_ATTR_REQUIRED              = "required";
    public const string FIELD_ATTR_UNIQUE                = "unique";
    public const string FIELD_ATTR_DEFAULT               = "default";
    public const string FIELD_ATTR_MAX_LENGTH            = "maxLength";
    public const string FIELD_ATTR_PRECISION             = "precision";
    public const string FIELD_ATTR_SCALE                 = "scale";
    public const string FIELD_ATTR_FILTERABLE            = "filterable";
    public const string FIELD_ATTR_SORTABLE              = "sortable";
    public const string FIELD_ATTR_SORTABLE_DEFAULT_ORDER = "sortableDefaultOrder";
    /// <summary>Auto-set semantics on a timestamp field. Values: "onCreate" | "onUpdate".</summary>
    public const string FIELD_ATTR_AUTO_SET              = "autoSet";
    /// <summary>
    /// Name (or FQN) of the target object an object-typed field nests. Same wire
    /// spelling as the relationship <c>@objectRef</c> — Java's single ATTR_OBJECT_REF.
    /// </summary>
    public const string FIELD_ATTR_OBJECT_REF            = "objectRef";

    /// <summary>
    /// Storage strategy for an object-typed field. Meaningful only when @objectRef is set.
    /// Cross-language metamodel attr — every port must accept and round-trip it.
    /// </summary>
    public const string FIELD_ATTR_STORAGE = "storage";

    /// <summary>
    /// @storage "flattened" — nested object's columns expand into the parent table,
    /// each prefixed by the parent field's DB name (EF OwnsOne pattern). Requires
    /// the parent field.object to have isArray=false; arrays-of-values must use jsonb.
    /// </summary>
    public const string STORAGE_FLATTENED = "flattened";

    /// <summary>
    /// @storage "jsonb" — the nested value (or array of values when isArray=true) lives
    /// in a single jsonb column. The structure is typed by metadata; storage is opaque.
    /// </summary>
    public const string STORAGE_JSONB = "jsonb";

    /// <summary>
    /// @storage "subdocument" — document-store-native nested document. No Postgres
    /// column is emitted for this; codegen targets like Mongo render it inline.
    /// </summary>
    public const string STORAGE_SUBDOCUMENT = "subdocument";

    public static readonly string[] STORAGE_VALUES =
    [
        STORAGE_FLATTENED,
        STORAGE_JSONB,
        STORAGE_SUBDOCUMENT,
    ];

    public const string AUTO_SET_ON_CREATE = "onCreate";
    public const string AUTO_SET_ON_UPDATE = "onUpdate";

    public static readonly string[] AUTO_SET_VALUES = [AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE];

    // -----------------------------------------------------------------------
    // Enum attrs (on enum-subtype fields)
    // -----------------------------------------------------------------------

    /// <summary>
    /// Member symbols of an enum-subtype field. Required; each must match
    /// <see cref="ENUM_MEMBER_PATTERN"/>; no duplicates.
    /// </summary>
    public const string FIELD_ATTR_VALUES = "values";

    /// <summary>
    /// Regex pattern each enum member symbol must satisfy: must start with
    /// a letter or underscore, followed by letters, digits, or underscores.
    /// Keeps symbol == stored value with no name/value divergence.
    /// Mirrors TS ENUM_MEMBER_PATTERN.
    /// </summary>
    public const string ENUM_MEMBER_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";

    // -----------------------------------------------------------------------
    // Currency attrs (on currency-subtype fields)
    // -----------------------------------------------------------------------

    /// <summary>ISO 4217 currency code on a currency-subtype field. Defaults to "USD" when omitted.</summary>
    public const string FIELD_ATTR_CURRENCY              = "currency";
    /// <summary>Default ISO 4217 currency code when @currency is omitted on a currency field.</summary>
    public const string FIELD_ATTR_CURRENCY_DEFAULT      = "USD";
}
