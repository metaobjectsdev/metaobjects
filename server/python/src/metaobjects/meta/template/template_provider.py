"""template_provider — the template/output (serialization) MetaDataTypeProvider
(cross-port ``metaobjects-template``).

Registers the ``@xmlText`` field marker (XML text-content extraction) by EXTENDING the
core-registered field types via :meth:`TypeRegistry.extend`. ``@xmlText`` is an
output/extract concern, NOT a core field property, so it lives HERE in the prompt/output
domain — mirroring Java's ``TemplateTypesMetaDataProvider`` field extension, TS's
``templateProvider``, and C#'s ``TemplateTypesProvider``, and following the same pattern
as ``db_provider``.
"""
from __future__ import annotations

from ...provider import Provider
from ...registry import AttrSchema, TypeRegistry
from ...shared.base_types import TYPE_FIELD
from ..core.attr.attr_constants import ATTR_SUBTYPE_BOOLEAN
from ..core.field import field_constants as fc
from .template_constants import TEMPLATE_ATTR_XML_TEXT

# Every field subtype @xmlText applies to: the shared FIELD_SUBTYPES tuple (which
# deliberately excludes ``enum`` — registered separately in core_types) PLUS ``field.enum``.
# Mirrors the TS templateProvider's FIELD_SUBTYPES loop.
_XML_TEXT_FIELD_SUBTYPES: tuple[str, ...] = (*fc.FIELD_SUBTYPES, fc.FIELD_SUBTYPE_ENUM)

# @xmlText — when true, the field receives its element's XML text content during tolerant
# extract instead of a same-named child. On every field subtype. No effect for JSON.
_XML_TEXT_SCHEMA = AttrSchema(
    name=TEMPLATE_ATTR_XML_TEXT, value_type=ATTR_SUBTYPE_BOOLEAN, required=False
)


def _register(registry: TypeRegistry) -> None:
    for sub_type in _XML_TEXT_FIELD_SUBTYPES:
        registry.extend(TYPE_FIELD, sub_type, attributes=[_XML_TEXT_SCHEMA])


def _make_template_provider() -> Provider:
    p = Provider("metaobjects-template", dependencies=("metaobjects-core-types",))
    p.on_register(_register)
    return p


template_provider = _make_template_provider()
