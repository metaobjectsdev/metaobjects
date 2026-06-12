using MetaObjects.Source;

namespace MetaObjects;

/// <summary>Stable, language-neutral error codes — mirrors fixtures/conformance/ERROR-CODES.json.</summary>
public enum ErrorCode
{
    ERR_MALFORMED_JSON,
    ERR_TOP_LEVEL_NOT_OBJECT,
    ERR_UNKNOWN_TYPE,
    ERR_UNKNOWN_SUBTYPE,
    ERR_MISSING_SUBTYPE,
    ERR_DUPLICATE_NAME,
    ERR_UNRESOLVED_SUPER,
    // FR-024 (ADR-0029): a dotted extends ref resolved to a node whose type or
    // subtype does not match the extending node.
    ERR_EXTENDS_TARGET_MISMATCH,
    // FR-024: identity names required + projection identity pass-through.
    // Vocabulary-only here until FR-024 Phase E (the C# loader does not
    // enforce these yet); the enum tracks the shared corpus codes.
    ERR_IDENTITY_NAME_REQUIRED,
    ERR_PROJECTION_IDENTITY_NOT_EXTENDED,
    ERR_IDENTITY_KEY_MISMATCH,
    // FR-024 (ADR-0028): a source.* on an object.projection has a writable
    // @kind — projection sources must be read-only kinds. Vocabulary-only
    // here until FR-024 Phase E.
    ERR_PROJECTION_SOURCE_WRITABLE,
    ERR_INVALID_SUBTYPE_CHILD,
    ERR_UNKNOWN_ATTR,
    ERR_MISSING_REQUIRED_ATTR,
    ERR_BAD_ATTR_VALUE,
    ERR_BAD_DEFAULT_SORT_FIELD,
    ERR_PROVIDER_DEPENDENCY_CYCLE,
    ERR_PROVIDER_DUPLICATE_ID,
    ERR_PROVIDER_MISSING_DEPENDENCY,
    ERR_PROVIDER_ATTR_CONFLICT,
    ERR_SUBTYPE_RULE_VIOLATION,
    ERR_OVERLAY_NO_TARGET,
    ERR_MALFORMED_YAML,
    ERR_YAML_COERCION,
    ERR_RESERVED_ATTR,
    ERR_INVALID_ORIGIN,
    // FR-017 — a M:N relationship's slim vocabulary is invalid: @through does not
    // name a junction declaring two identity.reference children, @sourceRefField
    // does not match one of them, or a M:N-only attr (@through/@sourceRefField/
    // @symmetric) is set on a non-M:N (1:N / @cardinality:one) relationship.
    ERR_INVALID_RELATIONSHIP,
    ERR_BAD_ATTR_FILTER,
    ERR_STORAGE_WITHOUT_OBJECT_REF,
    // ADR-0013: a field.object REQUIRES @objectRef (open/untyped JSON uses the
    // physical @dbColumnType: jsonb escape hatch on field.string).
    ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF,
    ERR_STORAGE_FLATTENED_ARRAY,
    ERR_INVALID_TEMPLATE,
    ERR_SOURCE_NO_PRIMARY,
    ERR_SOURCE_MULTIPLE_PRIMARY,
    // FR5c — multi-file overlay merge produced a conflicting attribute value:
    // two contributors set the same @attr to different non-empty values.
    ERR_MERGE_CONFLICT,
    // FR-016 / ADR-0018 — a source.rdb declares two or more kind-aware
    // physical-name aliases (e.g. both @table and @view). Exactly one is permitted.
    ERR_PHYSICAL_NAME_MULTIPLE,
    // FR-016 / ADR-0018 — a source.rdb declares a kind-aware physical-name alias
    // that does not match its @kind. The legacy @table-for-non-table case warns
    // rather than errors (WARN_LEGACY_PHYSICAL_NAME_ALIAS).
    ERR_PHYSICAL_NAME_KIND_MISMATCH,
    // FR-013 — field-level @readOnly cross-attribute validation (TS reference
    // commits e255c631 / 13cf4f8e). C# port has not yet shipped FR-013; codes
    // are listed here for cross-port enum parity, and the deferred fixtures
    // are tracked in conformance-expected-failures.json.
    ERR_READONLY_ASSIGNED_PRIMARY,
    ERR_READONLY_DOWNGRADE,
    // FR-015 — source.rdb @parameterRef typed-input validation (TS reference).
    // C# port has not yet shipped FR-015; the cross-port vocabulary is registered
    // here, deferred fixtures listed in conformance-expected-failures.json.
    ERR_PARAMETER_REF_UNRESOLVED,
    ERR_PARAMETER_REF_NOT_VALUE_OBJECT,
    ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND,
    ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH,
    // FR-014 — TPH discriminator cross-attribute validation (TS reference).
    // C# port has not yet shipped FR-014.
    ERR_DISCRIMINATOR_FIELD_NOT_FOUND,
    ERR_DISCRIMINATOR_VALUE_DUPLICATE,
    ERR_DISCRIMINATOR_VALUE_MISSING,
    ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
    // SP-H Unit9 — @filterable: true on a field subtype with no filter-operator
    // band (e.g. field.object). Would silently generate an empty-ops filter.
    ERR_FILTERABLE_UNSUPPORTED_SUBTYPE,
    // ADR-0023 — a registration was attempted against a registry sealed after its
    // agreed metamodel-provider bootstrap. Codegen cannot invent metamodel attrs.
    ERR_REGISTRY_SEALED,
    ERR_UNKNOWN,
}

/// <summary>
/// Stable warning codes — mirrors the TS <c>WARNING_CODES</c> taxonomy.
/// Today stored as a string until the cross-port WARN_* taxonomy lands.
/// </summary>
public static class WarningCodes
{
    /// <summary>
    /// FR5c — two contributors declared the same node identically (no semantic
    /// change). Emitted at the overlay-merge boundary.
    /// </summary>
    public const string WARN_DUPLICATE_DECLARATION = "WARN_DUPLICATE_DECLARATION";

    /// <summary>
    /// Pre-FR5c legacy: parser/validator messages still surface as plain
    /// strings; wrapped at the loader boundary into the envelope shape with
    /// this code. Retired as those sites are migrated to envelopes.
    /// </summary>
    public const string WARN_LEGACY = "WARN_LEGACY";

    /// <summary>
    /// FR-016 / ADR-0018 — a source.rdb uses the pre-1.0 legacy <c>@table</c>
    /// spelling with a non-table <c>@kind</c> (e.g. <c>@kind: "view"</c> +
    /// <c>@table: "v_x"</c>). The loader accepts the input and the canonical
    /// serializer rewrites the attr key to the kind-matching alias.
    /// </summary>
    public const string WARN_LEGACY_PHYSICAL_NAME_ALIAS = "WARN_LEGACY_PHYSICAL_NAME_ALIAS";

    /// <summary>
    /// FR-013: <c>@readOnly: true</c> on a field child of an <c>object.value</c>.
    /// Value-objects have no persistence semantics, so the read-only contract is
    /// advisory (codegen may use it for record/struct treatment).
    /// </summary>
    public const string WARN_READONLY_VALUE_OBJECT = "WARN_READONLY_VALUE_OBJECT";
}

/// <summary>
/// A collected load error. Carries the stable code the conformance runner compares.
///
/// <para>
/// FR5a / ADR-0009: <see cref="Envelope"/> is the structured provenance envelope
/// every cross-language port emits — populated by the parser (JSON tree-walk) and
/// by validation passes that have access to a node's <c>Source</c>. Legacy
/// <see cref="Source"/> / <see cref="Path"/> remain for backward-compat (the
/// conformance adapter only inspects <see cref="Code"/>); new sites should pass
/// <see cref="Envelope"/>.
/// </para>
/// </summary>
public sealed record MetaError(
    string Message,
    ErrorCode Code = ErrorCode.ERR_UNKNOWN,
    string? Source = null,
    string? Path = null,
    ErrorSource? Envelope = null);

/// <summary>Thrown for top-level structural parse failures the TS parser also throws on
/// (malformed JSON, non-object root, unknown root type). The loader catches it and
/// converts to a collected <see cref="MetaError"/>.</summary>
public sealed class ParseException : System.Exception
{
    /// <summary>The stable cross-language error code.</summary>
    public ErrorCode Code { get; }

    /// <summary>The metadata source file path or identifier (distinct from Exception.Source).</summary>
    public string? SourceFile { get; }

    /// <summary>The (canonical-JSONPath) path of the offending node.</summary>
    public string? NodePath { get; }

    /// <summary>
    /// FR5a / ADR-0009 envelope describing where the offending node came from.
    /// Always populated when the parser raises; null for legacy/synthetic callers.
    /// </summary>
    public ErrorSource? Envelope { get; }

    public ParseException(
        string message,
        ErrorCode code = ErrorCode.ERR_UNKNOWN,
        string? sourceFile = null,
        string? nodePath = null,
        ErrorSource? envelope = null) : base(message)
    {
        Code = code;
        SourceFile = sourceFile;
        NodePath = nodePath;
        Envelope = envelope;
    }
}

/// <summary>Metamodel-level error that is not a parse error — provider composition
/// failures (dependency cycle, missing dependency, attr conflict). Carries the same
/// stable <see cref="ErrorCode"/> as ParseException for cross-language conformance.</summary>
public sealed class MetaModelException(string message, ErrorCode code = ErrorCode.ERR_UNKNOWN)
    : System.Exception(message) { public ErrorCode Code => code; }
