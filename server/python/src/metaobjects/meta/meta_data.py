"""Abstract node base — Python port of the typed-tree MetaData (ADR-0002)."""
from __future__ import annotations

from typing import Callable, Optional, TypeVar, cast

from ..attr_class_map import attr_class_for
from ..shared.base_types import SUBTYPE_BASE, TYPE_ATTR
from ..shared.separators import PACKAGE_SEP

T = TypeVar("T")


class MetaData:
    def __init__(self, type_: str, sub_type: str, name: str) -> None:
        self.type = type_
        self.sub_type = sub_type
        self.name = name
        self.package: Optional[str] = None
        self.super_ref: Optional[str] = None
        self.super_data: Optional[MetaData] = None
        self.is_abstract = False
        self.is_overlay = False
        self.is_array = False
        self.parent: Optional[MetaData] = None
        self._attr_nodes: dict[str, MetaData] = {}  # name -> MetaAttr instance
        self._children: list[MetaData] = []
        self._cache: dict[str, object] = {}
        self._frozen = False

    @property
    def frozen(self) -> bool:
        return self._frozen

    def fqn(self) -> str:
        return self.name if not self.package else f"{self.package}{PACKAGE_SEP}{self.name}"

    def effective_package(self) -> Optional[str]:
        node: Optional[MetaData] = self
        while node is not None:
            if node.package:
                return node.package
            node = node.parent
        return None

    def effective_fqn(self) -> str:
        pkg = self.effective_package()
        return self.name if not pkg else f"{pkg}{PACKAGE_SEP}{self.name}"

    def _require_mutable(self) -> None:
        if self._frozen:
            raise RuntimeError(f"Cannot mutate frozen MetaData {self.fqn()}")

    def set_attr(self, name: str, value: object, sub_type: str | None = None) -> None:
        self._require_mutable()
        resolved_sub = sub_type if sub_type is not None else SUBTYPE_BASE
        ctor = attr_class_for(resolved_sub)
        # attr_class_for always returns a MetaData subclass at runtime; cast for type safety.
        attr = cast("MetaData", ctor(TYPE_ATTR, resolved_sub, name))
        attr.parent = self
        attr.set_value(value)  # type: ignore[attr-defined]
        self._attr_nodes[name] = attr

    def own_meta_attr(self, name: str) -> Optional[MetaData]:
        return self._attr_nodes.get(name)

    def own_meta_attrs(self) -> list[MetaData]:
        return list(self._attr_nodes.values())

    def attr(self, name: str) -> object:
        node = self._attr_nodes.get(name)
        return getattr(node, "value", None) if node is not None else None

    def add_child(self, child: "MetaData") -> None:
        self._require_mutable()
        child.parent = self
        self._children.append(child)

    def children(self) -> list["MetaData"]:
        return list(self._children)

    def effective_children(
        self, _visited: "set[MetaData] | None" = None
    ) -> list["MetaData"]:
        """Return own children merged with super chain (own shadowing super on type+name).

        ``_visited`` is an internal parameter used to detect cycles in the super
        chain (e.g. A.super_data = B, B.super_data = A).  Callers must not pass it;
        the public contract is zero-argument.  When a cycle is detected the repeated
        node contributes no further super children — the call returns gracefully
        rather than raising ``RecursionError``.

        Result is cached after the first call on a frozen node (top-level only).
        """
        # -----------------------------------------------------------------------
        # Top-level call (public contract): use the memoisation cache.
        # -----------------------------------------------------------------------
        if _visited is None:
            def _compute_top() -> list[MetaData]:
                return self._effective_children_inner({self})

            return self._cached("effective_children", _compute_top)

        # -----------------------------------------------------------------------
        # Recursive call (cycle-aware): bypass the cache — visited is path-specific.
        # -----------------------------------------------------------------------
        return self._effective_children_inner(_visited)

    def _effective_children_inner(
        self, visited: "set[MetaData]"
    ) -> list["MetaData"]:
        """Compute effective children with cycle detection via *visited* set."""
        if self.super_data is None or self.super_data in visited:
            # No super, or super already on the current path — skip to avoid cycle.
            result: list[MetaData] = list(self._children)
        else:
            visited.add(self.super_data)
            result = self.super_data.effective_children(visited)
            for own in self._children:
                idx = next(
                    (i for i, c in enumerate(result)
                     if c.type == own.type and c.name == own.name),
                    None,
                )
                if idx is None:
                    result.append(own)
                else:
                    result[idx] = own
        return result

    def freeze(self) -> None:
        if self._frozen:
            return
        self._frozen = True
        for attr in self._attr_nodes.values():
            attr.freeze()
        for child in self._children:
            child.freeze()

    def _cached(self, key: str, compute: Callable[[], T]) -> T:
        if self._frozen and key in self._cache:
            return cast(T, self._cache[key])
        value = compute()
        if self._frozen:
            self._cache[key] = value
        return value
