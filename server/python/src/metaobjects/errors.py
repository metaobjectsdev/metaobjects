"""Stable error/warning vocabulary. Codes (not messages) are the conformance contract."""
from __future__ import annotations

from enum import Enum


class ErrorCode(str, Enum):
    ERR_MALFORMED_JSON = "ERR_MALFORMED_JSON"
    ERR_TOP_LEVEL_NOT_OBJECT = "ERR_TOP_LEVEL_NOT_OBJECT"
    ERR_UNKNOWN_TYPE = "ERR_UNKNOWN_TYPE"
    ERR_UNKNOWN_SUBTYPE = "ERR_UNKNOWN_SUBTYPE"
    ERR_MISSING_SUBTYPE = "ERR_MISSING_SUBTYPE"
    ERR_DUPLICATE_NAME = "ERR_DUPLICATE_NAME"
    ERR_UNRESOLVED_SUPER = "ERR_UNRESOLVED_SUPER"
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
    ERR_MALFORMED_YAML = "ERR_MALFORMED_YAML"
    ERR_INVALID_ORIGIN = "ERR_INVALID_ORIGIN"
    ERR_BAD_ATTR_FILTER = "ERR_BAD_ATTR_FILTER"
    # Reserved structural body key authored as an @-attr (source-v2 / ADR-0007).
    ERR_RESERVED_ATTR = "ERR_RESERVED_ATTR"
    # Source-v2 multi-source one-primary rule (ADR-0007).
    ERR_SOURCE_NO_PRIMARY = "ERR_SOURCE_NO_PRIMARY"
    ERR_SOURCE_MULTIPLE_PRIMARY = "ERR_SOURCE_MULTIPLE_PRIMARY"
    # Cross-language vocabulary for features other ports added (FR-003 storage, FR-004 template);
    # the Python loader does not emit these yet, but the enum tracks the shared corpus codes.
    ERR_INVALID_TEMPLATE = "ERR_INVALID_TEMPLATE"
    ERR_STORAGE_FLATTENED_ARRAY = "ERR_STORAGE_FLATTENED_ARRAY"
    ERR_STORAGE_WITHOUT_OBJECT_REF = "ERR_STORAGE_WITHOUT_OBJECT_REF"
    ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED"
    ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED"
    ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD"
    ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING"
    ERR_UNKNOWN = "ERR_UNKNOWN"


class MetaError:
    """A loader error. `code` is the conformance-compared value; `message` is human text."""

    def __init__(
        self,
        message: str,
        code: ErrorCode = ErrorCode.ERR_UNKNOWN,
        source: str | None = None,
        path: str | None = None,
    ) -> None:
        self.message = message
        self.code = code
        self.source = source
        self.path = path

    def __repr__(self) -> str:
        return f"MetaError({self.code.name}: {self.message!r})"


class ParseError(Exception):
    """Raised by the parser in strict mode; carries a code."""

    def __init__(self, message: str, code: ErrorCode = ErrorCode.ERR_UNKNOWN) -> None:
        super().__init__(message)
        self.code = code
