"""Cross-language doc-attr constants. Bare strings (identical to TS/C#/Java)."""
from __future__ import annotations

DOC_ATTR_DESCRIPTION = "description"
DOC_ATTR_SUMMARY     = "summary"
DOC_ATTR_TITLE       = "title"
DOC_ATTR_NOTES       = "notes"
DOC_ATTR_DEPRECATED  = "deprecated"
DOC_ATTR_REPLACED_BY = "replacedBy"
DOC_ATTR_SEE_ALSO    = "seeAlso"
DOC_ATTR_ALIASES     = "aliases"

DOC_ATTR_NAMES: tuple[str, ...] = (
    DOC_ATTR_DESCRIPTION,
    DOC_ATTR_SUMMARY,
    DOC_ATTR_TITLE,
    DOC_ATTR_NOTES,
    DOC_ATTR_DEPRECATED,
    DOC_ATTR_REPLACED_BY,
    DOC_ATTR_SEE_ALSO,
    DOC_ATTR_ALIASES,
)
