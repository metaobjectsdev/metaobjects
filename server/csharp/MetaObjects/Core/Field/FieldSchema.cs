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

        // FR-013: read-only field. Codegen emits no setter; persistence skips the
        // column on INSERT/UPDATE; input schemas mark it read-only. Cross-port attr.
        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_READ_ONLY,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description:
                "FR-013: when true, the field is read-only — codegen emits no setter / " +
                "writable property, the persistence layer skips the column on INSERT/UPDATE, " +
                "and Zod/Pydantic/class-validator schemas mark it read-only on input variants. " +
                "The value is populated by the database (computed column, default expression, " +
                "trigger), by replication, or by another external owner."),

        // DB-domain attrs — registered on every field subtype (mirror TS dbProvider:
        // @column is above; @db.indexed and @dbColumnType complete the trio).
        new AttrSchema(
            Name: DbConstants.FIELD_ATTR_DB_INDEXED,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description:
                "When true, suppress the @filterable-without-index Loader warning (the field is indexed by other means)."),

        new AttrSchema(
            Name: DbConstants.FIELD_ATTR_DB_COLUMN_TYPE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description:
                "Physical DB column-type override (ADR-0013 escape hatch). Legal values are " +
                "uuid | jsonb | timestamp_with_tz, each legal only on a specific logical field " +
                "subtype (uuid/jsonb on field.string, timestamp_with_tz on field.timestamp). " +
                "The logical field type and its native binding are unchanged."),

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

        // FR-010 field-teaching attrs (any field): free-text shown in the generated
        // output-format prompt fragment. Never carried in comments.
        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_EXAMPLE,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "FR-010: an example value for this field, shown in the generated output-format prompt fragment."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_INSTRUCTION,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "FR-010: a short instruction for this field, shown in the generated output-format prompt fragment."),
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

    /// <summary>
    /// The @enumAlias attr — only on field.enum. Map of off-vocabulary token → canonical
    /// member, feeding the FR-010 tolerant extract alias-fold (runtime aliases win on conflict).
    /// </summary>
    public static readonly AttrSchema EnumAliasAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_ENUM_ALIAS,
        ValueType: AttrConstants.ATTR_SUBTYPE_PROPERTIES,
        Required: false,
        Description: "Map of alternate/off-vocabulary tokens to canonical enum members; feeds the FR-010 tolerant extract alias-fold.");

    /// <summary>
    /// The @enumDoc attr — only on field.enum. Map of member → human-readable description,
    /// shown per-member in the FR-010 'guide'-style output-format prompt fragment.
    /// </summary>
    public static readonly AttrSchema EnumDocAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_ENUM_DOC,
        ValueType: AttrConstants.ATTR_SUBTYPE_PROPERTIES,
        Required: false,
        Description: "Map of enum member to a human-readable description; shown per-member in the FR-010 'guide'-style prompt fragment.");

    /// <summary>
    /// FR-011: the @coerceDefault attr — only on field.enum. String member symbol used as the
    /// extract fallback when an LLM sends a present-but-uncoercible value. Loader-validated to be
    /// one of the field's @values (ERR_BAD_ATTR_VALUE otherwise).
    /// </summary>
    public static readonly AttrSchema CoerceDefaultAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_COERCE_DEFAULT,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description: "Fallback enum member used by tolerant extract when a present value cannot be coerced; must be one of the field's @values.");

    /// <summary>
    /// FR-011: the @normalize attr — on field.enum (per-field) and object.value (object default).
    /// Closed enum (none|collapse|strip); controls the ASCII normalization applied during tolerant
    /// enum extract. Resolved field → owning object.value → global default (strip).
    /// </summary>
    public static readonly AttrSchema NormalizeAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_NORMALIZE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Default: FieldConstants.NORMALIZE_DEFAULT,
        AllowedValues: new object[] { "none", "collapse", "strip" },
        Description: "ASCII normalization mode for tolerant enum extract (none|collapse|strip, default strip). " +
                     "On field.enum it is per-field; on object.value it is the default for the object's enum fields.");
}
