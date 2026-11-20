"""view_expressions_provider — the view-expressions pack (cross-port
``metaobjects-view-expressions``).

The vocabulary a projection needs to replace a hand-written ``@sql`` view: the
``origin.function`` type (a value computed by a database function the project owns)
and the projection attrs ``@union`` / ``@unionAll`` / ``@grain`` / ``@grainOrdinal``.
Cross-port vocabulary only TypeScript and C# act on (``implementedIn``): Python
registers it so a shared model loads strictly here, and acts on none of it. It is its
OWN provider so a project can leave it out; it is in the default bundle
(``core_providers``), so every existing model loads unchanged.

The projection attrs come from ``view-expressions.json`` ``extends``. Mirrors the TS
``viewExpressionsProvider``.
"""
from __future__ import annotations

from ....provider import Provider
from ....registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry
from ....shared.base_types import TYPE_ATTR, TYPE_ORIGIN
from ...core.attr.attr_constants import ATTR_SUBTYPE_STRING
from ...provider_extends import register_extends
from ..origin.meta_origin import MetaOrigin

view_expressions_provider = Provider(
    "metaobjects-view-expressions", dependencies=("metaobjects-core-types",)
)

# origin.function (rc.21 part B, U10) — a call of a database function the project owns:
# @function required, @schema and @args optional. Registered so a strict load accepts it.
view_expressions_provider.add(
    TypeDefinition(
        type=TYPE_ORIGIN,
        sub_type="function",
        factory=MetaOrigin,
        attrs=[
            AttrSchema(name="function", value_type=ATTR_SUBTYPE_STRING, required=True),
            AttrSchema(name="schema", value_type=ATTR_SUBTYPE_STRING, required=False),
            AttrSchema(name="args", value_type=ATTR_SUBTYPE_STRING, required=False, is_array=True),
            AttrSchema(name="params", value_type=ATTR_SUBTYPE_STRING, required=False, is_array=True),
            AttrSchema(name="returns", value_type=ATTR_SUBTYPE_STRING, required=True),
        ],
        child_rules=[ChildRule(TYPE_ATTR, "*")],
    )
)



def _register(registry: TypeRegistry) -> None:
    register_extends(registry, "view-expressions.json")


view_expressions_provider.on_register(_register)
