"""ObjectClassRegistry — resolution-key -> factory binding for instantiation.

Idiomatic Python port of Java's ``ObjectClassRegistry`` / the TS
``ObjectClassRegistry``: maps an object's package-folded FQN (its
``MetaData.resolution_key()``, e.g. ``com::example::om::Person``) to a factory
that produces a native backing instance. Generated code self-registers at
import time (``registry.register(fqn, factory)``) — NO reflection (no
``importlib`` / ``Class.forName`` / ``Type.GetType`` equivalent), AOT/tree-shake
safe per ADR-0001.

DISTINCT from the metadata ``TypeRegistry``, which maps metamodel type/subType
names to MetaData node classes. THIS registry maps a DATA object's FQN to a
runtime BACKING instance factory.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Callable, Optional

if TYPE_CHECKING:
    from .meta_object import MetaObject

#: Produces a native backing instance for the given MetaObject.
ObjectFactory = Callable[["MetaObject"], object]


class ObjectClassRegistry:
    """Binds a resolution-key (``package::name``) to a backing-instance factory."""

    def __init__(self) -> None:
        self._factories: dict[str, ObjectFactory] = {}

    def register(self, fqn: str, factory: ObjectFactory) -> None:
        """Bind a resolution-key to a backing-instance factory."""
        self._factories[fqn] = factory

    def resolve(self, fqn: str) -> Optional[ObjectFactory]:
        """Resolve the factory bound to a resolution-key, or None if unbound."""
        return self._factories.get(fqn)

    def has(self, fqn: str) -> bool:
        """True if a factory is bound to the resolution-key."""
        return fqn in self._factories

    def unregister(self, fqn: str) -> bool:
        """Remove a binding (test/scoping convenience); True if present."""
        if fqn in self._factories:
            del self._factories[fqn]
            return True
        return False


#: The module-level default registry. Generated code self-registers here at
#: import time; ``MetaObject.new_instance()`` consults it when no explicit
#: registry is passed. Tests should construct their own
#: ``ObjectClassRegistry()`` to avoid leaking bindings across cases (scenario 6).
default_object_class_registry = ObjectClassRegistry()
