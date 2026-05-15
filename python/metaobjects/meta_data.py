"""Abstract node base — the Python port of the TS MetaData typed-tree base."""
from __future__ import annotations

from abc import ABC
from typing import Any, Callable, Optional, TypeVar

T = TypeVar("T")


class MetaData(ABC):
    def __init__(self, type_: str, sub_type: str, name: str) -> None:
        self.type = type_
        self.sub_type = sub_type
        self.name = name
        self.package: Optional[str] = None
        self.super_data: Optional[MetaData] = None
        self.is_abstract = False
        self.is_array = False
        self._attrs: dict[str, Any] = {}
        self._children: list[MetaData] = []
        self._cache: dict[str, Any] = {}
        self._frozen = False

    @property
    def frozen(self) -> bool:
        return self._frozen

    def fqn(self) -> str:
        return self.name if self.package is None else f"{self.package}::{self.name}"

    def set_attr(self, key: str, value: Any) -> None:
        if self._frozen:
            raise RuntimeError(f"Cannot mutate frozen MetaData {self.fqn()}")
        self._attrs[key] = value

    def attr(self, key: str) -> Any:
        return self._attrs.get(key)

    def attrs(self) -> dict[str, Any]:
        return dict(self._attrs)

    def add_child(self, child: "MetaData") -> None:
        if self._frozen:
            raise RuntimeError(f"Cannot mutate frozen MetaData {self.fqn()}")
        self._children.append(child)

    def children(self) -> list["MetaData"]:
        return list(self._children)

    def effective_children(self) -> list["MetaData"]:
        """Own + super-chain children; an own child overrides a super child
        of the same (type, name)."""
        def compute() -> list[MetaData]:
            result: list[MetaData] = list(
                self.super_data.effective_children() if self.super_data else []
            )
            for own in self._children:
                idx = next(
                    (i for i, c in enumerate(result)
                     if c.type == own.type and c.name == own.name),
                    None,
                )
                if idx is not None:
                    result[idx] = own
                else:
                    result.append(own)
            return result

        return self._cached("effective_children", compute)

    def freeze(self) -> None:
        if self._frozen:
            return
        self._frozen = True
        for child in self._children:
            child.freeze()

    def _cached(self, key: str, compute: Callable[[], T]) -> T:
        """Memoize a derived read. Stores only once frozen — a value computed
        pre-freeze is never cached, so it cannot go stale."""
        if self._frozen and key in self._cache:
            return self._cache[key]
        value = compute()
        if self._frozen:
            self._cache[key] = value
        return value
