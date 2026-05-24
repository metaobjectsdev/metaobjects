// Field attribute schemas — attrs common to every field subtype, plus the
// @currency attr specific to field.currency. Consumed by CoreTypes.RegisterCoreTypeDefs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/field/field-schema.ts.

using MetaObjects.Core.Attr;
using MetaObjects.Core.Query;
using MetaObjects.Persistence.Db;

namespace MetaObjects.Core.Field;

/// <summary>
/// Field-level attribute schemas — attrs common to every field subtype, plus the
/// @currency attr specific to field.currency.
/// </summary>
public static class FieldSchema
{
    /// <summary>
    /// Attrs common to every field subtype (codegen-ts column mapper + Project D filter/sort).
    /// </summary>
    public static readonly IReadOnlyList<AttrSchema> CommonFieldAttrs =
    [
        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_OBJECT_REF,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Name (or FQN) of the target object an object-typed field nests — drives nested-object (de)serialization."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_STORAGE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. FieldConstants.STORAGE_VALUES],
            Description:
                "Storage strategy for an object-typed field (set with @objectRef). " +
                "\"flattened\" expands the nested value into prefixed columns on the parent " +
                "table. \"jsonb\" stores the structured value in a single jsonb column " +
                "(supports isArray=true for arrays of values). \"subdocument\" is a hint for " +
                "document-store codegen targets and emits no Postgres column."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_REQUIRED,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field is NOT NULL. Equivalent to attaching a validator.required child."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_UNIQUE,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field gets a column-level UNIQUE constraint."),

        // @default is polymorphic: its value type follows the OWNING field's
        // subtype. No single fixed valueType can capture that, so ValueType is
        // intentionally null (declared-but-untyped). The parser stores the raw
        // JSON value type-preserved (no coercion).
        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_DEFAULT,
            ValueType: null,
            Required: false,
            Description: "Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue()."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_MAX_LENGTH,
            ValueType: AttrConstants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Maximum character length for string-typed fields (drives VARCHAR(n))."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_PRECISION,
            ValueType: AttrConstants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Total number of significant digits for decimal-typed fields."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_SCALE,
            ValueType: AttrConstants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Number of digits to the right of the decimal point for decimal-typed fields."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_FILTERABLE,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer)."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_SORTABLE,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. QueryConstants.SORT_ORDER_VALUES],
            Description: "Default sort direction applied when this field is the default sort field."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_AUTO_SET,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. FieldConstants.AUTO_SET_VALUES],
            Description: "Auto-set semantics for timestamp-like fields: 'onCreate' stamps on insert, 'onUpdate' stamps on every write."),

        // Source-v2: physical column name override on an rdb source. Paradigm-neutral
        // (no "db" prefix) — pairs with source.rdb @table. Registered on every field
        // subtype so a YAML coercion check on `column: TRUE` fires the guard.
        new AttrSchema(
            Name: DbConstants.FIELD_ATTR_COLUMN,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Physical column name for this field on an rdb source. Defaults to the field name via columnNamingStrategy."),
    ];

    /// <summary>The @currency attr — only on field.currency.</summary>
    public static readonly AttrSchema CurrencyFieldAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_CURRENCY,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Default: FieldConstants.FIELD_ATTR_CURRENCY_DEFAULT,
        Description: "ISO 4217 currency code for a currency-subtype field. Storage is integer minor units; defaults to 'USD' when omitted.");

    /// <summary>The @values attr — only on field.enum. Required string array.</summary>
    public static readonly AttrSchema EnumValuesAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_VALUES,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRINGARRAY,
        Required: true,
        Description: "Member symbols of an enum-subtype field; declaration order significant.");
}
