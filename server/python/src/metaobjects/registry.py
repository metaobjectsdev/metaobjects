"""The type registry: (type, subType) -> TypeDefinition. Populated by providers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass(frozen=True)
class AttrSchema:
    name: str
    value_type: str  # an attr subtype name, e.g. "string", "boolean", "stringArray"
    required: bool = False
    allowed_values: tuple[str, ...] | None = None
    default: object | None = None


@dataclass(frozen=True)
class ChildRule:
    child_type: str
    child_sub_type: str  # "*" wildcard matches any subtype


# factory(type, sub_type, name) -> a node instance
NodeFactory = Callable[[str, str, str], object]


@dataclass
class TypeDefinition:
    type: str
    sub_type: str
    factory: NodeFactory
    attrs: list[AttrSchema] = field(default_factory=list)
    child_rules: list[ChildRule] = field(default_factory=list)
    inherits_from: Optional[tuple[str, str]] = None

    @property
    def key(self) -> tuple[str, str]:
        return (self.type, self.sub_type)


class TypeRegistry:
    def __init__(self) -> None:
        self._defs: dict[tuple[str, str], TypeDefinition] = {}

    def register(self, definition: TypeDefinition) -> None:
        self._defs[definition.key] = definition

    def find(self, type_: str, sub_type: str) -> TypeDefinition | None:
        return self._defs.get((type_, sub_type))

    def has_type(self, type_: str) -> bool:
        return any(t == type_ for (t, _s) in self._defs)

    def effective_attrs(self, type_: str, sub_type: str) -> list[AttrSchema]:
        """Own attrs plus those inherited via inherits_from; own wins on name conflict."""
        definition = self.find(type_, sub_type)
        if definition is None:
            return []
        by_name: dict[str, AttrSchema] = {}
        if definition.inherits_from is not None:
            for attr in self.effective_attrs(*definition.inherits_from):
                by_name[attr.name] = attr
        for attr in definition.attrs:
            by_name[attr.name] = attr
        return list(by_name.values())

    def attr_schema(self, type_: str, sub_type: str, attr_name: str) -> AttrSchema | None:
        for attr in self.effective_attrs(type_, sub_type):
            if attr.name == attr_name:
                return attr
        return None
