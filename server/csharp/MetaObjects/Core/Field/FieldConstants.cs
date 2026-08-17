// Field concern constants — the field subtypes, the field-level attr keys,
// AUTO_SET semantics, and currency attrs.
//
// Colocated per ADR-0003. Mirrors typescript/packages/metadata/src/core/field/field-constants.ts.
// (DB-physical attrs @column / @db.indexed live in Persistence/Db/DbConstants.cs.)

using System.Collections.Generic;
using MetaObjects.Shared;

namespace MetaObjects.Core.Field;

/// <summary>
/// Field concern constants — the 17 field subtypes (plus the universal base),
/// the field-level attr keys, AUTO_SET semantics, and currency attrs.
/// </summary>
public static class FieldConstants
{
    // -----------------------------------------------------------------------
    // Field subtypes (16)
    // -----------------------------------------------------------------------

    public const string FIELD_SUBTYPE_STRING    = "string";
    public const string FIELD_SUBTYPE_INT       = "int";
    public const string FIELD_SUBTYPE_LONG      = "long";
    public const string FIELD_SUBTYPE_DOUBLE    = "double";
    public const string FIELD_SUBTYPE_FLOAT     = "float";
    public const string FIELD_SUBTYPE_DECIMAL   = "decimal";
    public const string FIELD_SUBTYPE_BOOLEAN   = "boolean";
    public const string FIELD_SUBTYPE_DATE      = "date";
    public const string FIELD_SUBTYPE_TIME      = "time";
    public const string FIELD_SUBTYPE_TIMESTAMP = "timestamp";
    public const string FIELD_SUBTYPE_OBJECT    = "object";
    public const string FIELD_SUBTYPE_MAP       = "map";
    public const string FIELD_SUBTYPE_CURRENCY  = "currency";
    public const string FIELD_SUBTYPE_ENUM      = "enum";
    /// <summary>
    /// R6 Plan 2a — <c>field.uuid</c>: a logical identity scalar (ADR-0013) whose value
    /// is a lowercase-canonical UUID string. String-backed on the wire (like
    /// <see cref="FIELD_SUBTYPE_STRING"/>); native binding is <c>System.Guid</c> in entity
    /// codegen and a Postgres native <c>uuid</c> column in the migrate engine. A bare scalar:
    /// no required attrs and no loader value-validation.
    /// </summary>
    public const string FIELD_SUBTYPE_UUID      = "uuid";

    /// <summary>
    /// ADR-0036 Wave 3 — <c>field.uri</c>: a URI/URL string. A concept with a native type +
    /// behavior, so a subtype (not a <c>@stringFormat</c>). String-backed on the wire (like
    /// <see cref="FIELD_SUBTYPE_STRING"/>); native binding is <c>System.Uri</c> in entity
    /// codegen and a Postgres <c>text</c> column (Postgres has no uri type). A bare scalar:
    /// no required attrs and no loader value-validation. Ships WITHOUT @kind in v1.
    /// </summary>
    public const string FIELD_SUBTYPE_URI       = "uri";

    /// <summary>
    /// ADR-0036 Wave 3 — <c>field.inet</c>: an IP-address string (IPv4 or IPv6). A concept
    /// with a native type + behavior, so a subtype (not a <c>@stringFormat</c>). String-backed
    /// on the wire (like <see cref="FIELD_SUBTYPE_STRING"/>); native binding is
    /// <c>System.Net.IPAddress</c> in entity codegen and a Postgres-native <c>inet</c> column.
    /// A bare scalar: no required attrs and no loader value-validation. Ships WITHOUT @kind in v1.
    /// </summary>
    public const string FIELD_SUBTYPE_INET      = "inet";

    public static readonly string[] FIELD_SUBTYPES =
    [
        BaseTypes.SUBTYPE_BASE,
        FIELD_SUBTYPE_STRING,
        FIELD_SUBTYPE_INT,
        FIELD_SUBTYPE_LONG,
        FIELD_SUBTYPE_DOUBLE,
        FIELD_SUBTYPE_FLOAT,
        FIELD_SUBTYPE_DECIMAL,
        FIELD_SUBTYPE_BOOLEAN,
        FIELD_SUBTYPE_DATE,
        FIELD_SUBTYPE_TIME,
        FIELD_SUBTYPE_TIMESTAMP,
        FIELD_SUBTYPE_OBJECT,
        FIELD_SUBTYPE_MAP,
        FIELD_SUBTYPE_CURRENCY,
        FIELD_SUBTYPE_ENUM,
        FIELD_SUBTYPE_UUID,
        FIELD_SUBTYPE_URI,
        FIELD_SUBTYPE_INET,
    ];

    // -----------------------------------------------------------------------
    // Field-level attrs (used by codegen-ts column mapper + Project D filter/sort)
    // -----------------------------------------------------------------------

    public const string FIELD_ATTR_REQUIRED              = "required";
    public const string FIELD_ATTR_UNIQUE                = "unique";

    /// <summary>
    /// ADR-0036 Wave 3 — <c>@stringFormat</c> on <c>field.string</c>: a closed validation
    /// format (email | hostname) for a plain string field that has NO native type or
    /// behavior of its own. The field stays a plain string (native binding + DB column
    /// unchanged); codegen emits the matching validator. The canonical matcher per format
    /// lives in each port's codegen, NOT author validator.regex. Named @stringFormat (not
    /// @format) to avoid colliding with template.* @format.
    /// </summary>
    public const string FIELD_ATTR_STRING_FORMAT        = "stringFormat";

    /// <summary>@stringFormat "email" — an RFC-5322-ish email address.</summary>
    public const string STRING_FORMAT_EMAIL             = "email";

    /// <summary>@stringFormat "hostname" — a DNS hostname (RFC-1123 label rules).</summary>
    public const string STRING_FORMAT_HOSTNAME          = "hostname";

    /// <summary>The closed @stringFormat value set.</summary>
    public static readonly string[] STRING_FORMAT_VALUES = [STRING_FORMAT_EMAIL, STRING_FORMAT_HOSTNAME];

    /// <summary>
    /// #234: opt a field.uri / field.inet OUT of strict well-formedness enforcement (optional
    /// boolean; default strict). When true, codegen binds a plain string (no URL/IP validator, no
    /// native Uri/IPAddress type; field.inet uses a text column). Only on field.uri / field.inet.
    /// </summary>
    public const string FIELD_ATTR_LENIENT              = "lenient";
    /// <summary>
    /// FR-013: when true, the field is read-only — codegen emits no setter, the
    /// persistence layer skips the column on INSERT/UPDATE, and input schemas mark
    /// it read-only. The value is populated by the database, replication, or an
    /// external owner.
    /// </summary>
    public const string FIELD_ATTR_READ_ONLY            = "readOnly";
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
    /// Scalar value subtype of a <c>field.map</c> (open-keyed map). Mutually exclusive
    /// with @objectRef (which sets a value-object value type). Keys are always strings.
    /// Mirrors TS <c>FIELD_ATTR_VALUE_TYPE</c>.
    /// </summary>
    public const string FIELD_ATTR_VALUE_TYPE            = "valueType";

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
    /// FR-019: optional boolean on a (package-level abstract) <c>field.enum</c>. When
    /// <c>true</c>, codegen REFERENCES the enum type from per-port codegen config instead
    /// of materializing it (ADR-0026) — the type is provided by hand-written / third-party
    /// code. Default <c>false</c> (metaobjects owns + emits it). It lives on the named-type
    /// declaration, never on a consuming field; no namespace/FQN lives in metadata (ADR-0001).
    /// </summary>
    public const string FIELD_ATTR_PROVIDED = "provided";

    /// <summary>
    /// Optional per-member int values (<c>{member: int}</c>) on a <c>field.enum</c>,
    /// switching that field's DB persistence from string+CHECK to integer+CHECK.
    /// <c>attr.intMap</c>-shaped. Keys must exactly match <see cref="FIELD_ATTR_VALUES"/>;
    /// values must be unique integers (content-rule validated in
    /// <c>ValidationPasses.ValidateEnumValues</c>, Rule 5). The generated native type
    /// and wire format are unchanged in every language.
    /// </summary>
    public const string FIELD_ATTR_INT_VALUE_MAP = "intValueMap";

    /// <summary>
    /// Regex pattern each enum member symbol must satisfy: must start with
    /// a letter or underscore, followed by letters, digits, or underscores.
    /// Keeps symbol == stored value with no name/value divergence.
    /// Mirrors TS ENUM_MEMBER_PATTERN.
    /// </summary>
    public const string ENUM_MEMBER_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*$";

    /// <summary>
    /// FR-010: map of off-vocabulary token → canonical enum member, feeding the
    /// tolerant extract alias-fold. <c>properties</c>-shaped; only on field.enum.
    /// </summary>
    public const string FIELD_ATTR_ENUM_ALIAS = "enumAlias";

    /// <summary>
    /// FR-010: map of enum member → human-readable description, shown per-member in
    /// the 'guide'-style output-format prompt fragment. <c>properties</c>-shaped; only on field.enum.
    /// </summary>
    public const string FIELD_ATTR_ENUM_DOC = "enumDoc";

    // -----------------------------------------------------------------------
    // FR-011 extract-hardening attrs (tolerant enum extract)
    // -----------------------------------------------------------------------

    /// <summary>
    /// FR-011: fallback enum member used when an LLM sends a present-but-uncoercible
    /// value. Must be one of the field's <c>@values</c> (loader-validated → ERR_BAD_ATTR_VALUE).
    /// On field.enum only.
    /// </summary>
    public const string FIELD_ATTR_COERCE_DEFAULT = "coerceDefault";

    /// <summary>
    /// FR-011: ASCII normalization mode for tolerant enum extract. Closed enum
    /// (none|collapse|strip). On field.enum (per-field) and object.value (default for its
    /// enum fields). Resolved field → object → global <see cref="NORMALIZE_DEFAULT"/>.
    /// </summary>
    public const string FIELD_ATTR_NORMALIZE = "normalize";

    /// <summary>
    /// FR-011: the three ASCII normalization modes (closed set).
    /// <list type="bullet">
    /// <item><c>none</c> — exact match only.</item>
    /// <item><c>collapse</c> — ASCII case-fold + trim + collapse runs of [\s_-]+ to one _.</item>
    /// <item><c>strip</c> — ASCII case-fold + strip everything except [A-Z0-9] (most forgiving).</item>
    /// </list>
    /// </summary>
    public static readonly IReadOnlyList<string> NORMALIZE_MODES = new[] { "none", "collapse", "strip" };

    /// <summary>
    /// FR-011: global normalization default when neither the field nor its owning
    /// object.value declares <c>@normalize</c>.
    /// </summary>
    public const string NORMALIZE_DEFAULT = "strip";

    // -----------------------------------------------------------------------
    // FR-010 field-teaching attrs (on any field; drive the output-format prompt)
    // -----------------------------------------------------------------------

    /// <summary>FR-010: an example value for this field, shown in the generated prompt fragment.</summary>
    public const string FIELD_ATTR_EXAMPLE = "example";

    /// <summary>FR-010: a short instruction for this field, shown in the generated prompt fragment.</summary>
    public const string FIELD_ATTR_INSTRUCTION = "instruction";

    // -----------------------------------------------------------------------
    // Currency attrs (on currency-subtype fields)
    // -----------------------------------------------------------------------

    /// <summary>ISO 4217 currency code on a currency-subtype field. Defaults to "USD" when omitted.</summary>
    public const string FIELD_ATTR_CURRENCY              = "currency";
    /// <summary>Default ISO 4217 currency code when @currency is omitted on a currency field.</summary>
    public const string FIELD_ATTR_CURRENCY_DEFAULT      = "USD";
}
