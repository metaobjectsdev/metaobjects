"""MetaObjectAware — the runtime back-reference contract.

Idiomatic Python port of Java's ``MetaObjectAware`` / the TS
``MetaObjectAware`` interface: a backing object that knows the ``MetaObject``
describing it. The default backing type (``ValueObject``) implements this;
generated / registered native types may implement it too so they carry a
back-reference after ``MetaObject.new_instance()``.

Reflection-free — no ``importlib``, no runtime type resolution. The protocol is
structural (``typing.Protocol``), so a native type only needs the two methods;
it does not have to inherit from anything.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Protocol, runtime_checkable

if TYPE_CHECKING:
    from .meta_object import MetaObject


@runtime_checkable
class MetaObjectAware(Protocol):
    """A backing object carrying a reference to the MetaObject describing it."""

    def get_meta_data(self) -> "MetaObject | None":
        """The MetaObject describing this instance, or None if not yet attached."""
        ...

    def set_meta_data(self, mo: "MetaObject") -> None:
        """Attach the MetaObject describing this instance (back-reference)."""
        ...


def is_meta_object_aware(obj: object) -> bool:
    """Structural check — True when *obj* satisfies the MetaObjectAware contract.

    Mirrors the TS ``isMetaObjectAware`` type guard. Uses duck-typing rather
    than ``isinstance(obj, MetaObjectAware)`` so it stays robust even when a
    native type defines the two methods without importing the protocol.
    """
    return callable(getattr(obj, "get_meta_data", None)) and callable(
        getattr(obj, "set_meta_data", None)
    )
