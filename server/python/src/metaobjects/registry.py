"""The type registry: (type, subType) -> TypeDefinition. Populated by providers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


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

    def attrs_of(self, type_: str, sub_type: str) -> list[AttrSchema]:
        """The declared attribute schemas for a (type, subType), or [] if unregistered.
        Mirrors the TS registry's attrsOf()."""
        definition = self.find(type_, sub_type)
        return list(definition.attrs) if definition is not None else []

    def attr_schema(self, type_: str, sub_type: str, attr_name: str) -> AttrSchema | None:
        for attr in self.attrs_of(type_, sub_type):
            if attr.name == attr_name:
                return attr
        return None
