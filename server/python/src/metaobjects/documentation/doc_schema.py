"""The 7 universal doc common attrs as AttrSchema records."""
from __future__ import annotations

from ..meta.core.attr.attr_constants import ATTR_SUBTYPE_STRING, ATTR_SUBTYPE_STRINGARRAY
from ..registry import AttrSchema
from .doc_constants import (
    DOC_ATTR_ALIASES,
    DOC_ATTR_DEPRECATED,
    DOC_ATTR_DESCRIPTION,
    DOC_ATTR_NOTES,
    DOC_ATTR_REPLACED_BY,
    DOC_ATTR_SEE_ALSO,
    DOC_ATTR_TITLE,
)

common_doc_attrs: list[AttrSchema] = [
    AttrSchema(name=DOC_ATTR_DESCRIPTION,  value_type=ATTR_SUBTYPE_STRING,      required=False),
    AttrSchema(name=DOC_ATTR_TITLE,        value_type=ATTR_SUBTYPE_STRING,      required=False),
    AttrSchema(name=DOC_ATTR_NOTES,        value_type=ATTR_SUBTYPE_STRING,      required=False),
    AttrSchema(name=DOC_ATTR_DEPRECATED,   value_type=ATTR_SUBTYPE_STRING,      required=False),
    AttrSchema(name=DOC_ATTR_REPLACED_BY,  value_type=ATTR_SUBTYPE_STRING,      required=False),
    AttrSchema(name=DOC_ATTR_SEE_ALSO,     value_type=ATTR_SUBTYPE_STRINGARRAY, required=False),
    AttrSchema(name=DOC_ATTR_ALIASES,      value_type=ATTR_SUBTYPE_STRINGARRAY, required=False),
]
