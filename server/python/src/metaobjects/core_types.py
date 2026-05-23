"""The core metaobjects type provider. Composes per-concern registrations (ADR-0004)."""
from __future__ import annotations

# Importing the attr module triggers its attr-class self-registration (side effect).
from .attr_class_map import attr_class_for
from .meta.core.attr import meta_attr as _attr  # noqa: F401
from .meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_FILTER,
    ATTR_SUBTYPE_STRINGARRAY,
    ATTR_SUBTYPES,
)
from .meta.core.field import field_constants as fc
from .meta.core.field.meta_field import MetaField
from .meta.core.identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_SUBTYPES,
)
from .meta.core.identity.meta_identity import MetaIdentity
from .meta.core.object.meta_object import MetaObject
from .meta.core.object.object_constants import OBJECT_SUBTYPES
from .meta.core.relationship.meta_relationship import MetaRelationship
from .meta.core.relationship.relationship_constants import RELATIONSHIP_SUBTYPES
from .meta.meta_root import MetaRoot
from .meta.persistence.origin.meta_origin import MetaOrigin
from .meta.persistence.origin.origin_constants import ORIGIN_SUBTYPES
from .meta.persistence.source.meta_source import MetaSource
from .meta.persistence.source.source_constants import SOURCE_SUBTYPES
from .meta.presentation.layout.layout_constants import (
    LAYOUT_ATTR_COLUMNS,
    LAYOUT_SUBTYPES,
    LAYOUT_SUBTYPE_DATA_GRID,
)
from .meta.presentation.layout.meta_layout import MetaLayout
from .meta.presentation.view.meta_view import MetaView
from .meta.presentation.view.view_constants import VIEW_SUBTYPES
from .provider import Provider
from .registry import AttrSchema, ChildRule, NodeFactory, TypeDefinition
from .shared.base_types import (
    SUBTYPE_BASE,
    SUBTYPE_ROOT,
    TYPE_ATTR,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_LAYOUT,
    TYPE_METADATA,
    TYPE_OBJECT,
    TYPE_ORIGIN,
    TYPE_RELATIONSHIP,
    TYPE_SOURCE,
    TYPE_VIEW,
)

core_provider = Provider("metaobjects-core-types")


def _register_subtypes(
    provider: Provider,
    type_name: str,
    subtypes: tuple[str, ...],
    factory: NodeFactory,
    child_rules: list[ChildRule] | None = None,
    attrs: list[AttrSchema] | None = None,
) -> None:
    """Register one TypeDefinition per subtype. Centralises loop boilerplate only —
    all type knowledge (subtypes tuple, node class, child rules) stays with the caller."""
    for sub in subtypes:
        provider.add(
            TypeDefinition(
                type=type_name,
                sub_type=sub,
                factory=factory,
                child_rules=list(child_rules) if child_rules else [],
                attrs=list(attrs) if attrs else [],
            )
        )


# metadata.root
core_provider.add(
    TypeDefinition(
        type=TYPE_METADATA,
        sub_type=SUBTYPE_ROOT,
        factory=MetaRoot,
        child_rules=[ChildRule(TYPE_OBJECT, "*")],
    )
)

# object.* (entity, value)
_register_subtypes(
    core_provider,
    TYPE_OBJECT,
    OBJECT_SUBTYPES,
    factory=MetaObject,
    child_rules=[
        ChildRule(TYPE_FIELD, "*"),
        ChildRule(TYPE_IDENTITY, "*"),
        ChildRule(TYPE_ATTR, "*"),
        ChildRule(TYPE_SOURCE, "*"),
        ChildRule(TYPE_RELATIONSHIP, "*"),
        ChildRule(TYPE_LAYOUT, "*"),
    ],
)

# field.* (one factory, data_type by subtype)
_register_subtypes(
    core_provider,
    TYPE_FIELD,
    fc.FIELD_SUBTYPES,
    factory=MetaField,
    child_rules=[
        ChildRule(TYPE_ATTR, "*"),
        ChildRule(TYPE_ORIGIN, "*"),
        ChildRule(TYPE_VIEW, "*"),
    ],
)

# attr.* (factory resolved per subtype via the attr-class map at parse time)
_register_subtypes(
    core_provider,
    TYPE_ATTR,
    ATTR_SUBTYPES,
    factory=lambda t, s, n: attr_class_for(s)(t, s, n),
)

# identity.* (primary/secondary); @fields is a required stringArray
_register_subtypes(
    core_provider,
    TYPE_IDENTITY,
    IDENTITY_SUBTYPES,
    factory=MetaIdentity,
    attrs=[AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRINGARRAY, required=True)],
    child_rules=[ChildRule(TYPE_ATTR, "*")],
)

# relationship.* (base, association, aggregation, composition)
_register_subtypes(
    core_provider,
    TYPE_RELATIONSHIP,
    RELATIONSHIP_SUBTYPES,
    factory=MetaRelationship,
    child_rules=[ChildRule(TYPE_ATTR, "*")],
)

# source.* (base, dbTable, dbView); @name + @schema flow through as base attrs
_register_subtypes(
    core_provider,
    TYPE_SOURCE,
    SOURCE_SUBTYPES,
    factory=MetaSource,
    child_rules=[ChildRule(TYPE_ATTR, "*")],
)

# origin.* (base, passthrough, aggregate); @from/@via/@agg/@of flow through as base attrs
_register_subtypes(
    core_provider,
    TYPE_ORIGIN,
    ORIGIN_SUBTYPES,
    factory=MetaOrigin,
    child_rules=[ChildRule(TYPE_ATTR, "*")],
)

# view.* (base, text, textarea, date, currency); @locale flows through as a base attr
_register_subtypes(
    core_provider,
    TYPE_VIEW,
    VIEW_SUBTYPES,
    factory=MetaView,
    child_rules=[ChildRule(TYPE_ATTR, "*")],
)

# layout.* (base, dataGrid); @columns is a stringArray — scalar desugars to array;
# @filter is a FilterAttr — shorthand values desugar to op-objects
_layout_datagrid_attrs = [
    AttrSchema(name=LAYOUT_ATTR_COLUMNS, value_type=ATTR_SUBTYPE_STRINGARRAY),
    AttrSchema(name="filter", value_type=ATTR_SUBTYPE_FILTER),
]
for _sub in LAYOUT_SUBTYPES:
    _attrs = list(_layout_datagrid_attrs) if _sub == LAYOUT_SUBTYPE_DATA_GRID else []
    core_provider.add(
        TypeDefinition(
            type=TYPE_LAYOUT,
            sub_type=_sub,
            factory=MetaLayout,
            attrs=_attrs,
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )
