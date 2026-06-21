// Field attribute schemas — attrs common to every field subtype, plus the
// @currency attr specific to field.currency. Consumed by CoreTypes.RegisterCoreTypeDefs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/field/field-schema.ts.

using MetaObjects.Core.Attr;

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

        // DB-domain attrs (@column / @db.indexed / @dbColumnType) are NOT here — they
        // are registered onto every field subtype by DbMetaDataProvider (DbProvider.cs)
        // via TypeRegistry.Extend, matching the TS dbProvider and Java CoreDBMetaDataProvider
        // end-state (domain field-attrs live in domain providers, not on core FieldSchema).

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

        // FR-033 — the UI / query-surface markers (@filterable / @sortable /
        // @sortableDefaultOrder) are NO LONGER declared here. They are re-homed to the
        // metaobjects-ui concern provider (UiMetaDataProvider, reads ui.json's field.*
        // extends), matching the TS uiProvider split. Core keeps only the attrs it
        // legitimately owns.

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_AUTO_SET,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. FieldConstants.AUTO_SET_VALUES],
            Description: "Auto-set semantics for timestamp-like fields: 'onCreate' stamps on insert, 'onUpdate' stamps on every write."),

        // NOTE: the DB-domain field attrs (@column / @db.indexed / @dbColumnType) are NOT
        // declared here. They are a domain concern registered onto every field subtype by
        // DbMetaDataProvider (Persistence/Db/DbProvider.cs) via TypeRegistry.Extend — mirroring
        // Java's CoreDBMetaDataProvider and TS's dbProvider. (The YAML coercion guard on a
        // string-typed @column still fires because the DB provider is composed into the default
        // registry.)

        // FR-033 — the FR-010 field-teaching prompt markers (@example / @instruction)
        // are NO LONGER declared here. They are re-homed to the metaobjects-prompt
        // concern provider (PromptMetaDataProvider, reads prompt.json's field.* extends),
        // alongside @xmlText and the field.enum tolerant-extract overlays.
    ];

    /// <summary>
    /// The @valueType attr — only on field.map. Scalar value subtype of an open-keyed map
    /// (string/int/long/double/float/decimal/boolean/date/time/timestamp/uuid). Mutually
    /// exclusive with @objectRef; exactly one of the two must be set (loader-enforced).
    /// </summary>
    public static readonly AttrSchema MapValueTypeAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_VALUE_TYPE,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        Description:
            "Scalar value subtype for a scalar-valued map " +
            "(string/int/long/double/float/decimal/boolean/date/time/timestamp/uuid). " +
            "Mutually exclusive with @objectRef; exactly one of the two must be set.");

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
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: true,
        IsArray: true,
        Description: "Member symbols of an enum-subtype field; declaration order significant.");

    /// <summary>
    /// FR-019: the @provided attr — only on field.enum. Optional boolean. When true on
    /// an abstract (declaration) field.enum, codegen REFERENCES the type from per-port
    /// config instead of materializing it (ADR-0026). A non-boolean value is rejected at
    /// load with ERR_BAD_ATTR_VALUE. No namespace/FQN lives in metadata (ADR-0001).
    /// </summary>
    public static readonly AttrSchema ProvidedAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_PROVIDED,
        ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
        Required: false,
        Description:
            "FR-019: marks an abstract package-level field.enum as externally provided — " +
            "codegen references the type (resolved via per-port codegen config) instead of " +
            "materializing it. Default false. Not a field attr — it lives on the type declaration.");

    // FR-033 — the field.enum tolerant-extract overlays (@enumAlias / @enumDoc /
    // @coerceDefault / @normalize) and object.value's @normalize default are NO LONGER
    // declared here. They are re-homed to the metaobjects-prompt concern provider
    // (PromptMetaDataProvider, reads prompt.json's field.enum + object.value extends),
    // matching the TS promptProvider split. Core keeps @values / @provided (the
    // structural enum vocabulary it legitimately owns).
}
