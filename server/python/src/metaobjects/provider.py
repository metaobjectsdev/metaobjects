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
        # Post-register hook. Receives the composed registry so a DOMAIN provider
        # can call ``registry.extend(...)`` to enrich types another (already-ordered)
        # provider registered — mirroring TS's ``registerTypes(registry)`` and the
        # ``dbProvider`` / ``templateProvider`` ``registry.extend`` loops. Set via
        # ``on_register`` or by overriding ``register_types``.
        self._on_register: Callable[[TypeRegistry], None] | None = None

    def add(self, definition: TypeDefinition) -> None:
        self._defs.append(definition)

    def register(self, cls: T) -> T:
        """Class decorator: build a TypeDefinition from class attributes and add it."""
        type_ = getattr(cls, "TYPE")
        sub_type = getattr(cls, "SUBTYPE")
        attrs: list[AttrSchema] = list(getattr(cls, "ATTRS", []))
        child_rules: list[ChildRule] = list(getattr(cls, "CHILD_RULES", []))

        def factory(t: str, s: str, n: str, _cls: T = cls) -> object:
            return _cls(t, s, n)

        self.add(
            TypeDefinition(
                type=type_,
                sub_type=sub_type,
                factory=factory,
                attrs=attrs,
                child_rules=child_rules,
            )
        )
        return cls

    def on_register(self, hook: Callable[[TypeRegistry], None]) -> None:
        """Register a post-register hook that receives the composed registry.

        Runs AFTER this provider's own ``add``-ed definitions are registered (so
        a provider can both register and extend). The hook is the ergonomic way
        for a DOMAIN provider to call ``registry.extend(...)`` without subclassing
        ``Provider``. Mirrors the TS provider's ``registerTypes(registry)`` body.
        """
        self._on_register = hook

    def register_types(self, registry: TypeRegistry) -> None:
        for definition in self._defs:
            registry.register(definition)
        if self._on_register is not None:
            self._on_register(registry)


def compose_registry(providers: list[Provider]) -> TypeRegistry:
    """Topologically sort providers by dependency, then register each into a fresh registry.

    FR-033 S-B1 — after every provider has run (and BEFORE any caller seals the
    registry), source every type / attr / common-attr description from the embedded
    shared ``spec/metamodel/*.json`` onto the registry. Single-sourced, byte-identical
    to TS — never hand-copied. A ``(type, subType)`` (or attr) the spec does not
    declare keeps its empty description (the residual S-B2 scoping work).
    """
    # Deferred import avoids a provider -> spec_metamodel -> registry import cycle.
    from .spec_metamodel import apply_spec_descriptions

    ordered = _topo_sort(providers)
    registry = TypeRegistry()
    for provider in ordered:
        # #265 — stamp the active provider id for the duration of this
        # provider's register_types() call (covers both its own `.add()`-ed
        # definitions AND any `registry.extend()` it triggers, e.g. via an
        # `on_register` hook), so registry.py can attribute every attr it sees
        # to the provider that registered it. Cleared after so the sentinel
        # (LIBRARY_ATTR_ORIGIN) is the default outside a compose loop.
        registry._current_provider_id = provider.id  # noqa: SLF001
        try:
            provider.register_types(registry)
        finally:
            registry._current_provider_id = None  # noqa: SLF001
    apply_spec_descriptions(registry)
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
