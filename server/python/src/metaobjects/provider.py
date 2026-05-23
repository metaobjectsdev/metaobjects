"""Composable type providers (ADR-0004). Subtypes self-register via @provider.register."""
from __future__ import annotations

from typing import Callable, TypeVar

from .errors import ErrorCode, ParseError
from .registry import AttrSchema, ChildRule, TypeDefinition, TypeRegistry

T = TypeVar("T", bound=type)


class Provider:
    def __init__(self, provider_id: str, dependencies: tuple[str, ...] = ()) -> None:
        self.id = provider_id
        self.dependencies = dependencies
        self._defs: list[TypeDefinition] = []
        self._on_register: Callable[[], None] | None = None

    def add(self, definition: TypeDefinition) -> None:
        self._defs.append(definition)

    def register(self, cls: T) -> T:
        """Class decorator: build a TypeDefinition from class attributes and add it."""
        type_ = getattr(cls, "TYPE")
        sub_type = getattr(cls, "SUBTYPE")
        attrs: list[AttrSchema] = list(getattr(cls, "ATTRS", []))
        child_rules: list[ChildRule] = list(getattr(cls, "CHILD_RULES", []))
        inherits_from = getattr(cls, "INHERITS_FROM", None)

        def factory(t: str, s: str, n: str, _cls: T = cls) -> object:
            return _cls(t, s, n)

        self.add(
            TypeDefinition(
                type=type_,
                sub_type=sub_type,
                factory=factory,
                attrs=attrs,
                child_rules=child_rules,
                inherits_from=inherits_from,
            )
        )
        return cls

    def register_types(self, registry: TypeRegistry) -> None:
        if self._on_register is not None:
            self._on_register()
        for definition in self._defs:
            registry.register(definition)


def compose_registry(providers: list[Provider]) -> TypeRegistry:
    """Topologically sort providers by dependency, then register each into a fresh registry."""
    ordered = _topo_sort(providers)
    registry = TypeRegistry()
    for provider in ordered:
        provider.register_types(registry)
    return registry


def _topo_sort(providers: list[Provider]) -> list[Provider]:
    by_id: dict[str, Provider] = {}
    for provider in providers:
        if provider.id in by_id:
            raise ParseError(
                f'Duplicate provider id "{provider.id}"', ErrorCode.ERR_PROVIDER_DUPLICATE_ID
            )
        by_id[provider.id] = provider

    for provider in providers:
        for dep in provider.dependencies:
            if dep not in by_id:
                raise ParseError(
                    f'Provider "{provider.id}" depends on missing "{dep}"',
                    ErrorCode.ERR_PROVIDER_MISSING_DEPENDENCY,
                )

    ordered: list[Provider] = []
    visited: dict[str, int] = {}  # 0 = visiting, 1 = done

    def visit(p: Provider) -> None:
        state = visited.get(p.id)
        if state == 1:
            return
        if state == 0:
            raise ParseError(
                f'Provider dependency cycle at "{p.id}"',
                ErrorCode.ERR_PROVIDER_DEPENDENCY_CYCLE,
            )
        visited[p.id] = 0
        for dep in p.dependencies:
            visit(by_id[dep])
        visited[p.id] = 1
        ordered.append(p)

    for provider in providers:
        visit(provider)
    return ordered
