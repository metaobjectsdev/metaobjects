"""ValueObject — the dict-backed default backing object for ``object.value``.

Idiomatic Python port of Java's ``ValueObject`` / the TS ``ValueObject``: a
string-keyed mapping that holds its ``MetaObject`` back-reference and supports
both declared fields and arbitrary overflow keys. THE unbound default produced
by ``MetaObject.new_instance()`` when no native type is registered for the
object's resolution key. Reflection-free.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from .meta_object import MetaObject


class ValueObject:
    """A dict-backed backing object — declared fields AND overflow keys.

    Implements the ``MetaObjectAware`` contract structurally
    (``get_meta_data`` / ``set_meta_data``) without importing the protocol.
    """

    def __init__(self, mo: "Optional[MetaObject]" = None) -> None:
        """Construct over an optional MetaObject back-reference (set at new_instance)."""
        self._values: dict[str, object] = {}
        self._meta_data: Optional[MetaObject] = mo

    # -- MetaObjectAware ------------------------------------------------

    def get_meta_data(self) -> "Optional[MetaObject]":
        """The MetaObject describing this instance, or None if not attached."""
        return self._meta_data

    def set_meta_data(self, mo: "MetaObject") -> None:
        """Attach the MetaObject describing this instance (back-reference)."""
        self._meta_data = mo

    # -- dict-backed value access (declared fields + overflow keys) -----

    def get(self, name: str) -> object:
        """Read a value by key. Returns None for an unset key."""
        return self._values.get(name)

    def set(self, name: str, value: object) -> None:
        """Write a value by key. Any string key is accepted (overflow-friendly)."""
        self._values[name] = value

    def has(self, name: str) -> bool:
        """True if the key has been set."""
        return name in self._values

    def delete(self, name: str) -> bool:
        """Remove a key; True if it was present."""
        if name in self._values:
            del self._values[name]
            return True
        return False

    def keys(self) -> list[str]:
        """Insertion-ordered keys currently held."""
        return list(self._values.keys())

    def to_dict(self) -> dict[str, object]:
        """A shallow-copy snapshot of the backing map (insertion-ordered)."""
        return dict(self._values)

    def __repr__(self) -> str:
        mo = self._meta_data.name if self._meta_data is not None else None
        return f"ValueObject(meta={mo!r}, {self._values!r})"
