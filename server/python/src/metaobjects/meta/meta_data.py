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
        """Own FQN: ``package::name`` if own package is set, else just ``name``."""
        return self.name if not self.package else f"{self.package}{PACKAGE_SEP}{self.name}"

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
        """Own attr value for *name*, or ``None``."""
        node = self._attr_nodes.get(name)
        return getattr(node, "value", None) if node is not None else None

    def own_attrs(self) -> dict[str, object]:
        """Own attr value map — excludes inherited attrs."""
        return {
            name: getattr(node, "value", None)
            for name, node in self._attr_nodes.items()
            if getattr(node, "value", None) is not None
        }

    def attrs(self) -> dict[str, object]:
        """Effective attr value map: own + inherited via super chain (own wins on key conflict).

        Cycle-guarded and cached.
        """
        return self._cached("attrs", lambda: self._effective_attrs_inner({self}))

    def _effective_attrs_inner(self, visited: "set[MetaData]") -> dict[str, object]:
        """Compute effective attrs with cycle detection via *visited* set."""
        if self.super_data is None or self.super_data in visited:
            return self.own_attrs()
        visited.add(self.super_data)
        result = self.super_data._effective_attrs_inner(visited)
        # own attrs override super
        result.update(self.own_attrs())
        return result

    def add_child(self, child: "MetaData") -> None:
        self._require_mutable()
        child.parent = self
        self._children.append(child)

    def own_children(self) -> list["MetaData"]:
        """Own (locally declared) children — excludes children inherited via extends."""
        return list(self._children)

    def children(self) -> list["MetaData"]:
        """Effective children: own + inherited via the super chain, own shadowing super on (type, name).

        Cycle-guarded and cached (after freeze).
        """
        return self._cached("children", lambda: self._effective_children_inner({self}))

    def _effective_children_inner(
        self, visited: "set[MetaData]"
    ) -> list["MetaData"]:
        """Compute effective children with cycle detection via *visited* set."""
        if self.super_data is None or self.super_data in visited:
            # No super, or super already on the current path — skip to avoid cycle.
            result: list[MetaData] = list(self._children)
        else:
            visited.add(self.super_data)
            result = self.super_data._effective_children_inner(visited)
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
