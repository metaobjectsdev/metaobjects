"""The type registry: (type, subType) -> TypeDefinition. Populated by providers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .errors import ErrorCode, ParseError
from .shared.base_types import SUBTYPE_BASE


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
    # True for an array-valued attr (a list of the scalar value_type) — the
    # single orthogonal array axis that replaced the retired "stringarray"
    # subtype, mirroring Java's StringAttribute + @isArray. The loader coerces an
    # array-flagged attr through the array string-attr coercion (bare-string →
    # one-element list).
    is_array: bool = False


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
        # ADR-0023 Decision 2 — sealed state. Once sealed, every mutating
        # registration method raises ERR_REGISTRY_SEALED. Python composes from an
        # explicit immutable provider set (compose_registry(core_providers)), so
        # sealing here is the guard + negative test (no polluted singleton to
        # pivot off). The library seals after the metamodel bootstrap; a
        # downstream app composes its own (unsealed) registry.
        self._sealed = False

    def seal(self) -> None:
        """Seal the registry: every subsequent mutating registration raises
        ERR_REGISTRY_SEALED. Idempotent. Reads are unaffected."""
        self._sealed = True

    def is_sealed(self) -> bool:
        """Whether this registry has been sealed (ADR-0023)."""
        return self._sealed

    def _check_not_sealed(self, operation: str) -> None:
        if self._sealed:
            raise ParseError(
                f"TypeRegistry is sealed (ADR-0023): {operation} is not permitted after "
                "metamodel bootstrap. Made-up metamodel attributes/types are structurally "
                "disallowed — a new metamodel attribute requires a registered provider + "
                "human agreement. Downstream apps that need extra vocabulary must compose "
                "their own (unsealed) registry.",
                ErrorCode.ERR_REGISTRY_SEALED,
            )

    def register(self, definition: TypeDefinition) -> None:
        self._check_not_sealed(f'register("{definition.key}")')
        # Store a per-registry COPY of the definition's mutable lists. Providers
        # hold their TypeDefinition objects as long-lived singletons (re-used across
        # every compose_registry call); a later provider's extend() does
        # definition.attrs.append(...). Without copying here, that append would mutate
        # the provider's SHARED list and accumulate duplicates across composes. Copying
        # makes extend() scoped to the registry being composed. The factory is shared
        # (a type's identity belongs to whoever registered it — see extend()).
        self._defs[definition.key] = TypeDefinition(
            type=definition.type,
            sub_type=definition.sub_type,
            factory=definition.factory,
            attrs=list(definition.attrs),
            child_rules=list(definition.child_rules),
        )

    def find(self, type_: str, sub_type: str) -> TypeDefinition | None:
        return self._defs.get((type_, sub_type))

    def has_type(self, type_: str) -> bool:
        return any(t == type_ for (t, _s) in self._defs)

    def set_default_sub_type(self, type_: str, sub_type: str) -> None:
        """Designate the default subType for a bare `type` YAML key (ADR-0006 Rule 1).

        Mirrors TypeRegistry.setDefaultSubType in TS. Used by the YAML desugar
        when resolving sugared `metadata:` / `object:` keys.
        """
        self._check_not_sealed(f'set_default_sub_type("{type_}")')
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
        self._check_not_sealed("register_common_attrs")
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

    def extend(
        self,
        type_: str,
        sub_type: str,
        *,
        attributes: list[AttrSchema] | None = None,
        child_rules: list[ChildRule] | None = None,
    ) -> None:
        """Additively enrich an already-registered ``(type_, sub_type)``.

        Append attributes and/or child rules to the existing TypeDefinition.
        Does NOT touch the factory — a type's identity belongs to whoever
        registered it. Used by providers to extend types another provider
        defined (mirrors the TS ``TypeRegistry.extend`` and C#
        ``TypeRegistry.Extend``).

        :raises ParseError: ``ERR_UNKNOWN_SUBTYPE`` if ``(type_, sub_type)``
            is not registered.
        :raises ParseError: ``ERR_PROVIDER_ATTR_CONFLICT`` if an attribute
            name already exists on the type (own-only check — common-attr
            collisions are still surfaced separately at validation time).

        Note: providers calling ``extend`` MUST declare a dependency on the
        provider that originally registered the ``(type_, sub_type)`` so
        ``compose_registry``'s topological ordering puts the registering
        provider before the extending one.
        """
        self._check_not_sealed(f'extend("{type_}.{sub_type}")')
        definition = self.find(type_, sub_type)
        if definition is None:
            raise ParseError(
                f'TypeRegistry.extend: no registered type "{type_}.{sub_type}" to extend',
                ErrorCode.ERR_UNKNOWN_SUBTYPE,
            )

        for attr in attributes or []:
            if attr.value_type == SUBTYPE_BASE:
                raise ValueError(
                    f'TypeRegistry.extend: attr "{attr.name}" being added to '
                    f'"{type_}.{sub_type}" declares value_type "{SUBTYPE_BASE}", '
                    f"which is not valid for attrs. Use None for a polymorphic/untyped attr."
                )
            if any(existing.name == attr.name for existing in definition.attrs):
                raise ParseError(
                    f'TypeRegistry.extend: attribute "{attr.name}" is already declared '
                    f'on "{type_}.{sub_type}"',
                    ErrorCode.ERR_PROVIDER_ATTR_CONFLICT,
                )
            definition.attrs.append(attr)

        for rule in child_rules or []:
            definition.child_rules.append(rule)
