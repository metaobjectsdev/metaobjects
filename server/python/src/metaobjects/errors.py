"""Stable error/warning vocabulary. Codes (not messages) are the conformance contract."""
from __future__ import annotations

from enum import Enum
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # avoid runtime import cycles
    from .source import ErrorSource


class ErrorCode(str, Enum):
    ERR_MALFORMED_JSON = "ERR_MALFORMED_JSON"
    ERR_TOP_LEVEL_NOT_OBJECT = "ERR_TOP_LEVEL_NOT_OBJECT"
    ERR_UNKNOWN_TYPE = "ERR_UNKNOWN_TYPE"
    ERR_UNKNOWN_SUBTYPE = "ERR_UNKNOWN_SUBTYPE"
    # A document AUTHORS a `<type>.base` node. Every registered `base` subtype is an
    # abstract registry anchor — the shared root concrete subtypes inherit from, with no
    # runtime semantics of its own (spec/metamodel/object.json: "not authored directly").
    # The JVM enforced this by accident (its impl classes are abstract, so instantiation
    # fails); TypeScript, C# and Python accepted it, so one document loaded on three ports
    # and failed on two.
    ERR_ABSTRACT_SUBTYPE_AUTHORED = "ERR_ABSTRACT_SUBTYPE_AUTHORED"
    ERR_MISSING_SUBTYPE = "ERR_MISSING_SUBTYPE"
    ERR_DUPLICATE_NAME = "ERR_DUPLICATE_NAME"
    ERR_UNRESOLVED_SUPER = "ERR_UNRESOLVED_SUPER"
    # FR-024 (ADR-0029): a dotted extends ref resolved to a node whose type or
    # subtype does not match the extending node.
    ERR_EXTENDS_TARGET_MISMATCH = "ERR_EXTENDS_TARGET_MISMATCH"
    # FR-024: identity names required + projection identity pass-through.
    # Vocabulary-only here until FR-024 Phase E (the Python loader does not
    # enforce these yet); the enum tracks the shared corpus codes.
    ERR_IDENTITY_NAME_REQUIRED = "ERR_IDENTITY_NAME_REQUIRED"
    # A type.subType declared with maxOccurs (e.g. identity.primary) appears more than allowed under one parent.
    ERR_TOO_MANY_OCCURRENCES = "ERR_TOO_MANY_OCCURRENCES"
    ERR_PROJECTION_IDENTITY_NOT_EXTENDED = "ERR_PROJECTION_IDENTITY_NOT_EXTENDED"
    ERR_IDENTITY_KEY_MISMATCH = "ERR_IDENTITY_KEY_MISMATCH"
    # FR-024 (ADR-0028): a source.* on an object.projection has a writable
    # @kind — projection sources must be read-only kinds. Vocabulary-only
    # here until FR-024 Phase E.
    ERR_PROJECTION_SOURCE_WRITABLE = "ERR_PROJECTION_SOURCE_WRITABLE"
    ERR_PROJECTION_INHERITED_SOURCE = "ERR_PROJECTION_INHERITED_SOURCE"
    ERR_INVALID_SUBTYPE_CHILD = "ERR_INVALID_SUBTYPE_CHILD"
    ERR_UNKNOWN_ATTR = "ERR_UNKNOWN_ATTR"
    ERR_MISSING_REQUIRED_ATTR = "ERR_MISSING_REQUIRED_ATTR"
    ERR_BAD_ATTR_VALUE = "ERR_BAD_ATTR_VALUE"
    ERR_BAD_DEFAULT_SORT_FIELD = "ERR_BAD_DEFAULT_SORT_FIELD"
    ERR_PROVIDER_DEPENDENCY_CYCLE = "ERR_PROVIDER_DEPENDENCY_CYCLE"
    ERR_PROVIDER_DUPLICATE_ID = "ERR_PROVIDER_DUPLICATE_ID"
    ERR_PROVIDER_MISSING_DEPENDENCY = "ERR_PROVIDER_MISSING_DEPENDENCY"
    ERR_PROVIDER_ATTR_CONFLICT = "ERR_PROVIDER_ATTR_CONFLICT"
    # ADR-0050: a provider tried to PROJECT a REQUIRED attribute onto a type it does
    # not own (via TypeRegistry.extend). Projection is optional-only — a required
    # attr registered this way disappears silently whenever that provider is
    # composed out, taking its required-attr validation rule with it. This is
    # exactly how FR-033 broke template.*'s @payloadRef/@toolName in all five
    # ports. If an attr is genuinely required it is OWN: declare it with the type,
    # in the type's own provider.
    ERR_EXTEND_REQUIRED_ATTR = "ERR_EXTEND_REQUIRED_ATTR"
    ERR_SUBTYPE_RULE_VIOLATION = "ERR_SUBTYPE_RULE_VIOLATION"
    ERR_OVERLAY_NO_TARGET = "ERR_OVERLAY_NO_TARGET"
    # FR5c — two contributing files set the same @attr to different non-empty
    # values on the same node. Carries a `MergedSource` envelope with both
    # contributors listed (ADR-0009 §Overlay-merge).
    ERR_MERGE_CONFLICT = "ERR_MERGE_CONFLICT"
    ERR_MALFORMED_YAML = "ERR_MALFORMED_YAML"
    # YAML 1.2 silently coerced an unquoted scalar to a type incompatible with the
    # declared attr valueType (ADR-0006 D2). Authors should quote the value.
    ERR_YAML_COERCION = "ERR_YAML_COERCION"
    ERR_INVALID_ORIGIN = "ERR_INVALID_ORIGIN"
    # FR-024 (ADR-0029) — origin @via inference + cardinality checks. Vocabulary-only
    # here until FR-024 Phase E (the Python loader does not run the inference yet):
    # ERR_AMBIGUOUS_PATH — an implicit (omitted-@via) origin path is ambiguous
    # (multiple single-hop relationships to the @from/@of entity, or a projection's
    # base entity underivable without an extended identity); ERR_ORIGIN_CARDINALITY —
    # passthrough @via crosses a to-many hop (you meant aggregate) or aggregate @via
    # is to-one at every hop (you meant passthrough).
    ERR_AMBIGUOUS_PATH = "ERR_AMBIGUOUS_PATH"
    ERR_ORIGIN_CARDINALITY = "ERR_ORIGIN_CARDINALITY"
    # #195 — origin.computed @expr validation. ERR_UNKNOWN_EXPR_NODE: the expression
    # tree contains a node whose kind/op/fn is not in the closed grammar (fail-closed
    # per ADR-0023). ERR_COMPUTED_TYPE_MISMATCH: the @expr tree's inferred root type
    # does not equal the carrying field's declared field.<subType> (a computed column's
    # type is DERIVED from its expression, never asserted — no @convert escape).
    ERR_UNKNOWN_EXPR_NODE = "ERR_UNKNOWN_EXPR_NODE"
    ERR_COMPUTED_TYPE_MISMATCH = "ERR_COMPUTED_TYPE_MISMATCH"
    # FR-024 B6 — extends/origin agreement + derived-field providability. Vocabulary-
    # only here until FR-024 Phase E (the Python loader does not run these checks yet):
    # ERR_EXTENDS_ORIGIN_MISMATCH — a field's entity-nested extends (shape lineage)
    # disagrees with its origin.passthrough @from (data lineage); host-agnostic,
    # aggregates and top-level abstract extends targets never judged.
    # ERR_DERIVED_FIELD_NO_READ_SOURCE — an object.entity field carrying an origin.*
    # is derived and the entity declares no read-only-kind source to provide it
    # (projections and object.value hosts exempt).
    ERR_EXTENDS_ORIGIN_MISMATCH = "ERR_EXTENDS_ORIGIN_MISMATCH"
    ERR_DERIVED_FIELD_NO_READ_SOURCE = "ERR_DERIVED_FIELD_NO_READ_SOURCE"
    # FR-024 (ADR-0028) hard cutover: an entity's PRIMARY source has a read-only @kind —
    # read-only kinds only in non-primary roles; a derived read model is an object.projection.
    # Vocabulary-only here until Phase-E validation parity.
    ERR_ENTITY_PRIMARY_SOURCE_READONLY = "ERR_ENTITY_PRIMARY_SOURCE_READONLY"
    # FR-017 — M:N relationship slim-vocabulary validation (junction-missing-two-
    # references / sourceRefField-not-matching / M:N-attr-on-1:N). The symmetric-
    # on-hetero + symmetric+sourceRefField rules emit ERR_BAD_ATTR_VALUE instead.
    ERR_INVALID_INDEX = "ERR_INVALID_INDEX"
    # FR-039 -- @status: retired declares @implementedBy. Refused rather than exempted:
    # a retired capability has no implementation BY DEFINITION, so forbidding the
    # attribute makes the dangling-reference class unreachable instead of tolerated.
    ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS = "ERR_REQUIREMENT_RETIRED_HAS_IMPLEMENTORS"
    # FR-039 -- @supersededBy on a requirement whose @status is not `retired`.
    ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED = "ERR_REQUIREMENT_SUPERSEDED_BY_NOT_RETIRED"
    ERR_INVALID_RELATIONSHIP = "ERR_INVALID_RELATIONSHIP"
    # identity.reference @references names an FK target object that does not resolve
    # to any object in the loaded tree (a dangling cross-reference between metadata).
    ERR_INVALID_REFERENCE = "ERR_INVALID_REFERENCE"
    ERR_BAD_ATTR_FILTER = "ERR_BAD_ATTR_FILTER"
    # Reserved structural body key authored as an @-attr (source-v2 / ADR-0007).
    ERR_RESERVED_ATTR = "ERR_RESERVED_ATTR"
    # Source-v2 multi-source one-primary rule (ADR-0007).
    ERR_SOURCE_NO_PRIMARY = "ERR_SOURCE_NO_PRIMARY"
    ERR_SOURCE_MULTIPLE_PRIMARY = "ERR_SOURCE_MULTIPLE_PRIMARY"
    # Phase-1 metadata-source-resolution — a path source declared in .metaobjects/config.json does not exist on disk.
    ERR_SOURCE_UNRESOLVED = "ERR_SOURCE_UNRESOLVED"
    # Phase-1 metadata-source-resolution — a declared source kind (resource or package) is not supported by this toolchain.
    ERR_SOURCE_KIND_UNSUPPORTED = "ERR_SOURCE_KIND_UNSUPPORTED"
    # Phase-1 metadata-source-resolution — a scope include/exclude package pattern is malformed (empty pattern or empty :: segment).
    ERR_SCOPE_PATTERN_INVALID = "ERR_SCOPE_PATTERN_INVALID"
    # Phase-1 metadata-source-resolution — no metadata collection was discovered: no config declaring sources, and no default metaobjects/ directory.
    ERR_COLLECTION_NOT_FOUND = "ERR_COLLECTION_NOT_FOUND"
    # FR-016 / ADR-0018 — per-kind physical-name aliases on source.rdb.
    ERR_PHYSICAL_NAME_KIND_MISMATCH = "ERR_PHYSICAL_NAME_KIND_MISMATCH"
    ERR_PHYSICAL_NAME_MULTIPLE = "ERR_PHYSICAL_NAME_MULTIPLE"
    # FR-037 R1 — field-level @mutability cross-attribute rules.
    ERR_MUTABILITY_AUTOSET_CONFLICT = "ERR_MUTABILITY_AUTOSET_CONFLICT"
    ERR_MUTABILITY_DOWNGRADE = "ERR_MUTABILITY_DOWNGRADE"
    ERR_READONLY_ASSIGNED_PRIMARY = "ERR_READONLY_ASSIGNED_PRIMARY"
    # FR-015 — source.rdb @parameterRef typed-input validation. Cross-language
    # vocabulary; Python loader does not emit these yet, but the enum tracks
    # the shared corpus codes.
    ERR_PARAMETER_REF_UNRESOLVED = "ERR_PARAMETER_REF_UNRESOLVED"
    ERR_PARAMETER_REF_NOT_VALUE_OBJECT = "ERR_PARAMETER_REF_NOT_VALUE_OBJECT"
    ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND = "ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND"
    # #185 — a field forwarding another field's value via origin.passthrough must
    # declare the SAME field.<subType> and array-ness as its resolved @from source
    # (a passthrough forwards the value unchanged). A differing subType or array-ness
    # → this error, unless @convert: true acknowledges a deliberate type change. This
    # GENERALIZES and RETIRES the FR-015-narrow ERR_PARAMETER_REF_PASSTHROUGH_TYPE_
    # MISMATCH (the origin-paths pass runs over every object, value hosts included).
    ERR_PASSTHROUGH_TYPE_MISMATCH = "ERR_PASSTHROUGH_TYPE_MISMATCH"
    # FR-014 — TPH discriminator cross-attribute validation. Cross-language
    # vocabulary; Python loader does not emit these yet.
    ERR_DISCRIMINATOR_FIELD_NOT_FOUND = "ERR_DISCRIMINATOR_FIELD_NOT_FOUND"
    ERR_DISCRIMINATOR_VALUE_DUPLICATE = "ERR_DISCRIMINATOR_VALUE_DUPLICATE"
    ERR_DISCRIMINATOR_VALUE_MISSING = "ERR_DISCRIMINATOR_VALUE_MISSING"
    ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH = "ERR_DISCRIMINATOR_VALUE_TYPE_MISMATCH"
    # Cross-language vocabulary for features other ports added (FR-003 storage, FR-004 template);
    # the Python loader does not emit these yet, but the enum tracks the shared corpus codes.
    ERR_INVALID_TEMPLATE = "ERR_INVALID_TEMPLATE"
    ERR_STORAGE_FLATTENED_ARRAY = "ERR_STORAGE_FLATTENED_ARRAY"
    ERR_STORAGE_WITHOUT_OBJECT_REF = "ERR_STORAGE_WITHOUT_OBJECT_REF"
    # ADR-0013: a field.object REQUIRES @objectRef (open/untyped JSON uses the
    # physical @dbColumnType: jsonb escape hatch on field.string).
    ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF = "ERR_OBJECT_FIELD_WITHOUT_OBJECT_REF"
    ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED"
    ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED"
    ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD"
    # Codegen (ADR-0044): two value-object FQNs in one payload artifact derive the same
    # emitted record name even after package-qualification. Peer of ERR_VAR_NOT_ON_PAYLOAD.
    ERR_PAYLOAD_NAME_COLLISION = "ERR_PAYLOAD_NAME_COLLISION"
    ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING"
    # SP-H Unit9 — @filterable: true on a field subtype with no filter-operator
    # band (e.g. field.object). Would silently generate an empty-ops filter.
    ERR_FILTERABLE_UNSUPPORTED_SUBTYPE = "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE"
    # #335 Half B — @sortable: true on an array field or a subtype with no
    # filter-operator band (e.g. field.object). Would silently emit a sort
    # entry over a column no dialect can ORDER BY.
    ERR_SORTABLE_UNSUPPORTED_SUBTYPE = "ERR_SORTABLE_UNSUPPORTED_SUBTYPE"
    # #335 Half A — a whole-object @agg:collect (no @of; the carrying field.object
    # rolls related rows up as its declared @objectRef value object) is malformed:
    # carrier is not a field.object with @objectRef, @via absent, @distinct declared
    # (refused — a no-op whenever the value object carries the primary key), an
    # @orderBy key not on the @via TERMINAL entity, or a member's declared type
    # disagreeing with the matched terminal field's. Distinct from ERR_INVALID_ORIGIN
    # so a fixture can tell this arm from a loader that still requires @of.
    ERR_COLLECT_WHOLE_OBJECT = "ERR_COLLECT_WHOLE_OBJECT"
    # #335 Half A — a whole-object @agg:collect's value-object member has no
    # matching field (by name) on the @via terminal entity. The lowering
    # projects exactly the declared members; failing open here is how #270
    # turned a curated value object into the full entity.
    ERR_COLLECT_MEMBER_UNRESOLVED = "ERR_COLLECT_MEMBER_UNRESOLVED"
    # ADR-0023 — a registration was attempted against a registry sealed after its
    # agreed metamodel-provider bootstrap. Codegen cannot invent metamodel attrs.
    ERR_REGISTRY_SEALED = "ERR_REGISTRY_SEALED"
    # FR-032 (ADR-0032) — a relative (``::``/``..::``) reference survived into
    # canonical JSON (canonical JSON must be FQN-only). The Python loader does not
    # emit this yet (the T6 guard is deferred — like TS, it belongs in the parser);
    # the enum tracks the shared corpus code so resolution/desugar stay aligned.
    ERR_RELATIVE_REF_IN_CANONICAL = "ERR_RELATIVE_REF_IN_CANONICAL"
    # ADR-0042 — a field.object / field.map @objectRef does not resolve to any
    # object in the loaded tree (a dangling target). Bare refs resolve
    # package-locally (referrer's package, else root-level); FQN refs resolve
    # exactly — a bare cross-package ref no longer binds elsewhere. Supersedes the
    # retired ADR-0041 ERR_AMBIGUOUS_REF (bare = package-local ⇒ ambiguity is
    # unreachable, so every unresolved ref fails closed with its per-attr code).
    ERR_UNRESOLVED_OBJECT_REF = "ERR_UNRESOLVED_OBJECT_REF"
    # FR-033 — strict structural-placement vocabulary. ERR_CHILD_NOT_ALLOWED: a
    # structural child (field/identity/source/validator/… — not an attr) is placed
    # under a parent whose registered childRules do not admit it (the structural
    # analogue of ERR_UNKNOWN_ATTR; strict-load only). ERR_INVALID_METAMODEL_
    # CONSTRAINT: a provider set's merged constraint graph contains a contradiction
    # (dangling/unsatisfiable/bad-cardinality/closed-set-clash/cycle/attr conflict).
    # Cross-language vocabulary; the Python loader does not emit these yet, but the
    # enum tracks the shared corpus codes (S-B2 manifest scoping tightens placement;
    # the validate()-time structural enforcement is the next sub-step).
    ERR_CHILD_NOT_ALLOWED = "ERR_CHILD_NOT_ALLOWED"
    ERR_INVALID_METAMODEL_CONSTRAINT = "ERR_INVALID_METAMODEL_CONSTRAINT"
    # #208 — DDL-ownership escape valves (source.rdb @sql / @unmanaged).
    # ERR_SQL_BODY_WITH_UNMANAGED: @sql AND @unmanaged declared on the SAME
    # source — the two mutually exclusive non-default DDL-ownership states.
    # ERR_SQL_BODY_ON_WRITABLE_KIND: @sql set on a writable @kind ("table", the
    # default) — @sql is legal only on a read-only kind; a writable table is
    # either fully modeled or @unmanaged, never opaque-bodied.
    # ERR_ORIGIN_UNDER_SQL_BODY: an origin.*-bearing (derived) own field, or an
    # object.projection @filter (#207), under an @sql host — two sources of
    # truth for the same body. (R6's WARN_ORIGIN_UNDER_UNMANAGED sibling — an
    # origin.*-bearing field under an @unmanaged host — is a warning, not an
    # error code; it lives in the envelope-warnings channel.)
    ERR_SQL_BODY_WITH_UNMANAGED = "ERR_SQL_BODY_WITH_UNMANAGED"
    ERR_SQL_BODY_ON_WRITABLE_KIND = "ERR_SQL_BODY_ON_WRITABLE_KIND"
    ERR_ORIGIN_UNDER_SQL_BODY = "ERR_ORIGIN_UNDER_SQL_BODY"
    # #246 — a field.enum both extends a shared package-level abstract enum and
    # declares its own @values. One shared enum type has one member set — the
    # own @values would be silently dropped in codegen. Remove the own @values
    # to inherit the shared set, or extend a concrete (non-shared) enum instead.
    ERR_ENUM_EXTENDS_VALUES_CONFLICT = "ERR_ENUM_EXTENDS_VALUES_CONFLICT"
    # A field.enum carries @intValueMap together with isArray=true. Int-backing is
    # a persistence-layer codec and no port implements it element-wise over an
    # array column, so the combination would silently persist member SYMBOLS into
    # an integer array. An array-of-enum stays string-backed: drop @intValueMap,
    # or make the field scalar.
    ERR_ENUM_INT_VALUE_MAP_ARRAY = "ERR_ENUM_INT_VALUE_MAP_ARRAY"
    ERR_UNKNOWN = "ERR_UNKNOWN"


class MetaError:
    """A loader error. ``code`` is the conformance-compared value; ``message`` is human text.

    FR5a / ADR-0009: ``envelope`` is the structured provenance envelope every
    cross-language port emits — populated by the parser (JSON tree-walk) and by
    validation passes that have access to a node's ``source``. Legacy ``source``
    (the file path) / ``path`` remain for backward-compat (the conformance
    adapter only inspects ``code``); new sites should pass ``envelope``.
    """

    def __init__(
        self,
        message: str,
        code: ErrorCode = ErrorCode.ERR_UNKNOWN,
        source: str | None = None,
        path: str | None = None,
        envelope: Optional[ErrorSource] = None,
    ) -> None:
        self.message = message
        self.code = code
        self.source = source
        self.path = path
        self.envelope = envelope

    def __repr__(self) -> str:
        return f"MetaError({self.code.name}: {self.message!r})"


class ParseError(Exception):
    """Raised by the parser in strict mode; carries a code."""

    def __init__(self, message: str, code: ErrorCode = ErrorCode.ERR_UNKNOWN) -> None:
        super().__init__(message)
        self.code = code
