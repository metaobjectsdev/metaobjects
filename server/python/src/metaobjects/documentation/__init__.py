"""Documentation provider — 7 universal common attrs (cross-language parity)."""
from __future__ import annotations

from .doc_constants import (
    DOC_ATTR_ALIASES,
    DOC_ATTR_DEPRECATED,
    DOC_ATTR_DESCRIPTION,
    DOC_ATTR_NAMES,
    DOC_ATTR_NOTES,
    DOC_ATTR_REPLACED_BY,
    DOC_ATTR_SEE_ALSO,
    DOC_ATTR_TITLE,
)
from .doc_provider import doc_provider
from .doc_schema import common_doc_attrs

__all__ = [
    "DOC_ATTR_DESCRIPTION",
    "DOC_ATTR_TITLE",
    "DOC_ATTR_NOTES",
    "DOC_ATTR_DEPRECATED",
    "DOC_ATTR_REPLACED_BY",
    "DOC_ATTR_SEE_ALSO",
    "DOC_ATTR_ALIASES",
    "DOC_ATTR_NAMES",
    "common_doc_attrs",
    "doc_provider",
]
