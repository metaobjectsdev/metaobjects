"""rules_provider — the business-rules pack (cross-port ``metaobjects-rules``).

ADR-0030 / ADR-0066, experimental: the declared API surface (api / operation /
binding) and the lifecycle moves of a field.enum (transition). It is its OWN
provider so a project can leave it out; it is in the default bundle
(``core_providers``), so every existing model loads unchanged.

The pack owns its types AND the child rules that admit them on types core owns
(``metadata.root`` holds an ``api``; ``field.enum`` holds a ``transition``): both ride
in ``api.json`` / ``transition.json`` ``extends`` and are applied below. Compose the
pack out and the types are unknown; nothing of it is left behind in core. Attr scoping
is per-subtype exactly as those files declare it; the cross-node rules live in
loader/validate_rules.py. Mirrors the TS ``rulesProvider``.
"""
from __future__ import annotations

from ....provider import Provider
from ....registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry
from ....shared.base_types import (
    SUBTYPE_BASE,
    TYPE_API,
    TYPE_BINDING,
    TYPE_OPERATION,
    TYPE_TRANSITION,
)
from ..attr.attr_constants import (
    ATTR_SUBTYPE_BOOLEAN,
    ATTR_SUBTYPE_EXPRESSION,
    ATTR_SUBTYPE_STRING,
)
from ...provider_extends import register_extends
from ..api.api_constants import (
    API_SUBTYPE_OPERATIONAL,
    BINDING_ATTR_METHOD,
    BINDING_ATTR_PATH,
    BINDING_SUBTYPE_REST,
    HTTP_METHODS,
    OPERATION_ATTR_ERRORS,
    OPERATION_ATTR_INPUT_REF,
    OPERATION_ATTR_MANY,
    OPERATION_ATTR_OBJECT_REF,
    OPERATION_ATTR_OUTPUT_REF,
    OPERATION_ATTR_PERMISSION,
    OPERATION_ATTR_PUBLIC,
    OPERATION_ATTR_TRANSITIONS,
    OPERATION_SUBTYPE_COMMAND,
    OPERATION_SUBTYPE_QUERY,
)
from ..api.meta_api import MetaApi, MetaBinding, MetaOperation
from ..transition.meta_transition import MetaTransition
from ..transition.transition_constants import (
    TRANSITION_ATTR_CONDITION,
    TRANSITION_ATTR_FROM,
    TRANSITION_ATTR_PERMISSION,
    TRANSITION_ATTR_PUBLIC,
    TRANSITION_ATTR_TO,
    TRANSITION_SUBTYPE_ACTION,
)

rules_provider = Provider("metaobjects-rules", dependencies=("metaobjects-core-types",))

_OPERATION_COMMON_ATTRS = [
    AttrSchema(name=OPERATION_ATTR_INPUT_REF, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(name=OPERATION_ATTR_OUTPUT_REF, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(name=OPERATION_ATTR_OBJECT_REF, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(name=OPERATION_ATTR_PERMISSION, value_type=ATTR_SUBTYPE_STRING, required=False),
    AttrSchema(name=OPERATION_ATTR_PUBLIC, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
]
# The registry anchors: not authorable, they carry what every subtype of the type shares.
rules_provider.add(TypeDefinition(type=TYPE_API, sub_type=SUBTYPE_BASE, factory=MetaApi))
rules_provider.add(
    TypeDefinition(
        type=TYPE_OPERATION,
        sub_type=SUBTYPE_BASE,
        factory=MetaOperation,
        attrs=list(_OPERATION_COMMON_ATTRS),
        child_rules=[ChildRule(TYPE_BINDING, "*")],
    )
)
rules_provider.add(TypeDefinition(type=TYPE_BINDING, sub_type=SUBTYPE_BASE, factory=MetaBinding))
rules_provider.add(
    TypeDefinition(
        type=TYPE_TRANSITION,
        sub_type=SUBTYPE_BASE,
        factory=MetaTransition,
        attrs=[
            AttrSchema(name=TRANSITION_ATTR_PERMISSION, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=TRANSITION_ATTR_PUBLIC, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
        ],
    )
)
rules_provider.add(
    TypeDefinition(
        type=TYPE_API,
        sub_type=API_SUBTYPE_OPERATIONAL,
        factory=MetaApi,
        child_rules=[ChildRule(TYPE_OPERATION, "*")],
    )
)
rules_provider.add(
    TypeDefinition(
        type=TYPE_OPERATION,
        sub_type=OPERATION_SUBTYPE_COMMAND,
        factory=MetaOperation,
        attrs=[
            *_OPERATION_COMMON_ATTRS,
            AttrSchema(name=OPERATION_ATTR_TRANSITIONS, value_type=ATTR_SUBTYPE_STRING, required=False, is_array=True),
            AttrSchema(name=OPERATION_ATTR_ERRORS, value_type=ATTR_SUBTYPE_STRING, required=False, is_array=True),
        ],
        child_rules=[ChildRule(TYPE_BINDING, "*")],
    )
)
rules_provider.add(
    TypeDefinition(
        type=TYPE_OPERATION,
        sub_type=OPERATION_SUBTYPE_QUERY,
        factory=MetaOperation,
        attrs=[
            *_OPERATION_COMMON_ATTRS,
            AttrSchema(name=OPERATION_ATTR_MANY, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
        ],
        child_rules=[ChildRule(TYPE_BINDING, "*")],
    )
)
rules_provider.add(
    TypeDefinition(
        type=TYPE_BINDING,
        sub_type=BINDING_SUBTYPE_REST,
        factory=MetaBinding,
        attrs=[
            AttrSchema(
                name=BINDING_ATTR_METHOD,
                value_type=ATTR_SUBTYPE_STRING,
                required=False,
                allowed_values=HTTP_METHODS,
            ),
            AttrSchema(name=BINDING_ATTR_PATH, value_type=ATTR_SUBTYPE_STRING, required=False),
        ],
    )
)
rules_provider.add(
    TypeDefinition(
        type=TYPE_TRANSITION,
        sub_type=TRANSITION_SUBTYPE_ACTION,
        factory=MetaTransition,
        attrs=[
            AttrSchema(name=TRANSITION_ATTR_FROM, value_type=ATTR_SUBTYPE_STRING, required=True, is_array=True),
            AttrSchema(name=TRANSITION_ATTR_TO, value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name=TRANSITION_ATTR_CONDITION, value_type=ATTR_SUBTYPE_EXPRESSION, required=False),
            AttrSchema(name=TRANSITION_ATTR_PERMISSION, value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name=TRANSITION_ATTR_PUBLIC, value_type=ATTR_SUBTYPE_BOOLEAN, required=False),
        ],
    )
)


#: The embedded shared provider-definition files whose ``extends`` this pack applies.
_EXTENDS_FILES = ("api.json", "transition.json")


def _register(registry: TypeRegistry) -> None:
    for file_name in _EXTENDS_FILES:
        register_extends(registry, file_name)


rules_provider.on_register(_register)
