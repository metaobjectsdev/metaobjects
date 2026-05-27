"""The type registry: (type, subType) -> TypeDefinition. Populated by providers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable


@dataclass(frozen=True)
class AttrSchema:
    name: str
    # An attr subtype name, e.g. "string", "boolean", "stringArray".
    # Optional: a None value_type declares the attr as "known but untyped",
    # which the YAML coercion guard skips. Used for polymorphic attrs like
    # @default whose value type follows the OWNING field's subtype.
    value_type: str | None
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
        self._common_attrs: list[AttrSchema] = []
        # Per-type designated default subType (queried by the YAML desugar to
        # resolve a bare `metadata:` / `object:` key to e.g. `metadata.root` /
        # `object.entity`). Mirrors TypeRegistry._defaultSubTypes in TS.
        self._default_sub_types: dict[str, str] = {}

    def register(self, definition: TypeDefinition) -> None:
        self._defs[definition.key] = definition

    def find(self, type_: str, sub_type: str) -> TypeDefinition | None:
        return self._defs.get((type_, sub_type))

    def has_type(self, type_: str) -> bool:
        return any(t == type_ for (t, _s) in self._defs)

    def set_default_sub_type(self, type_: str, sub_type: str) -> None:
        """Designate the default subType for a bare `type` YAML key (ADR-0006 Rule 1).

        Mirrors TypeRegistry.setDefaultSubType in TS. Used by the YAML desugar
        when resolving sugared `metadata:` / `object:` keys.
        """
        self._default_sub_types[type_] = sub_type

    def default_sub_type_of(self, type_: str) -> str | None:
        """Return the designated default subType for *type_*, or None if none.

        Mirrors TypeRegistry.defaultSubTypeOf in TS.
        """
        return self._default_sub_types.get(type_)

    def register_common_attrs(self, attrs: list[AttrSchema]) -> None:
        """Register attrs accepted on every metatype. First-wins dedupe by name.

        Conflict with per-type attrs is detected at validation time, not here.
        """
        for attr in attrs:
            if any(existing.name == attr.name for existing in self._common_attrs):
                continue  # first registration wins
            self._common_attrs.append(attr)

    def get_common_attrs(self) -> list[AttrSchema]:
        """Return a defensive copy of the registered common attrs."""
        return list(self._common_attrs)

    def attrs_of(self, type_: str, sub_type: str) -> list[AttrSchema]:
        """The declared attribute schemas for a (type, subType), or [] if unregistered.
        Mirrors the TS registry's attrsOf()."""
        definition = self.find(type_, sub_type)
        return list(definition.attrs) if definition is not None else []

    def attr_schema(self, type_: str, sub_type: str, attr_name: str) -> AttrSchema | None:
        """Look up a per-type attr schema by name, then fall back to common attrs."""
        for attr in self.attrs_of(type_, sub_type):
            if attr.name == attr_name:
                return attr
        for attr in self._common_attrs:
            if attr.name == attr_name:
                return attr
        return None
