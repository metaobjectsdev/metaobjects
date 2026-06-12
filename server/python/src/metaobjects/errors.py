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
    ERR_MISSING_SUBTYPE = "ERR_MISSING_SUBTYPE"
    ERR_DUPLICATE_NAME = "ERR_DUPLICATE_NAME"
    ERR_UNRESOLVED_SUPER = "ERR_UNRESOLVED_SUPER"
    # FR-024 (ADR-0029): a dotted extends ref resolved to a node whose type or
    # subtype does not match the extending node.
    ERR_EXTENDS_TARGET_MISMATCH = "ERR_EXTENDS_TARGET_MISMATCH"
    ERR_INVALID_SUBTYPE_CHILD = "ERR_INVALID_SUBTYPE_CHILD"
    ERR_UNKNOWN_ATTR = "ERR_UNKNOWN_ATTR"
    ERR_MISSING_REQUIRED_ATTR = "ERR_MISSING_REQUIRED_ATTR"
    ERR_BAD_ATTR_VALUE = "ERR_BAD_ATTR_VALUE"
    ERR_BAD_DEFAULT_SORT_FIELD = "ERR_BAD_DEFAULT_SORT_FIELD"
    ERR_PROVIDER_DEPENDENCY_CYCLE = "ERR_PROVIDER_DEPENDENCY_CYCLE"
    ERR_PROVIDER_DUPLICATE_ID = "ERR_PROVIDER_DUPLICATE_ID"
    ERR_PROVIDER_MISSING_DEPENDENCY = "ERR_PROVIDER_MISSING_DEPENDENCY"
    ERR_PROVIDER_ATTR_CONFLICT = "ERR_PROVIDER_ATTR_CONFLICT"
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
    # FR-017 — M:N relationship slim-vocabulary validation (junction-missing-two-
    # references / sourceRefField-not-matching / M:N-attr-on-1:N). The symmetric-
    # on-hetero + symmetric+sourceRefField rules emit ERR_BAD_ATTR_VALUE instead.
    ERR_INVALID_RELATIONSHIP = "ERR_INVALID_RELATIONSHIP"
    ERR_BAD_ATTR_FILTER = "ERR_BAD_ATTR_FILTER"
    # Reserved structural body key authored as an @-attr (source-v2 / ADR-0007).
    ERR_RESERVED_ATTR = "ERR_RESERVED_ATTR"
    # Source-v2 multi-source one-primary rule (ADR-0007).
    ERR_SOURCE_NO_PRIMARY = "ERR_SOURCE_NO_PRIMARY"
    ERR_SOURCE_MULTIPLE_PRIMARY = "ERR_SOURCE_MULTIPLE_PRIMARY"
    # FR-016 / ADR-0018 — per-kind physical-name aliases on source.rdb.
    ERR_PHYSICAL_NAME_KIND_MISMATCH = "ERR_PHYSICAL_NAME_KIND_MISMATCH"
    ERR_PHYSICAL_NAME_MULTIPLE = "ERR_PHYSICAL_NAME_MULTIPLE"
    # FR-013 — field-level @readOnly cross-attribute rules. Cross-language
    # vocabulary; Python loader does not emit these yet (FR-013 Python fan-out
    # is a separate workstream), but the enum tracks the shared corpus codes.
    ERR_READONLY_ASSIGNED_PRIMARY = "ERR_READONLY_ASSIGNED_PRIMARY"
    ERR_READONLY_DOWNGRADE = "ERR_READONLY_DOWNGRADE"
    # FR-015 — source.rdb @parameterRef typed-input validation. Cross-language
    # vocabulary; Python loader does not emit these yet, but the enum tracks
    # the shared corpus codes.
    ERR_PARAMETER_REF_UNRESOLVED = "ERR_PARAMETER_REF_UNRESOLVED"
    ERR_PARAMETER_REF_NOT_VALUE_OBJECT = "ERR_PARAMETER_REF_NOT_VALUE_OBJECT"
    ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND = "ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND"
    ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH = "ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH"
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
    ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING"
    # SP-H Unit9 — @filterable: true on a field subtype with no filter-operator
    # band (e.g. field.object). Would silently generate an empty-ops filter.
    ERR_FILTERABLE_UNSUPPORTED_SUBTYPE = "ERR_FILTERABLE_UNSUPPORTED_SUBTYPE"
    # ADR-0023 — a registration was attempted against a registry sealed after its
    # agreed metamodel-provider bootstrap. Codegen cannot invent metamodel attrs.
    ERR_REGISTRY_SEALED = "ERR_REGISTRY_SEALED"
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
