"""Map capability names to normalized result dicts for script.json conformance checks."""
from __future__ import annotations

from typing import Any

from metaobjects.meta.meta_data import MetaData


def invoke(node: MetaData, capability: str, args: dict[str, Any]) -> dict[str, Any]:
    """Invoke a named capability on *node* and return the normalized result dict.

    Raises ``ValueError`` for unknown capabilities so the runner can surface the
    error clearly.

    Supported capabilities (per ``extends-abstract-base/script.json``):

    - ``object.effective-fields`` → ``{"names": [...]}`` — effective fields via super chain.
    - ``object.own-fields``       → ``{"names": [...]}`` — own (direct) fields only.
    - ``object.find-field``       → ``{"name": X}`` if found, ``{"absent": True}`` if not.
      Requires ``args["name"]``.
    - ``object.primary-identity`` → ``{"subtype": "primary"}`` if present.
    """
    if capability == "object.effective-fields":
        from metaobjects.meta.core.object.meta_object import MetaObject
        if not isinstance(node, MetaObject):
            raise TypeError(f"object.effective-fields requires a MetaObject, got {type(node)}")
        return {"names": [f.name for f in node.fields()]}

    if capability == "object.own-fields":
        from metaobjects.meta.core.object.meta_object import MetaObject
        if not isinstance(node, MetaObject):
            raise TypeError(f"object.own-fields requires a MetaObject, got {type(node)}")
        return {"names": [f.name for f in node.own_fields()]}

    if capability == "object.find-field":
        from metaobjects.meta.core.object.meta_object import MetaObject
        if not isinstance(node, MetaObject):
            raise TypeError(f"object.find-field requires a MetaObject, got {type(node)}")
        field_name: str = args["name"]
        found = node.find_field(field_name)
        if found is None:
            return {"absent": True}
        return {"name": found.name}

    if capability == "object.primary-identity":
        from metaobjects.meta.core.object.meta_object import MetaObject
        if not isinstance(node, MetaObject):
            raise TypeError(f"object.primary-identity requires a MetaObject, got {type(node)}")
        identity = node.primary_identity()
        if identity is None:
            return {"absent": True}
        return {"subtype": identity.sub_type}

    if capability == "field.filter-ops":
        # The canonical per-FIELD filter-operator band (in canonical operator
        # order). Single source of truth — the same ordered helper the codegen
        # filter-allowlist generator consumes. Returns {"names": [...]}.
        #
        # ops_for_field_ordered, not ops_for_subtype_ordered: the band is
        # field-level because an int-backed field.enum (@intValueMap) stores as
        # an integer and so drops `like`.
        from metaobjects.meta.core.field.meta_field import MetaField
        from metaobjects.codegen.generators.filter_allowlist_generator import (
            ops_for_field_ordered,
        )
        if not isinstance(node, MetaField):
            raise TypeError(f"field.filter-ops requires a MetaField, got {type(node)}")
        return {"names": list(ops_for_field_ordered(node))}

    raise ValueError(f"Unknown capability: {capability!r}")
