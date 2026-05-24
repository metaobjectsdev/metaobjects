"""The core metaobjects type provider. Composes per-concern registrations (ADR-0004)."""
from __future__ import annotations

# Importing the attr module triggers its attr-class self-registration (side effect).
from .attr_class_map import attr_class_for
from .meta.core.attr import meta_attr as _attr  # noqa: F401
from .meta.core.attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_FILTER,
    ATTR_SUBTYPE_INT,
    ATTR_SUBTYPE_STRING,
    ATTR_SUBTYPE_STRINGARRAY,
    ATTR_SUBTYPES,
)
from .meta.core.field import field_constants as fc
from .meta.core.field.field_constants import FIELD_ATTR_VALUES, FIELD_SUBTYPE_ENUM
from .meta.core.field.meta_field import MetaField
from .meta.core.identity.identity_constants import (
    GENERATION_VALUES,
    IDENTITY_ATTR_FIELDS,
    IDENTITY_ATTR_GENERATION,
    IDENTITY_REFERENCE_ATTR_ENFORCE,
    IDENTITY_REFERENCE_ATTR_REFERENCES,
    IDENTITY_SUBTYPE_PRIMARY,
    IDENTITY_SUBTYPE_REFERENCE,
    IDENTITY_SUBTYPE_SECONDARY,
)
from .meta.core.identity.meta_identity import MetaIdentity
from .meta.core.object.meta_object import MetaObject
from .meta.core.object.object_constants import OBJECT_SUBTYPE_ENTITY, OBJECT_SUBTYPES
from .meta.core.relationship.meta_relationship import MetaRelationship
from .meta.core.relationship.relationship_constants import (
    REFERENTIAL_ACTIONS,
    RELATIONSHIP_ATTR_ON_DELETE,
    RELATIONSHIP_ATTR_ON_UPDATE,
    RELATIONSHIP_SUBTYPES,
)
from .meta.meta_root import MetaRoot
from .meta.persistence.origin.meta_origin import MetaOrigin
from .meta.persistence.origin.origin_constants import (
    ORIGIN_ATTR_AGG,
    ORIGIN_ATTR_FROM,
    ORIGIN_ATTR_OF,
    ORIGIN_ATTR_VIA,
    ORIGIN_SUBTYPE_AGGREGATE,
    ORIGIN_SUBTYPE_PASSTHROUGH,
)
from .meta.persistence.source.meta_source import MetaSource
from .meta.persistence.source.source_constants import (
    SOURCE_ATTR_KIND,
    SOURCE_ATTR_ROLE,
    SOURCE_ATTR_SCHEMA,
    SOURCE_ATTR_TABLE,
    SOURCE_RDB_KINDS,
    SOURCE_ROLES,
    SOURCE_SUBTYPE_RDB,
)
from .meta.presentation.layout.layout_constants import (
    LAYOUT_ATTR_COLUMNS,
    LAYOUT_ATTR_DEFAULT_SORT_FIELD,
    LAYOUT_ATTR_DEFAULT_SORT_ORDER,
    LAYOUT_ATTR_PAGE_SIZE,
    LAYOUT_SUBTYPES,
    LAYOUT_SUBTYPE_DATA_GRID,
)
from .meta.presentation.layout.meta_layout import MetaLayout
from .meta.presentation.view.meta_view import MetaView
from .meta.presentation.view.view_constants import VIEW_SUBTYPES
from .provider import Provider
from .registry import AttrSchema, ChildRule, NodeFactory, TypeDefinition, TypeRegistry
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

class _CoreProvider(Provider):
    """Subclass of Provider that also designates default subTypes for YAML authoring (ADR-0006).

    `metadata` has exactly one subtype (`root`) so the default is unambiguous;
    `object` defaults to `entity` (the common case). Other types (field,
    validator, ...) have no default — authoring always writes the full
    `type.subType`. Mirrors registerCoreTypeDefs in TS core-types.ts.
    """

    def register_types(self, registry: TypeRegistry) -> None:
        super().register_types(registry)
        registry.set_default_sub_type(TYPE_METADATA, SUBTYPE_ROOT)
        registry.set_default_sub_type(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)


core_provider = _CoreProvider("metaobjects-core-types")


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
# Note: FIELD_SUBTYPE_ENUM is excluded from FIELD_SUBTYPES; it is registered
# separately below with its required @values AttrSchema (sharing these child rules).
_FIELD_CHILD_RULES = [
    ChildRule(TYPE_ATTR, "*"),
    ChildRule(TYPE_ORIGIN, "*"),
    ChildRule(TYPE_VIEW, "*"),
]
# Common field attrs declared by the core port. `@column` carries a declared
# string valueType so the YAML desugar's D2 type-coercion guard (ADR-0006) can
# detect a YAML 1.2 silently-coerced unquoted boolean/number value
# (e.g. `column: TRUE` → boolean True instead of the string "TRUE"). The TS
# port registers this through a dedicated dbProvider that extends field types;
# Python keeps it on the core field defs until a full Python db-codegen port lands.
_FIELD_COMMON_ATTRS = [
    AttrSchema(name="column", value_type=ATTR_SUBTYPE_STRING, required=False),
]
_register_subtypes(
    core_provider,
    TYPE_FIELD,
    fc.FIELD_SUBTYPES,
    factory=MetaField,
    child_rules=_FIELD_CHILD_RULES,
    attrs=_FIELD_COMMON_ATTRS,
)

# field.enum — dedicated registration with required @values attr
core_provider.add(
    TypeDefinition(
        type=TYPE_FIELD,
        sub_type=FIELD_SUBTYPE_ENUM,
        factory=MetaField,
        attrs=[
            AttrSchema(
                name=FIELD_ATTR_VALUES,
                value_type=ATTR_SUBTYPE_STRINGARRAY,
                required=True,
            ),
            # See _FIELD_COMMON_ATTRS above — `@column` is declared on enum too
            # so the D2 type-coercion guard applies uniformly across all fields.
            AttrSchema(name="column", value_type=ATTR_SUBTYPE_STRING, required=False),
        ],
        child_rules=_FIELD_CHILD_RULES,
    )
)

# attr.* (factory resolved per subtype via the attr-class map at parse time)
_register_subtypes(
    core_provider,
    TYPE_ATTR,
    ATTR_SUBTYPES,
    factory=lambda t, s, n: attr_class_for(s)(t, s, n),
)

# identity.primary — @fields required stringArray; @generation optional with allowed values
core_provider.add(
    TypeDefinition(
        type=TYPE_IDENTITY,
        sub_type=IDENTITY_SUBTYPE_PRIMARY,
        factory=MetaIdentity,
        attrs=[
            AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRINGARRAY, required=True),
            AttrSchema(
                name=IDENTITY_ATTR_GENERATION,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=GENERATION_VALUES,
            ),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# identity.secondary — @fields required stringArray
core_provider.add(
    TypeDefinition(
        type=TYPE_IDENTITY,
        sub_type=IDENTITY_SUBTYPE_SECONDARY,
        factory=MetaIdentity,
        attrs=[AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRINGARRAY, required=True)],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# identity.reference — @fields (required), @references (required), @enforce (optional boolean)
core_provider.add(
    TypeDefinition(
        type=TYPE_IDENTITY,
        sub_type=IDENTITY_SUBTYPE_REFERENCE,
        factory=MetaIdentity,
        attrs=[
            AttrSchema(name=IDENTITY_ATTR_FIELDS, value_type=ATTR_SUBTYPE_STRINGARRAY, required=True),
            AttrSchema(name=IDENTITY_REFERENCE_ATTR_REFERENCES, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=IDENTITY_REFERENCE_ATTR_ENFORCE, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# relationship.* (base, association, aggregation, composition).
# @onDelete / @onUpdate are validated against REFERENTIAL_ACTIONS — kebab-case
# values (cascade / set-null / restrict / no-action). Defaults derive from the
# relationship subtype at consumption time, not at validation time.
_RELATIONSHIP_ATTRS = [
    AttrSchema(
        name=RELATIONSHIP_ATTR_ON_DELETE,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=REFERENTIAL_ACTIONS,
    ),
    AttrSchema(
        name=RELATIONSHIP_ATTR_ON_UPDATE,
        value_type=ATTR_SUBTYPE_STRING,
        required=False,
        allowed_values=REFERENTIAL_ACTIONS,
    ),
]
_register_subtypes(
    core_provider,
    TYPE_RELATIONSHIP,
    RELATIONSHIP_SUBTYPES,
    factory=MetaRelationship,
    child_rules=[ChildRule(TYPE_ATTR, "*")],
    attrs=_RELATIONSHIP_ATTRS,
)

# source.* — base (no attrs) + rdb (paradigm subtype with @table/@kind/@role/@schema).
# ADR-0007: read-only-ness is derived from @kind; multi-source one-primary rule is
# enforced in validation_passes.py.
core_provider.add(
    TypeDefinition(
        type=TYPE_SOURCE,
        sub_type=SUBTYPE_BASE,
        factory=MetaSource,
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)
core_provider.add(
    TypeDefinition(
        type=TYPE_SOURCE,
        sub_type=SOURCE_SUBTYPE_RDB,
        factory=MetaSource,
        attrs=[
            AttrSchema(name=SOURCE_ATTR_TABLE, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(
                name=SOURCE_ATTR_KIND,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=SOURCE_RDB_KINDS,
            ),
            AttrSchema(
                name=SOURCE_ATTR_ROLE,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=SOURCE_ROLES,
            ),
            AttrSchema(name=SOURCE_ATTR_SCHEMA, value_type=ATTR_SUBTYPE_STRING, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.base — no schema (pass-through container)
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=SUBTYPE_BASE,
        factory=MetaOrigin,
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.passthrough — @from required, @via optional
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=ORIGIN_SUBTYPE_PASSTHROUGH,
        factory=MetaOrigin,
        attrs=[
            AttrSchema(name=ORIGIN_ATTR_FROM, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=ORIGIN_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=False),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)

# origin.aggregate — @agg, @of, @via all required; @agg has allowed values
_AGG_ALLOWED = ("count", "sum", "avg", "min", "max")
core_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type=ORIGIN_SUBTYPE_AGGREGATE,
        factory=MetaOrigin,
        attrs=[
            AttrSchema(
                name=ORIGIN_ATTR_AGG,
                value_type=ATTR_SUBTYPE_STRING,
                required=True,
                allowed_values=_AGG_ALLOWED,
            ),
            AttrSchema(name=ORIGIN_ATTR_OF, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=ORIGIN_ATTR_VIA, value_type=ATTR_SUBTYPE_STRING, required=True),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
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
    AttrSchema(name=LAYOUT_ATTR_DEFAULT_SORT_FIELD, value_type=ATTR_SUBTYPE_STRING),
    AttrSchema(
        name=LAYOUT_ATTR_DEFAULT_SORT_ORDER,
        value_type=ATTR_SUBTYPE_STRING,
        allowed_values=("asc", "desc"),
    ),
    AttrSchema(name=LAYOUT_ATTR_PAGE_SIZE, value_type=ATTR_SUBTYPE_INT),
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
