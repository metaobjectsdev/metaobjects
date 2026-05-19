// Attribute schemas — ported from typescript/packages/metadata/src/core-attr-schemas.ts
//
// Per (type, subType) attr inventories consumed by RegisterCoreTypes()
// (CoreTypes.cs) and the attr-validation pass (attr-schema-validate).
//
// `required: true` is reserved for attrs that EVERY conformance fixture with
// that subtype supplies AND that are semantically mandatory. Everything else
// is `required: false`.
//
// This class is pure declarative data — no logic, no registration. It is
// split out of CoreTypes.cs so the registration logic stays readable.

namespace MetaObjects;

/// <summary>
/// Core attribute schema declarations, ported 1:1 from
/// <c>typescript/packages/metadata/src/core-attr-schemas.ts</c>.
/// </summary>
public static class CoreAttrSchemas
{
    // -----------------------------------------------------------------------
    // commonFieldAttrs — attrs common to every field subtype
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs common to every field subtype (codegen-ts column mapper + Project D filter/sort).
    /// </summary>
    public static readonly IReadOnlyList<AttrSchema> CommonFieldAttrs =
    [
        new AttrSchema(
            Name: Constants.FIELD_ATTR_OBJECT_REF,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Name (or FQN) of the target object an object-typed field nests — drives nested-object (de)serialization."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_REQUIRED,
            ValueType: Constants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field is NOT NULL. Equivalent to attaching a validator.required child."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_UNIQUE,
            ValueType: Constants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field gets a column-level UNIQUE constraint."),

        // @default is polymorphic: its value type follows the OWNING field's
        // subtype. No single fixed valueType can capture that, so ValueType is
        // intentionally null (declared-but-untyped). The parser stores the raw
        // JSON value type-preserved (no coercion).
        new AttrSchema(
            Name: Constants.FIELD_ATTR_DEFAULT,
            ValueType: null,
            Required: false,
            Description: "Default value applied to the column when no value is supplied. Its type follows the field's own subtype (string / boolean / number / ...). Converted at consumption time via MetaField.defaultValue()."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_MAX_LENGTH,
            ValueType: Constants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Maximum character length for string-typed fields (drives VARCHAR(n))."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_PRECISION,
            ValueType: Constants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Total number of significant digits for decimal-typed fields."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_SCALE,
            ValueType: Constants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Number of digits to the right of the decimal point for decimal-typed fields."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_FILTERABLE,
            ValueType: Constants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field is exposed in generated CRUD filter allowlists (Project D filter layer)."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_SORTABLE,
            ValueType: Constants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the field is exposed in generated CRUD sort allowlists. Inherits from @filterable by default; set false to opt out."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_SORTABLE_DEFAULT_ORDER,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. Constants.SORT_ORDER_VALUES],
            Description: "Default sort direction applied when this field is the default sort field."),

        new AttrSchema(
            Name: Constants.FIELD_ATTR_AUTO_SET,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. Constants.AUTO_SET_VALUES],
            Description: "Auto-set semantics for timestamp-like fields: 'onCreate' stamps on insert, 'onUpdate' stamps on every write."),
    ];

    // -----------------------------------------------------------------------
    // currencyFieldAttr — the @currency attr, only on field.currency
    // -----------------------------------------------------------------------

    /// <summary>
    /// The @currency attr — only on field.currency.
    /// </summary>
    public static readonly AttrSchema CurrencyFieldAttr = new AttrSchema(
        Name: Constants.FIELD_ATTR_CURRENCY,
        ValueType: Constants.ATTR_SUBTYPE_STRING,
        Required: false,
        Default: Constants.FIELD_ATTR_CURRENCY_DEFAULT,
        Description: "ISO 4217 currency code for a currency-subtype field. Storage is integer minor units; defaults to 'USD' when omitted.");

    // -----------------------------------------------------------------------
    // currencyViewAttrs — attrs on view.currency
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs on view.currency.
    /// </summary>
    public static readonly IReadOnlyList<AttrSchema> CurrencyViewAttrs =
    [
        new AttrSchema(
            Name: Constants.VIEW_CURRENCY_ATTR_LOCALE,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Default: Constants.VIEW_CURRENCY_ATTR_LOCALE_DEFAULT,
            Description: "BCP 47 locale code controlling currency display formatting. Defaults to 'en-US' when omitted."),
    ];

    // -----------------------------------------------------------------------
    // objectAttrs — attrs common to every object subtype
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs common to every object subtype.
    /// </summary>
    public static readonly IReadOnlyList<AttrSchema> ObjectAttrs =
    [
        new AttrSchema(
            Name: Constants.OBJECT_ATTR_JAVA_RUNTIME,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. Constants.OBJECT_JAVA_RUNTIME_VALUES],
            Description: "Java runtime materialization strategy for this object (pojo / map / proxy). Ignored by non-Java implementations."),
    ];

    // -----------------------------------------------------------------------
    // relationshipAttrs — attrs common to every relationship subtype
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs common to every relationship subtype.
    /// </summary>
    public static readonly IReadOnlyList<AttrSchema> RelationshipAttrs =
    [
        new AttrSchema(
            Name: Constants.RELATIONSHIP_ATTR_CARDINALITY,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            // No AllowedValues: @cardinality is an open string at the metamodel level.
            // Java canonical fixtures use composite forms such as "many-to-one"; the
            // CARDINALITY_VALUES ("one"/"many") constant is a TS codegen convenience,
            // NOT a closed metamodel enum. A3 must not reject Java-canonical values.
            Description: "Cardinality of the relationship target (e.g. 'one', 'many', 'many-to-one')."),

        new AttrSchema(
            Name: Constants.RELATIONSHIP_ATTR_OBJECT_REF,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Name or fully-qualified name of the target object the relationship points to (e.g. 'Week' or 'acme::vehicle::Car')."),

        new AttrSchema(
            Name: Constants.RELATIONSHIP_ATTR_FK_FIELD,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Name of the foreign-key field on the source entity (for one-to-many / many-to-one relationships)."),

        new AttrSchema(
            Name: Constants.RELATIONSHIP_ATTR_PARENT_FIELD,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Field name on the parent entity that the FK references. Defaults to the parent's primary identity field."),

        new AttrSchema(
            Name: Constants.RELATIONSHIP_ATTR_JOIN_ENTITY,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Join-table entity name for N:M relationships."),

        new AttrSchema(
            Name: Constants.RELATIONSHIP_ATTR_JOIN_FIELDS,
            ValueType: Constants.ATTR_SUBTYPE_STRINGARRAY,
            Required: false,
            Description: "Join-table column names for N:M relationships."),
    ];

    // -----------------------------------------------------------------------
    // identityFieldsAttr — @fields is required on identity.primary / identity.secondary
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs on identity.primary / identity.secondary — @fields is required.
    /// </summary>
    public static readonly AttrSchema IdentityFieldsAttr = new AttrSchema(
        Name: Constants.IDENTITY_ATTR_FIELDS,
        ValueType: Constants.ATTR_SUBTYPE_STRINGARRAY,
        Required: true,
        Description: "The field name(s) composing this identity. Single-element for a simple PK/index, multiple for a composite.");

    // -----------------------------------------------------------------------
    // dataGridLayoutAttrs — attrs on layout.dataGrid
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs on layout.dataGrid.
    /// </summary>
    public static readonly IReadOnlyList<AttrSchema> DataGridLayoutAttrs =
    [
        new AttrSchema(
            Name: Constants.LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
            ValueType: Constants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Number of rows per page in the generated data grid."),

        new AttrSchema(
            Name: Constants.LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Field name the grid is sorted by on initial render. Must reference an actual field on the entity."),

        new AttrSchema(
            Name: Constants.LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. Constants.SORT_ORDER_VALUES],
            Description: "Initial sort direction for the default sort field: 'asc' or 'desc'."),

        new AttrSchema(
            Name: Constants.LAYOUT_DATA_GRID_ATTR_FILTERABLE,
            ValueType: Constants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true, the generated grid exposes column filtering UI."),

        new AttrSchema(
            Name: Constants.LAYOUT_DATA_GRID_ATTR_FILTER,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "JSON-encoded preset filter applied to the grid at the metadata level."),

        new AttrSchema(
            Name: Constants.LAYOUT_DATA_GRID_ATTR_COLUMNS,
            ValueType: Constants.ATTR_SUBTYPE_STRINGARRAY,
            Required: false,
            Description: "Flat ordered list of field names to display as grid columns."),
    ];

    // -----------------------------------------------------------------------
    // minMaxValidatorAttrs — @min / @max shared by length, numeric, array, and base validator
    // (private — consumed only by VALIDATOR_ATTRS_MAP below)
    // -----------------------------------------------------------------------

    private static readonly IReadOnlyList<AttrSchema> MinMaxValidatorAttrs =
    [
        new AttrSchema(
            Name: Constants.VALIDATOR_ATTR_MIN,
            ValueType: Constants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Minimum allowed value (length, numeric value, or array element count depending on the validator subtype)."),

        new AttrSchema(
            Name: Constants.VALIDATOR_ATTR_MAX,
            ValueType: Constants.ATTR_SUBTYPE_INT,
            Required: false,
            Description: "Maximum allowed value (length, numeric value, or array element count depending on the validator subtype)."),
    ];

    // -----------------------------------------------------------------------
    // Private identity schema lists — consumed only by IDENTITY_ATTRS_MAP
    // -----------------------------------------------------------------------

    private static readonly IReadOnlyList<AttrSchema> PrimaryIdentityAttrs =
    [
        IdentityFieldsAttr,
        new AttrSchema(
            Name: Constants.IDENTITY_ATTR_GENERATION,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            AllowedValues: [.. Constants.GENERATION_VALUES],
            Description: "Primary-key value generation strategy: 'increment' (auto-increment), 'uuid', or 'assigned' (caller-supplied)."),
    ];

    private static readonly IReadOnlyList<AttrSchema> SecondaryIdentityAttrs =
    [
        IdentityFieldsAttr,
        new AttrSchema(
            Name: Constants.IDENTITY_ATTR_UNIQUE,
            ValueType: Constants.ATTR_SUBTYPE_BOOLEAN,
            Required: false,
            Description: "When true (default), the secondary identity is a UNIQUE index; false makes it a plain (non-unique) index."),
    ];

    // -----------------------------------------------------------------------
    // Private origin schema lists — consumed only by ORIGIN_ATTRS_MAP
    // -----------------------------------------------------------------------

    private static readonly IReadOnlyList<AttrSchema> PassthroughOriginAttrs =
    [
        new AttrSchema(
            Name: Constants.ORIGIN_PASSTHROUGH_ATTR_FROM,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Dotted Entity.field reference identifying the source value this projection field passes through (e.g. 'Program.title')."),

        new AttrSchema(
            Name: Constants.ORIGIN_PASSTHROUGH_ATTR_VIA,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: false,
            Description: "Optional dotted relationship path used to reach the source entity (e.g. 'Program.weeks')."),
    ];

    private static readonly IReadOnlyList<AttrSchema> AggregateOriginAttrs =
    [
        new AttrSchema(
            Name: Constants.ORIGIN_AGGREGATE_ATTR_AGG,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: true,
            AllowedValues: [.. Constants.AGGREGATE_FUNCTIONS],
            Description: "Aggregate function applied over the relationship path: count, sum, avg, min, or max."),

        new AttrSchema(
            Name: Constants.ORIGIN_AGGREGATE_ATTR_OF,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Dotted Entity.field reference identifying the column being aggregated (e.g. 'Week.durationMinutes')."),

        new AttrSchema(
            Name: Constants.ORIGIN_AGGREGATE_ATTR_VIA,
            ValueType: Constants.ATTR_SUBTYPE_STRING,
            Required: true,
            Description: "Dotted relationship path from the base entity to the aggregated rows (e.g. 'Program.weeks' or 'Program.weeks.workouts')."),
    ];

    // -----------------------------------------------------------------------
    // ORIGIN_ATTRS_MAP — attrs per origin subtype
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs per origin subtype. base has none; passthrough and aggregate carry
    /// their respective attrs.
    /// Ported from <c>ORIGIN_ATTRS_MAP</c> in core-attr-schemas.ts.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> OriginAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [Constants.SUBTYPE_BASE]              = [],
            [Constants.ORIGIN_SUBTYPE_PASSTHROUGH] = [.. PassthroughOriginAttrs],
            [Constants.ORIGIN_SUBTYPE_AGGREGATE]   = [.. AggregateOriginAttrs],
        };

    // -----------------------------------------------------------------------
    // IDENTITY_ATTRS_MAP — attrs per identity subtype
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs per identity subtype. primary adds @generation; secondary adds @unique.
    /// Ported from <c>IDENTITY_ATTRS_MAP</c> in core-attr-schemas.ts.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> IdentityAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [Constants.IDENTITY_SUBTYPE_PRIMARY]   = [.. PrimaryIdentityAttrs],
            [Constants.IDENTITY_SUBTYPE_SECONDARY] = [.. SecondaryIdentityAttrs],
        };

    // -----------------------------------------------------------------------
    // VALIDATOR_ATTRS_MAP — attrs per validator subtype
    // -----------------------------------------------------------------------

    /// <summary>
    /// Attrs per validator subtype. Required uses none; regex adds @pattern.
    /// Ported from <c>VALIDATOR_ATTRS_MAP</c> in core-attr-schemas.ts.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, IReadOnlyList<AttrSchema>> ValidatorAttrsMap =
        new Dictionary<string, IReadOnlyList<AttrSchema>>
        {
            [Constants.SUBTYPE_BASE]                  = [.. MinMaxValidatorAttrs],
            [Constants.VALIDATOR_SUBTYPE_REQUIRED]     = [],
            [Constants.VALIDATOR_SUBTYPE_LENGTH]       = [.. MinMaxValidatorAttrs],
            [Constants.VALIDATOR_SUBTYPE_REGEX]        =
            [
                .. MinMaxValidatorAttrs,
                new AttrSchema(
                    Name: Constants.VALIDATOR_ATTR_PATTERN,
                    ValueType: Constants.ATTR_SUBTYPE_STRING,
                    Required: false,
                    Description: "Regular expression the value must match."),
            ],
            [Constants.VALIDATOR_SUBTYPE_NUMERIC]      = [.. MinMaxValidatorAttrs],
            [Constants.VALIDATOR_SUBTYPE_ARRAY]        = [.. MinMaxValidatorAttrs],
        };
}
