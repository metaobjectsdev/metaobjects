// Field concern constants — the field subtypes, the field-level attr keys,
// AUTO_SET semantics, and currency attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/field/field-constants.ts.
// (DB-physical attrs @dbColumn / @db.indexed live in Persistence/Db/DbConstants.cs.)

using MetaObjects.Shared;

namespace MetaObjects.Core.Field;

/// <summary>
/// Field concern constants — the 15 field subtypes (plus the universal base),
/// the field-level attr keys, AUTO_SET semantics, and currency attrs.
/// </summary>
public static class FieldConstants
{
    // -----------------------------------------------------------------------
    // Field subtypes (15)
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

    public const string AUTO_SET_ON_CREATE = "onCreate";
    public const string AUTO_SET_ON_UPDATE = "onUpdate";

    public static readonly string[] AUTO_SET_VALUES = [AUTO_SET_ON_CREATE, AUTO_SET_ON_UPDATE];

    // -----------------------------------------------------------------------
    // Currency attrs (on currency-subtype fields)
    // -----------------------------------------------------------------------

    /// <summary>ISO 4217 currency code on a currency-subtype field. Defaults to "USD" when omitted.</summary>
    public const string FIELD_ATTR_CURRENCY              = "currency";
    /// <summary>Default ISO 4217 currency code when @currency is omitted on a currency field.</summary>
    public const string FIELD_ATTR_CURRENCY_DEFAULT      = "USD";
}
