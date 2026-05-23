"""The core metaobjects type provider. Composes per-concern registrations (ADR-0004)."""
from __future__ import annotations

# Importing the attr module triggers its attr-class self-registration (side effect).
from .attr_class_map import attr_class_for
from .meta.core.attr import meta_attr as _attr  # noqa: F401
from .meta.core.attr.attr_constants import ATTR_SUBTYPE_STRINGARRAY, ATTR_SUBTYPES
from .meta.core.field import field_constants as fc
from .meta.core.field.meta_field import MetaField
from .meta.core.identity.identity_constants import (
    IDENTITY_ATTR_FIELDS,
    IDENTITY_SUBTYPES,
)
from .meta.core.identity.meta_identity import MetaIdentity
from .meta.core.object.meta_object import MetaObject
from .meta.core.object.object_constants import OBJECT_SUBTYPES
from .meta.meta_root import MetaRoot
from .provider import Provider
from .registry import AttrSchema, ChildRule, TypeDefinition
from .shared.base_types import (
    SUBTYPE_BASE,
    SUBTYPE_ROOT,
    TYPE_ATTR,
    TYPE_FIELD,
    TYPE_IDENTITY,
    TYPE_METADATA,
    TYPE_OBJECT,
)

core_provider = Provider("metaobjects-core-types")

# metadata.root
core_provider.add(
    TypeDefinition(
        type=TYPE_METADATA,
        sub_type=SUBTYPE_ROOT,
        factory=lambda t, s, n: MetaRoot(t, s, n),
        child_rules=[ChildRule(TYPE_OBJECT, "*")],
    )
)

# object.* (entity, value)
for _sub in OBJECT_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_OBJECT,
            sub_type=_sub,
            factory=lambda t, s, n: MetaObject(t, s, n),
            child_rules=[
                ChildRule(TYPE_FIELD, "*"),
                ChildRule(TYPE_IDENTITY, "*"),
                ChildRule(TYPE_ATTR, "*"),
            ],
        )
    )

# field.* (one factory, data_type by subtype)
for _sub in fc.FIELD_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_FIELD,
            sub_type=_sub,
            factory=lambda t, s, n: MetaField(t, s, n),
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )

# attr.* (factory resolved per subtype via the attr-class map at parse time)
for _sub in ATTR_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_ATTR,
            sub_type=_sub,
            factory=(lambda t, s, n: attr_class_for(s)(t, s, n)),
        )
    )

# identity.* (primary/secondary); @fields is a required stringArray
_identity_attrs = [
    AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRINGARRAY, required=True)
]
for _sub in IDENTITY_SUBTYPES:
    core_provider.add(
        TypeDefinition(
            type=TYPE_IDENTITY,
            sub_type=_sub,
            factory=lambda t, s, n: MetaIdentity(t, s, n),
            attrs=list(_identity_attrs),
            child_rules=[ChildRule(TYPE_ATTR, "*")],
        )
    )
