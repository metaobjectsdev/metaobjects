namespace MetaObjects;

/// <summary>
/// Metamodel constants — ported 1:1 from typescript/packages/metadata/src/constants.ts.
/// SCREAMING_SNAKE names are intentional: cross-language grep parity with TS and Java.
/// </summary>
public static class Constants
{
    // ---------------------------------------------------------------------------
    // Base type names (the 8 registered base types — Java metaobjects-core vocabulary)
    // ---------------------------------------------------------------------------

    public const string TYPE_METADATA     = "metadata";
    public const string TYPE_OBJECT       = "object";
    public const string TYPE_FIELD        = "field";
    public const string TYPE_ATTR         = "attr";
    public const string TYPE_VALIDATOR    = "validator";
    public const string TYPE_VIEW         = "view";
    public const string TYPE_IDENTITY     = "identity";
    public const string TYPE_RELATIONSHIP = "relationship";
    public const string TYPE_LAYOUT       = "layout";
    public const string TYPE_SOURCE       = "source";
    public const string TYPE_ORIGIN       = "origin";

    public static readonly string[] BASE_TYPES =
    [
        TYPE_METADATA,
        TYPE_OBJECT,
        TYPE_FIELD,
        TYPE_ATTR,
        TYPE_VALIDATOR,
        TYPE_VIEW,
        TYPE_IDENTITY,
        TYPE_RELATIONSHIP,
        TYPE_LAYOUT,
        TYPE_SOURCE,
        TYPE_ORIGIN,
    ];

    // ---------------------------------------------------------------------------
    // Universal subtype
    // ---------------------------------------------------------------------------

    public const string SUBTYPE_BASE = "base";

    // ---------------------------------------------------------------------------
    // Metadata subtypes (1)
    // ---------------------------------------------------------------------------

    /// <summary>
    /// The metadata document root subtype. The root node is <c>metadata.root</c> in the
    /// canonical format. (Distinct from the universal SUBTYPE_BASE — the redesigned
    /// format spec confirms the root subtype is <c>root</c>, not <c>base</c>.)
    /// </summary>
    public const string SUBTYPE_ROOT = "root";

    public static readonly string[] METADATA_SUBTYPES = [SUBTYPE_ROOT];

    // ---------------------------------------------------------------------------
    // Object subtypes (cross-language, conceptual)
    // ---------------------------------------------------------------------------
    //
    //   - base   : abstract template (no runtime semantics)
    //   - entity : persistent record (typically has @primary identity)
    //   - value  : value-object (no identity; equality by content)
    //
    // Java runtime strategies (pojo/map/proxy) live on @javaRuntime, not subType.

    public const string OBJECT_SUBTYPE_ENTITY = "entity";
    public const string OBJECT_SUBTYPE_VALUE  = "value";

    public static readonly string[] OBJECT_SUBTYPES =
    [
        SUBTYPE_BASE,
        OBJECT_SUBTYPE_ENTITY,
        OBJECT_SUBTYPE_VALUE,
    ];

    // ---------------------------------------------------------------------------
    // Field subtypes (15)
    // ---------------------------------------------------------------------------

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
        SUBTYPE_BASE,
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

    // ---------------------------------------------------------------------------
    // Attr subtypes (9)
    // ---------------------------------------------------------------------------

    public const string ATTR_SUBTYPE_STRING      = "string";
    public const string ATTR_SUBTYPE_INT         = "int";
    public const string ATTR_SUBTYPE_LONG        = "long";
    public const string ATTR_SUBTYPE_DOUBLE      = "double";
    public const string ATTR_SUBTYPE_BOOLEAN     = "boolean";
    public const string ATTR_SUBTYPE_CLASS       = "class";
    public const string ATTR_SUBTYPE_PROPERTIES  = "properties";
    public const string ATTR_SUBTYPE_STRINGARRAY = "stringarray";

    public static readonly string[] ATTR_SUBTYPES =
    [
        SUBTYPE_BASE,
        ATTR_SUBTYPE_STRING,
        ATTR_SUBTYPE_INT,
        ATTR_SUBTYPE_LONG,
        ATTR_SUBTYPE_DOUBLE,
        ATTR_SUBTYPE_BOOLEAN,
        ATTR_SUBTYPE_CLASS,
        ATTR_SUBTYPE_PROPERTIES,
        ATTR_SUBTYPE_STRINGARRAY,
    ];

    // ---------------------------------------------------------------------------
    // Validator subtypes (6)
    // ---------------------------------------------------------------------------

    public const string VALIDATOR_SUBTYPE_REQUIRED = "required";
    public const string VALIDATOR_SUBTYPE_LENGTH   = "length";
    public const string VALIDATOR_SUBTYPE_REGEX    = "regex";
    public const string VALIDATOR_SUBTYPE_NUMERIC  = "numeric";
    public const string VALIDATOR_SUBTYPE_ARRAY    = "array";

    public static readonly string[] VALIDATOR_SUBTYPES =
    [
        SUBTYPE_BASE,
        VALIDATOR_SUBTYPE_REQUIRED,
        VALIDATOR_SUBTYPE_LENGTH,
        VALIDATOR_SUBTYPE_REGEX,
        VALIDATOR_SUBTYPE_NUMERIC,
        VALIDATOR_SUBTYPE_ARRAY,
    ];

    // ---------------------------------------------------------------------------
    // View subtypes (13)
    //
    // The view's subType IS the UI control type. Each control kind has its own
    // expected attrs (placeholder, maxLength, options, etc.) — runtime-ts
    // surfaces them as opaque Record<string, unknown>; UI layers interpret.
    // Mirrors metaobjects-dynamic/web/.../html/*View.java naming.
    // ---------------------------------------------------------------------------

    public const string VIEW_SUBTYPE_TEXT     = "text";
    public const string VIEW_SUBTYPE_TEXTAREA = "textarea";
    public const string VIEW_SUBTYPE_DATE     = "date";
    public const string VIEW_SUBTYPE_MONTH    = "month";
    public const string VIEW_SUBTYPE_HOTLINK  = "hotlink";
    public const string VIEW_SUBTYPE_DROPDOWN = "dropdown";
    public const string VIEW_SUBTYPE_RADIO    = "radio";
    public const string VIEW_SUBTYPE_CHECKBOX = "checkbox";
    public const string VIEW_SUBTYPE_NUMBER   = "number";
    public const string VIEW_SUBTYPE_PASSWORD = "password";
    public const string VIEW_SUBTYPE_HIDDEN   = "hidden";
    /// <summary>Abstract base for web-rendered views.</summary>
    public const string VIEW_SUBTYPE_WEB      = "web";
    public const string VIEW_SUBTYPE_CURRENCY = "currency";

    public static readonly string[] VIEW_SUBTYPES =
    [
        SUBTYPE_BASE,
        VIEW_SUBTYPE_TEXT,
        VIEW_SUBTYPE_TEXTAREA,
        VIEW_SUBTYPE_DATE,
        VIEW_SUBTYPE_MONTH,
        VIEW_SUBTYPE_HOTLINK,
        VIEW_SUBTYPE_DROPDOWN,
        VIEW_SUBTYPE_RADIO,
        VIEW_SUBTYPE_CHECKBOX,
        VIEW_SUBTYPE_NUMBER,
        VIEW_SUBTYPE_PASSWORD,
        VIEW_SUBTYPE_HIDDEN,
        VIEW_SUBTYPE_WEB,
        VIEW_SUBTYPE_CURRENCY,
    ];

    // ---------------------------------------------------------------------------
    // Layout type — object-level UI surfaces (replaces Project B's object-attached
    // data-grid view subtype; views are now strictly field-level per Java parity).
    // ---------------------------------------------------------------------------

    public const string LAYOUT_SUBTYPE_DATA_GRID = "dataGrid";

    public static readonly string[] LAYOUT_SUBTYPES =
    [
        SUBTYPE_BASE,
        LAYOUT_SUBTYPE_DATA_GRID,
    ];

    // ---------------------------------------------------------------------------
    // Layout attrs (on dataGrid layouts)
    // ---------------------------------------------------------------------------

    public const string LAYOUT_DATA_GRID_ATTR_PAGE_SIZE          = "pageSize";
    public const string LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD = "defaultSortField";
    public const string LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER = "defaultSortOrder";
    public const string LAYOUT_DATA_GRID_ATTR_FILTERABLE         = "filterable";
    public const string LAYOUT_DATA_GRID_ATTR_FILTER             = "filter";
    public const string LAYOUT_DATA_GRID_ATTR_COLUMNS            = "columns";

    // ---------------------------------------------------------------------------
    // View attrs (on currency views)
    // ---------------------------------------------------------------------------

    /// <summary>BCP 47 locale code on a view[currency]. Defaults to "en-US" when omitted.</summary>
    public const string VIEW_CURRENCY_ATTR_LOCALE         = "locale";
    /// <summary>Default BCP 47 locale code when @locale is omitted on a view[currency].</summary>
    public const string VIEW_CURRENCY_ATTR_LOCALE_DEFAULT = "en-US";

    // ---------------------------------------------------------------------------
    // Identity subtypes (2 — NO base; Java doesn't register one)
    // ---------------------------------------------------------------------------

    public const string IDENTITY_SUBTYPE_PRIMARY   = "primary";
    public const string IDENTITY_SUBTYPE_SECONDARY = "secondary";

    public static readonly string[] IDENTITY_SUBTYPES =
    [
        IDENTITY_SUBTYPE_PRIMARY,
        IDENTITY_SUBTYPE_SECONDARY,
    ];

    // ---------------------------------------------------------------------------
    // Relationship subtypes (4)
    // ---------------------------------------------------------------------------

    public const string RELATIONSHIP_SUBTYPE_ASSOCIATION  = "association";
    public const string RELATIONSHIP_SUBTYPE_AGGREGATION  = "aggregation";
    public const string RELATIONSHIP_SUBTYPE_COMPOSITION  = "composition";

    public static readonly string[] RELATIONSHIP_SUBTYPES =
    [
        SUBTYPE_BASE,
        RELATIONSHIP_SUBTYPE_ASSOCIATION,
        RELATIONSHIP_SUBTYPE_AGGREGATION,
        RELATIONSHIP_SUBTYPE_COMPOSITION,
    ];

    // ---------------------------------------------------------------------------
    // Reserved structural body keys (redesigned format — NOT @-prefixed, NOT attrs)
    //
    // Every node body is a map whose only permitted non-@ keys are these. The
    // canonical body-key order is: name, package, extends, abstract, overlay,
    // isArray, @-attrs (alphabetical), children.
    // ---------------------------------------------------------------------------

    public const string RESERVED_KEY_NAME     = "name";
    public const string RESERVED_KEY_PACKAGE  = "package";
    /// <summary>The supertype reference.</summary>
    public const string RESERVED_KEY_EXTENDS  = "extends";
    /// <summary>true → the node is abstract.</summary>
    public const string RESERVED_KEY_ABSTRACT = "abstract";
    /// <summary>true → re-opens an existing same-named node.</summary>
    public const string RESERVED_KEY_OVERLAY  = "overlay";
    /// <summary>true → the node is an array.</summary>
    public const string RESERVED_KEY_IS_ARRAY = "isArray";
    public const string RESERVED_KEY_CHILDREN = "children";
    /// <summary>attr-child-node body key carrying the typed value.</summary>
    public const string RESERVED_KEY_VALUE    = "value";

    public static readonly HashSet<string> RESERVED_KEYS = new HashSet<string>
    {
        RESERVED_KEY_NAME,
        RESERVED_KEY_PACKAGE,
        RESERVED_KEY_EXTENDS,
        RESERVED_KEY_ABSTRACT,
        RESERVED_KEY_OVERLAY,
        RESERVED_KEY_IS_ARRAY,
        RESERVED_KEY_CHILDREN,
        RESERVED_KEY_VALUE,
    };

    // ---------------------------------------------------------------------------
    // JSON document special keys (top-level, ignored during wrapper-key detection)
    // ---------------------------------------------------------------------------

    public const string JSON_KEY_SCHEMA = "$schema";

    // ---------------------------------------------------------------------------
    // Inline attribute prefix + fused type.subType key separator
    // ---------------------------------------------------------------------------

    public const string ATTR_PREFIX = "@";

    /// <summary>Separator fusing type and subType in a node's wrapper key (<c>object.entity</c>).</summary>
    public const string TYPE_SUBTYPE_SEPARATOR = ".";

    // ---------------------------------------------------------------------------
    // Package path conventions
    // ---------------------------------------------------------------------------

    /// <summary>Separator between package segments and between package and name.</summary>
    public const string PACKAGE_SEPARATOR = "::";

    /// <summary>Relative-reference "go up one level" marker.</summary>
    public const string PACKAGE_PARENT = "..";

    // ---------------------------------------------------------------------------
    // Wildcard for child-rule matching
    // ---------------------------------------------------------------------------

    public const string CHILD_RULE_WILDCARD = "*";

    // ---------------------------------------------------------------------------
    // Codegen / runtime attribute keys
    //
    // These are the attribute names referenced by codegen-ts, runtime-ts, and
    // migrate-ts when reading metadata. Centralized here for typo-safety and
    // cross-language parity (Java metaobjects-core uses analogous string
    // constants for the same attribute names).
    // ---------------------------------------------------------------------------

    // Identity attrs
    public const string IDENTITY_ATTR_FIELDS     = "fields";
    public const string IDENTITY_ATTR_GENERATION = "generation";
    /// <summary>On secondary identities: true → uniqueIndex; false/absent → index. Defaults to true for back-compat.</summary>
    public const string IDENTITY_ATTR_UNIQUE      = "unique";

    // Relationship attrs
    public const string RELATIONSHIP_ATTR_CARDINALITY  = "cardinality";
    public const string RELATIONSHIP_ATTR_OBJECT_REF   = "objectRef";
    public const string RELATIONSHIP_ATTR_FK_FIELD     = "fkField";
    /// <summary>The field name on the PARENT entity that the FK references. Defaults to the parent's primary identity field.</summary>
    public const string RELATIONSHIP_ATTR_PARENT_FIELD = "parentField";
    /// <summary>N:M cardinality.</summary>
    public const string RELATIONSHIP_ATTR_JOIN_ENTITY  = "joinEntity";
    /// <summary>N:M cardinality.</summary>
    public const string RELATIONSHIP_ATTR_JOIN_FIELDS  = "joinFields";

    // Field-level attrs (used by codegen-ts column mapper)
    public const string FIELD_ATTR_REQUIRED              = "required";
    public const string FIELD_ATTR_UNIQUE                = "unique";
    public const string FIELD_ATTR_DEFAULT               = "default";
    public const string FIELD_ATTR_MAX_LENGTH            = "maxLength";
    public const string FIELD_ATTR_DB_COLUMN             = "dbColumn";
    public const string FIELD_ATTR_PRECISION             = "precision";
    public const string FIELD_ATTR_SCALE                 = "scale";
    public const string FIELD_ATTR_FILTERABLE            = "filterable";
    public const string FIELD_ATTR_SORTABLE              = "sortable";
    public const string FIELD_ATTR_SORTABLE_DEFAULT_ORDER = "sortableDefaultOrder";
    /// <summary>When true, suppress the @filterable-without-index Loader warning (Project D drift check).</summary>
    public const string FIELD_ATTR_DB_INDEXED            = "db.indexed";
    /// <summary>ISO 4217 currency code on a currency-subtype field. Defaults to "USD" when omitted.</summary>
    public const string FIELD_ATTR_CURRENCY              = "currency";
    /// <summary>Default ISO 4217 currency code when @currency is omitted on a currency field.</summary>
    public const string FIELD_ATTR_CURRENCY_DEFAULT      = "USD";
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

    // Sort order values (used by @sortableDefaultOrder on fields and @defaultSortOrder on dataGrid layouts)
    public const string SORT_ORDER_ASC  = "asc";
    public const string SORT_ORDER_DESC = "desc";

    public static readonly string[] SORT_ORDER_VALUES = [SORT_ORDER_ASC, SORT_ORDER_DESC];

    // Java runtime materialization strategies (values for @javaRuntime on objects)
    public const string OBJECT_JAVA_RUNTIME_POJO  = "pojo";
    public const string OBJECT_JAVA_RUNTIME_MAP   = "map";
    public const string OBJECT_JAVA_RUNTIME_PROXY = "proxy";

    public static readonly string[] OBJECT_JAVA_RUNTIME_VALUES =
    [
        OBJECT_JAVA_RUNTIME_POJO,
        OBJECT_JAVA_RUNTIME_MAP,
        OBJECT_JAVA_RUNTIME_PROXY,
    ];

    // Validator attr keys (used by codegen-ts when reading validator children)
    public const string VALIDATOR_ATTR_PATTERN = "pattern";
    public const string VALIDATOR_ATTR_MIN     = "min";
    public const string VALIDATOR_ATTR_MAX     = "max";

    // Identity generation strategies (values for IDENTITY_ATTR_GENERATION)
    public const string GENERATION_INCREMENT = "increment";
    public const string GENERATION_UUID      = "uuid";
    public const string GENERATION_ASSIGNED  = "assigned";

    public static readonly string[] GENERATION_VALUES =
    [
        GENERATION_INCREMENT,
        GENERATION_UUID,
        GENERATION_ASSIGNED,
    ];

    // Relationship cardinality values (for RELATIONSHIP_ATTR_CARDINALITY)
    public const string CARDINALITY_ONE  = "one";
    public const string CARDINALITY_MANY = "many";

    public static readonly string[] CARDINALITY_VALUES = [CARDINALITY_ONE, CARDINALITY_MANY];

    // ---------------------------------------------------------------------------
    // Filter operators (Project D) — shared source of truth across server +
    // codegen. Each subtype declares which operators are legal for fields of that
    // type. Server allowlist generation + TS type generation + codegen-time grid
    // validation all import from here.
    // ---------------------------------------------------------------------------

    public static readonly string[] FILTER_OPS =
    [
        "eq", "ne", "gt", "gte", "lt", "lte", "in", "like", "isNull",
    ];

    public static readonly Dictionary<string, string[]> OPS_BY_SUBTYPE = new Dictionary<string, string[]>
    {
        ["string"]    = ["eq", "ne", "in", "like", "isNull"],
        ["int"]       = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["short"]     = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["byte"]      = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["long"]      = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["double"]    = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["float"]     = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["decimal"]   = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["boolean"]   = ["eq", "isNull"],
        ["date"]      = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["time"]      = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
        ["timestamp"] = ["eq", "ne", "gt", "gte", "lt", "lte", "in", "isNull"],
    };

    /// <summary>
    /// Returns the allowed filter operators for a given field subtype.
    /// Returns an empty array when the subtype is not in <see cref="OPS_BY_SUBTYPE"/>,
    /// matching the TS <c>OPS_BY_SUBTYPE[subType] ?? []</c> behaviour.
    /// </summary>
    public static string[] OpsForSubType(string subType) =>
        OPS_BY_SUBTYPE.TryGetValue(subType, out string[]? ops) ? ops : [];

    // Object-level attrs
    /// <summary>Java runtime strategy for an object. Values: "pojo" | "map" | "proxy".</summary>
    public const string OBJECT_ATTR_JAVA_RUNTIME = "javaRuntime";

    // ---------------------------------------------------------------------------
    // Source type — declares where an object's data lives (Project E).
    // dbTable / dbView ship in v1. Multiple sources per object are allowed
    // and meaningful (write-through CQRS: dbTable for writes + dbView for reads).
    // ---------------------------------------------------------------------------

    public const string SOURCE_SUBTYPE_DB_TABLE = "dbTable";
    public const string SOURCE_SUBTYPE_DB_VIEW  = "dbView";

    public static readonly string[] SOURCE_SUBTYPES =
    [
        SUBTYPE_BASE,
        SOURCE_SUBTYPE_DB_TABLE,
        SOURCE_SUBTYPE_DB_VIEW,
    ];

    // Source attrs — both dbTable and dbView use @name for the SQL identifier
    // (table name and view name respectively). Same key for ergonomic consistency.
    public const string SOURCE_DB_TABLE_ATTR_NAME = "name";
    public const string SOURCE_DB_VIEW_ATTR_NAME  = "name";
    /// <summary>
    /// Shared @name attr key for MetaSource (covers both dbTable and dbView). Use this
    /// in generic source accessors instead of the subtype-specific aliases above.
    /// </summary>
    public const string SOURCE_ATTR_NAME          = "name";

    // ---------------------------------------------------------------------------
    // Origin type — field-level provenance (Project E).
    //
    // Origin is a child of `field`. Says "this field's value comes from there."
    // passthrough: from <Entity.field> [via <relationship path>]
    // aggregate:   <agg> of <Entity.field> via <relationship path>
    //
    // ---------------------------------------------------------------------------

    public const string ORIGIN_SUBTYPE_PASSTHROUGH = "passthrough";
    public const string ORIGIN_SUBTYPE_AGGREGATE   = "aggregate";

    public static readonly string[] ORIGIN_SUBTYPES =
    [
        SUBTYPE_BASE,
        ORIGIN_SUBTYPE_PASSTHROUGH,
        ORIGIN_SUBTYPE_AGGREGATE,
    ];

    // passthrough attrs
    public const string ORIGIN_PASSTHROUGH_ATTR_FROM = "from";
    public const string ORIGIN_PASSTHROUGH_ATTR_VIA  = "via";

    // aggregate attrs
    public const string ORIGIN_AGGREGATE_ATTR_AGG = "agg";
    public const string ORIGIN_AGGREGATE_ATTR_OF  = "of";
    public const string ORIGIN_AGGREGATE_ATTR_VIA = "via";

    // aggregate function vocabulary
    public static readonly string[] AGGREGATE_FUNCTIONS = ["count", "sum", "avg", "min", "max"];
}
