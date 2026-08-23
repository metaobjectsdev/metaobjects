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
    // A type.subType declared with maxOccurs (e.g. identity.primary, maxOccurs:1)
    // appears more times than allowed under one parent.
    ERR_TOO_MANY_OCCURRENCES,
    ERR_PROJECTION_IDENTITY_NOT_EXTENDED,
    ERR_IDENTITY_KEY_MISMATCH,
    // FR-024 (ADR-0028): a source.* on an object.projection has a writable
    // @kind — projection sources must be read-only kinds. Vocabulary-only
    // here until FR-024 Phase E.
    ERR_PROJECTION_SOURCE_WRITABLE,
    ERR_PROJECTION_INHERITED_SOURCE,
    ERR_INVALID_SUBTYPE_CHILD,
    ERR_UNKNOWN_ATTR,
    ERR_MISSING_REQUIRED_ATTR,
    ERR_BAD_ATTR_VALUE,
    ERR_BAD_DEFAULT_SORT_FIELD,
    ERR_PROVIDER_DEPENDENCY_CYCLE,
    ERR_PROVIDER_DUPLICATE_ID,
    ERR_PROVIDER_MISSING_DEPENDENCY,
    ERR_PROVIDER_ATTR_CONFLICT,
    // ADR-0050 — a provider tried to project a REQUIRED attribute onto a type it
    // does not own (via TypeRegistry.Extend). Projection is optional-only: a
    // required attr registered this way disappears silently whenever that
    // provider is composed out, taking its validation rule with it. Declare it
    // with the type instead. This is exactly how FR-033 broke template.*'s
    // @payloadRef / @toolName (fixed by re-homing them OWN into template's own
    // provider); this guard makes the defect class unrepresentable.
    ERR_EXTEND_REQUIRED_ATTR,
    ERR_SUBTYPE_RULE_VIOLATION,
    // FR-033 — a STRUCTURAL child (field/identity/source/validator/… — not an attr)
    // is placed under a parent whose registered childRules do not admit it (the
    // structural analogue of ERR_UNKNOWN_ATTR). Strict-load only; a no-op under
    // wildcard childRules. Misplaced attrs keep the ERR_UNKNOWN_ATTR path.
    ERR_CHILD_NOT_ALLOWED,
    ERR_OVERLAY_NO_TARGET,
    ERR_MALFORMED_YAML,
    ERR_YAML_COERCION,
    ERR_RESERVED_ATTR,
    // FR-032 (ADR-0032) — a ref-bearing value in canonical JSON used a relative
    // form (leading "::" or "..::"). Relative refs are YAML-authoring sugar the
    // desugar expands; they must never appear in canonical (interchange) JSON.
    ERR_RELATIVE_REF_IN_CANONICAL,
    ERR_INVALID_ORIGIN,
    // FR-024 (ADR-0029) — origin @via inference + cardinality checks. Vocabulary-only
    // here until FR-024 Phase E (the C# loader does not run the inference yet):
    // ERR_AMBIGUOUS_PATH — an implicit (omitted-@via) origin path is ambiguous
    // (multiple single-hop relationships to the @from/@of entity, or a projection's
    // base entity underivable without an extended identity);
    // ERR_ORIGIN_CARDINALITY — passthrough @via crosses a to-many hop (you meant
    // aggregate) or aggregate @via is to-one at every hop (you meant passthrough).
    ERR_AMBIGUOUS_PATH,
    ERR_ORIGIN_CARDINALITY,
    // FR-024 B6 — extends/origin agreement + derived-field providability. Vocabulary-
    // only here until FR-024 Phase E (the C# loader does not run these checks yet):
    // ERR_EXTENDS_ORIGIN_MISMATCH — a field's entity-nested extends (shape lineage)
    // disagrees with its origin.passthrough @from (data lineage); host-agnostic,
    // aggregates and top-level abstract extends targets never judged.
    // ERR_DERIVED_FIELD_NO_READ_SOURCE — an object.entity field carrying an origin.*
    // is derived and the entity declares no read-only-kind source to provide it
    // (projections and object.value hosts exempt).
    ERR_EXTENDS_ORIGIN_MISMATCH,
    ERR_DERIVED_FIELD_NO_READ_SOURCE,
    // #185 — origin.passthrough is type-preserving: a field forwarding another
    // field's value via origin.passthrough must declare the SAME field.<subType>
    // and array-ness as its resolved @from source (RESOLVING/effective, ADR-0039).
    // Nullability is NOT judged. Escape hatch: @convert: true acknowledges a
    // deliberate type change (acknowledgement only — no generated cast). This
    // UNIVERSAL check replaces the retired narrow ERR_PARAMETER_REF_PASSTHROUGH_
    // TYPE_MISMATCH (it also covers FR-015 parameter-ref value objects + array-ness).
    ERR_PASSTHROUGH_TYPE_MISMATCH,
    // #195 — the two dedicated origin-capability codes (all other #195 origin rules
    // emit ERR_INVALID_ORIGIN). Mirrors fixtures/conformance/ERROR-CODES.json.
    // ERR_COMPUTED_TYPE_MISMATCH — an origin.computed @expr tree's inferred root type
    // does not equal the carrying field's declared field.<subType> (a computed column's
    // type is DERIVED from its expression, never asserted; no @convert escape). Sibling
    // of ERR_PASSTHROUGH_TYPE_MISMATCH.
    // ERR_UNKNOWN_EXPR_NODE — an origin.computed @expr tree contains a node whose
    // kind/op/fn is outside the closed expression grammar (field/value refs, comparisons
    // sharing the filter op vocabulary, isNull/isNotNull, and/or/not, coalesce).
    // Fail-closed per ADR-0023.
    ERR_COMPUTED_TYPE_MISMATCH,
    ERR_UNKNOWN_EXPR_NODE,

    // FR-024 (ADR-0028) hard cutover: an entity's PRIMARY source has a read-only @kind —
    // read-only kinds only in non-primary roles; a derived read model is an object.projection.
    // Vocabulary-only here until Phase-E validation parity.
    ERR_ENTITY_PRIMARY_SOURCE_READONLY,
    // FR-017 — a M:N relationship's slim vocabulary is invalid: @through does not
    // name a junction declaring two identity.reference children, @sourceRefField
    // does not match one of them, or a M:N-only attr (@through/@sourceRefField/
    // @symmetric) is set on a non-M:N (1:N / @cardinality:one) relationship.
    ERR_INVALID_RELATIONSHIP,
    // identity.reference @references names an FK target object that does not resolve
    // to any object in the loaded tree (a dangling cross-reference between metadata).
    ERR_INVALID_REFERENCE,
    // ADR-0042 — a field.object / field.map @objectRef does not resolve to any object in
    // the loaded tree (a dangling target). Bare refs resolve package-locally (referrer's
    // package, else root-level); FQN refs resolve exactly — a bare cross-package ref no
    // longer binds elsewhere. (ERR_AMBIGUOUS_REF is RETIRED: with bare = package-local,
    // cross-package ambiguity is unreachable.)
    ERR_UNRESOLVED_OBJECT_REF,
    ERR_BAD_ATTR_FILTER,
    ERR_STORAGE_WITHOUT_OBJECT_REF,
    // ADR-0013: a field.object REQUIRES @objectRef (open/untyped JSON uses the
    // physical @dbColumnType: jsonb escape hatch on field.string).
    ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF,
    ERR_STORAGE_FLATTENED_ARRAY,
    ERR_INVALID_TEMPLATE,
    ERR_SOURCE_NO_PRIMARY,
    ERR_SOURCE_MULTIPLE_PRIMARY,
    // Phase-1 metadata-source-resolution: a path source declared in .metaobjects/config.json does not exist on disk.
    ERR_SOURCE_UNRESOLVED,
    // Phase-1 metadata-source-resolution: a declared source kind (resource or package) is not supported by this toolchain.
    ERR_SOURCE_KIND_UNSUPPORTED,
    // Phase-1 metadata-source-resolution: a scope include/exclude package pattern is malformed (empty pattern or empty :: segment).
    ERR_SCOPE_PATTERN_INVALID,
    // Phase-1 metadata-source-resolution: no metadata collection was discovered — no config declaring sources, and no default metaobjects/ directory.
    ERR_COLLECTION_NOT_FOUND,
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
    ERR_MUTABILITY_AUTOSET_CONFLICT,
    ERR_MUTABILITY_DOWNGRADE,
    ERR_READONLY_ASSIGNED_PRIMARY,
    // FR-015 — source.rdb @parameterRef typed-input validation (TS reference).
    // C# port has not yet shipped FR-015; the cross-port vocabulary is registered
    // here, deferred fixtures listed in conformance-expected-failures.json.
    ERR_PARAMETER_REF_UNRESOLVED,
    ERR_PARAMETER_REF_NOT_VALUE_OBJECT,
    ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND,
    // ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH (retired #185): the narrow,
    // subtype-only parameter-ref passthrough-type check was generalized into the
    // universal ERR_PASSTHROUGH_TYPE_MISMATCH (above), which runs over every
    // object — including these parameter-ref value objects — and also gates
    // array-ness and honours the @convert opt-out.
    // FR-014 — TPH discriminator cross-attribute validation (TS reference).
    // C# port has not yet shipped FR-014.
    ERR_DISCRIMINATOR_FIELD_NOT_FOUND,
    ERR_DISCRIMINATOR_VALUE_DUPLICATE,
    ERR_DISCRIMINATOR_VALUE_MISSING,
    ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH,
    // SP-H Unit9 — @filterable: true on a field subtype with no filter-operator
    // band (e.g. field.object). Would silently generate an empty-ops filter.
    ERR_FILTERABLE_UNSUPPORTED_SUBTYPE,
    // #335 Half B — @sortable: true on an array field or a subtype with no
    // filter-operator band (e.g. field.object). Would silently emit a sort
    // entry over a column no dialect can ORDER BY.
    ERR_SORTABLE_UNSUPPORTED_SUBTYPE,
    // Index-key resolution for index.lookup AND identity.secondary (#342) — the key is
    // @fields XOR @expr: neither declared, BOTH declared (@expr is used INSTEAD of
    // @fields), whichever is declared supplies no key, or a named field does not exist
    // in the entity's effective field set.
    ERR_INVALID_INDEX,
    // ADR-0023 — a registration was attempted against a registry sealed after its
    // agreed metamodel-provider bootstrap. Codegen cannot invent metamodel attrs.
    ERR_REGISTRY_SEALED,
    // #208 — DDL-ownership escape valves (@sql / @unmanaged on source.rdb).
    // ERR_SQL_BODY_WITH_UNMANAGED — @sql AND @unmanaged declared on the SAME source
    // (R1): mutually exclusive non-default states of one DDL-ownership axis.
    // ERR_SQL_BODY_ON_WRITABLE_KIND — @sql declared on a writable @kind ("table",
    // the default) (R2): @sql is legal only on a read-only kind.
    // ERR_ORIGIN_UNDER_SQL_BODY — an origin.*-bearing (derived) own field under an
    // @sql host (R4), or an object.projection @filter (#207) combined with an @sql
    // host (R5): the synthesized derivation/filter and the author's verbatim SQL
    // are two sources of truth for the same body.
    ERR_SQL_BODY_WITH_UNMANAGED,
    ERR_SQL_BODY_ON_WRITABLE_KIND,
    ERR_ORIGIN_UNDER_SQL_BODY,
    // #246 — a field.enum both extends a shared package-level abstract enum and
    // declares its own @values. One shared enum type has one member set — the
    // own @values would be silently dropped in codegen. Remove the own @values
    // to inherit the shared set, or extend a concrete (non-shared) enum instead.
    ERR_ENUM_EXTENDS_VALUES_CONFLICT,
    // A field.enum carries @intValueMap together with isArray=true. Int-backing is
    // a persistence-layer codec and no port implements it element-wise over an
    // array column, so the combination would silently persist member SYMBOLS into
    // an integer array. An array-of-enum stays string-backed: drop @intValueMap,
    // or make the field scalar.
    ERR_ENUM_INT_VALUE_MAP_ARRAY,
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
    public const string WARN_MUTABILITY_VALUE_OBJECT = "WARN_MUTABILITY_VALUE_OBJECT";
    public const string WARN_MUTABILITY_READONLY_HOST = "WARN_MUTABILITY_READONLY_HOST";

    /// <summary>
    /// #208 (R6) — an origin.*-bearing (derived) own field sits under a host object
    /// whose source.rdb is marked <c>@unmanaged</c>. <c>@unmanaged</c> acts on nothing
    /// (the tool never touches this object's DDL), so a documented-but-unacted-on
    /// derivation is benign — informational, not an error. <c>@sql</c> (R4, hard
    /// error) takes priority over this warning when a host declares both markers
    /// across different sources.
    /// </summary>
    public const string WARN_ORIGIN_UNDER_UNMANAGED = "WARN_ORIGIN_UNDER_UNMANAGED";

    /// <summary>
    /// A field.enum whose @values contains a member equal to the concatenation of two or
    /// more OTHER members once <c>strip</c>-normalized (the default mode erases separators).
    /// A delimited value then collapses into that member and coerces SUCCESSFULLY — reported
    /// EXTRACTED with a wrong-but-valid value rather than MALFORMED. Advisory: such a
    /// vocabulary is legal and unambiguous for exact matching; <c>@normalize: collapse</c>
    /// is the fix when delimited input is possible.
    /// </summary>
    public const string WARN_ENUM_NORMALIZE_AMBIGUOUS = "WARN_ENUM_NORMALIZE_AMBIGUOUS";
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
