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
            Description: "When true, the field is NOT NULL. Equivalent to attaching a validator.required child. On a non-array string, generated wire-tier input validation (create/patch) additionally rejects the empty string by default — whitespace is accepted — unless an explicit validator.length @min: 0 opts back to presence-only. In-process read models never enforce this at construction."),

        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_UNIQUE,
            ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field gets a column-level UNIQUE constraint."),

        // FR-037 R1: who may write this field, and when. One axis, three mutually
        // exclusive modes. Cross-port attr on every field subtype.
        new AttrSchema(
            Name: FieldConstants.FIELD_ATTR_MUTABILITY,
            ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. FieldConstants.MUTABILITY_MODES],
            Description:
                "FR-037 R1: who may write this field, and when. 'readWrite' (the default when absent) — the" +
                " caller may set it on create and change it on update. 'writeOnce' — the caller sets it on " +
                "create; it is excluded from the update shape thereafter, so a value presented on PATCH is " +
                "ignored rather than rejected. 'readOnly' — nobody writes it: codegen emits no setter / wri" +
                "table property, the persistence layer skips the column on INSERT/UPDATE, and Zod/Pydantic/" +
                "class-validator schemas omit it from input variants; the value is populated by the databas" +
                "e (computed column, default expression, trigger), by replication, or by another external o" +
                "wner. The three are mutually exclusive modes of ONE axis — who may write, and when — so th" +
                "e illegal pair is unrepresentable and inheritance has a total order: a subtype may TIGHTEN" +
                " an inherited mode (readWrite < writeOnce < readOnly) and never loosen it (ERR_MUTABILITY_" +
                "DOWNGRADE). Pairing a non-readWrite mode with @autoSet is ERR_MUTABILITY_AUTOSET_CONFLICT:" +
                " @autoSet already says the SERVER supplies the value, which is a different axis from who m" +
                "ay write it."),

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

    /// <summary>
    /// ADR-0036 Wave 3 — the @stringFormat attr — only on field.string. Closed value set
    /// {email | hostname}. The field stays a plain string; codegen owns the canonical
    /// matcher per format. The allowed-values set is the Wave-1 gate mechanism (emitted to
    /// the registry manifest as allowedValues).
    /// </summary>
    public static readonly AttrSchema StringFormatAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_STRING_FORMAT,
        ValueType: AttrConstants.ATTR_SUBTYPE_STRING,
        Required: false,
        AllowedValues: [.. FieldConstants.STRING_FORMAT_VALUES],
        Description:
            "ADR-0036/0037: a closed validation format for a plain string field that has NO " +
            "native type or behavior of its own — email | hostname. The field stays a plain " +
            "string (native binding + DB column unchanged); codegen emits the matching validator. " +
            "The canonical matcher per format lives in each port's codegen, NOT author validator.regex.");

    /// <summary>
    /// #234 — the @lenient attr — only on field.uri / field.inet. Optional boolean; default (absent
    /// /false) is strict (an absolute-scheme URI / an IPv4-or-IPv6 literal). When true, codegen binds
    /// a plain string (no URL/IP validator, no native Uri/IPAddress type; field.inet uses a text
    /// column) so a not-strictly-valid value round-trips unchanged.
    /// </summary>
    public static readonly AttrSchema LenientAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_LENIENT,
        ValueType: AttrConstants.ATTR_SUBTYPE_BOOLEAN,
        Required: false,
        Description:
            "#234: opt this field out of strict well-formedness enforcement. When true, codegen binds " +
            "a plain string (no URL/IP validator, no native URI/InetAddress type; field.inet uses a " +
            "text column, not the native inet type) so a not-strictly-valid value round-trips " +
            "unchanged. Default (absent/false) is strict: an absolute-scheme URI / an IPv4-or-IPv6 literal.");

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

    /// <summary>The @intValueMap attr — only on field.enum. Optional object of integers.</summary>
    public static readonly AttrSchema IntValueMapAttr = new AttrSchema(
        Name: FieldConstants.FIELD_ATTR_INT_VALUE_MAP,
        ValueType: AttrConstants.ATTR_SUBTYPE_INT_MAP,
        Required: false,
        Description: "Optional per-member int values ({member: int}) switching this enum field's DB persistence from string+CHECK to integer+CHECK. Keys must exactly match @values; values must be unique integers.");

    // FR-033 — the field.enum tolerant-extract overlays (@enumAlias / @enumDoc /
    // @coerceDefault / @normalize) and object.value's @normalize default are NO LONGER
    // declared here. They are re-homed to the metaobjects-prompt concern provider
    // (PromptMetaDataProvider, reads prompt.json's field.enum + object.value extends),
    // matching the TS promptProvider split. Core keeps @values / @provided (the
    // structural enum vocabulary it legitimately owns).
}
