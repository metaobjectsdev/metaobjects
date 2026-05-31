"""MetaObject — typed accessors over children + runtime instantiation."""
from __future__ import annotations

from ...meta_data import MetaData
from ..field.meta_field import MetaField
from .object_class_registry import (
    ObjectClassRegistry,
    default_object_class_registry,
)
from .value_object import ValueObject


class MetaObject(MetaData):
    def fields(self) -> list[MetaField]:
        """Effective fields: own + inherited via super chain (uses children())."""
        return [c for c in self.children() if isinstance(c, MetaField)]

    def own_fields(self) -> list[MetaField]:
        """Own fields only — direct children, no inherited fields from super."""
        return [c for c in self.own_children() if isinstance(c, MetaField)]

    def find_field(self, name: str) -> MetaField | None:
        """Find a field by name in effective fields (own + inherited)."""
        return next((f for f in self.fields() if f.name == name), None)

    def get_meta_field(self, name: str) -> MetaField | None:
        """Alias for find_field — Java/TS parity (``getMetaField``)."""
        return self.find_field(name)

    def new_instance(self, registry: ObjectClassRegistry | None = None) -> object:
        """Instantiate a backing object for this MetaObject (Java/TS parity:
        ``newInstance``). Resolution order:

          1. If ``registry.resolve(self.resolution_key())`` yields a factory,
             call it; if the result is MetaObjectAware (has ``set_meta_data``),
             attach this MetaObject as its back-reference.
          2. Otherwise create a dict-backed ``ValueObject`` (the unbound default
             for ``object.value``), which sets its own back-reference via the
             constructor.

        The registry key is this object's package-folded ``resolution_key()`` —
        the SAME FQN form a nested field's ``@objectRef`` uses, so a factory
        registered for an object's FQN is found whether instantiation is driven
        top-down or via an object-ref. Reflection-free: only registered
        factories are consulted.
        """
        reg = registry if registry is not None else default_object_class_registry
        factory = reg.resolve(self.resolution_key())
        if factory is not None:
            instance = factory(self)
            set_back_ref = getattr(instance, "set_meta_data", None)
            if callable(set_back_ref):
                set_back_ref(self)
            return instance
        return ValueObject(self)

    def primary_identity(self) -> "MetaIdentity | None":  # type: ignore[name-defined]
        """Primary identity node from effective children (own or inherited)."""
        from ..identity.meta_identity import MetaIdentity
        from ..identity.identity_constants import IDENTITY_SUBTYPE_PRIMARY
        return next(
            (c for c in self.children()
             if isinstance(c, MetaIdentity) and c.sub_type == IDENTITY_SUBTYPE_PRIMARY),
            None,
        )
