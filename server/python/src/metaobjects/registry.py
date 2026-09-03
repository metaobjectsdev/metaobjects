"""The type registry: (type, subType) -> TypeDefinition. Populated by providers."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable

from .errors import ErrorCode, ParseError
from .shared.base_types import SUBTYPE_BASE
from .validation_types import NodeValidator, ReferenceDescriptor

# #265 — sentinel attr-provenance origin for an attr registered/extended with no
# active provider id (an unstamped registration — e.g. a hand-built registry in a
# unit test that never goes through provider.compose_registry's stamping loop, or
# any future registration path that forgets to set `_current_provider_id`).
# Treated as LIBRARY origin by the strict-attr-scoping prune guard
# (spec_metamodel._apply_strict_attr_scoping) — i.e. still prunable, preserving
# pre-#265 behavior for anything not explicitly attributed to a provider.
LIBRARY_ATTR_ORIGIN = "__library__"


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
    # FR-033 — the documentation surface (sourced from the embedded
    # spec/metamodel/*.json in sub-step B1). ``description`` is required +
    # non-empty in the canonical; the optional ``rules``/``example``/
    # ``when_to_use`` are emitted only when present. Default empty/None keeps
    # every existing AttrSchema(...) construction working (additive, frozen).
    description: str = ""
    rules: str | None = None
    example: str | None = None
    when_to_use: str | None = None


@dataclass(frozen=True)
class ChildRule:
    child_type: str
    child_sub_type: str | list[str]  # "*" wildcard, a single subtype, or a list (FR-033)
    # FR-033 — the strict structural constraint graph. ``child_name`` defaults to
    # the any-name wildcard. Cardinality (``min``/``max``) is emitted only when
    # set; ``max_is_null`` distinguishes a declared ``max: null`` (unbounded) from
    # an absent ``max`` (mirrors Java's ``maxIsNull``). ``named`` records whether
    # the child must carry an explicit name. All additive — existing
    # ``ChildRule(child_type, child_sub_type)`` calls keep working via defaults.
    child_name: str = "*"
    min: int | None = None
    max: int | None = None
    max_is_null: bool = False
    named: bool | None = None


# factory(type, sub_type, name) -> a node instance
NodeFactory = Callable[[str, str, str], object]


@dataclass
class TypeDefinition:
    type: str
    sub_type: str
    factory: NodeFactory
    attrs: list[AttrSchema] = field(default_factory=list)
    child_rules: list[ChildRule] = field(default_factory=list)
    # FR-033 — the documentation surface + child-side placement claim (sourced
    # from the embedded spec/metamodel/*.json in sub-step B1). ``description`` is
    # required + non-empty in the canonical; ``rules``/``example``/
    # ``when_to_use`` are optional (emitted only when present); ``parents`` is the
    # child-side placement claim (emitted only when non-empty, sorted ASCII). All
    # additive with empty/None defaults.
    description: str = ""
    rules: str | None = None
    example: str | None = None
    when_to_use: str | None = None
    parents: list[str] = field(default_factory=list)
    # Max children of this type.subType per parent (1 = singleton). Loader-enforced.
    max_occurs: int | None = None
    # Default name for a singleton (max_occurs==1) child declared with no name.
    default_name: str | None = None
    # Validation carried by the type's registration: the cross-references its attrs
    # declare + its imperative validator. The loader derives validation from these, so a
    # downstream provider's type validates itself.
    references: list[ReferenceDescriptor] = field(default_factory=list)
    validate: NodeValidator | None = None

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
        # #265 — the provider id active during the CURRENT register_types() call,
        # set/cleared by provider.compose_registry around each provider's turn.
        # None outside a compose loop (e.g. a hand-built registry in a unit test).
        self._current_provider_id: str | None = None
        # #265 — (type, subType, attrName) -> the provider id that registered
        # that attr (LIBRARY_ATTR_ORIGIN when unstamped). Consulted by
        # spec_metamodel._apply_strict_attr_scoping so a consumer-registered attr
        # on a spec-declared subtype is never pruned by the library's strict
        # per-subtype allow-list — only LIBRARY-origin attrs are.
        self._attr_provenance: dict[tuple[str, str, str], str] = {}

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
            # FR-033 — carry the documentation surface + placement claim onto the
            # per-registry copy (copy the mutable parents list so a later extend()
            # cannot mutate the provider's shared list).
            description=definition.description,
            rules=definition.rules,
            example=definition.example,
            when_to_use=definition.when_to_use,
            parents=list(definition.parents),
            max_occurs=definition.max_occurs,
            default_name=definition.default_name,
            references=list(definition.references),
            validate=definition.validate,
        )
        # #265 — stamp provenance for every attr present at registration time
        # (this also captures a provider's own build-time enrichment, e.g.
        # core_types.py's post-hoc `_def.attrs.append(...)` on its own
        # TypeDefinition objects before `register()` is ever called).
        origin = self._current_provider_id or LIBRARY_ATTR_ORIGIN
        for attr in self._defs[definition.key].attrs:
            self._attr_provenance[(definition.type, definition.sub_type, attr.name)] = origin

    def attr_origin(self, type_: str, sub_type: str, attr_name: str) -> str:
        """The provider id that registered/extended ``attr_name`` on ``(type_, sub_type)``,
        or :data:`LIBRARY_ATTR_ORIGIN` if unstamped. #265 provenance-scoped strict prune."""
        return self._attr_provenance.get((type_, sub_type, attr_name), LIBRARY_ATTR_ORIGIN)

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

    def all_sub_types_of(self, type_: str) -> list[str]:
        """Every registered subType for *type_*, in registration order.

        Mirrors ``TypeRegistry.allSubTypesOf`` in TS and ``AllSubTypesOf`` in C#; this port
        was the one without it, so callers reached into ``_defs``.
        """
        return [sub for (reg_type, sub) in self._defs if reg_type == type_]

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
            # ADR-0050, the second door. A common attr is projected onto EVERY registered
            # type, so a required one is the same defect as a required extend() -- with the
            # widest possible blast radius: drop the provider and every type silently loses
            # a required-attr rule. Java is immune by construction (its
            # registerCommonAttribute takes no required parameter); AttrSchema carries
            # `required`, so this port needs the explicit guard.
            if attr.required:
                raise ParseError(
                    f'TypeRegistry.register_common_attrs: attribute "{attr.name}" is '
                    "REQUIRED. A common attr is projected onto every registered type, so a "
                    "required one would vanish from all of them whenever its provider is "
                    "composed out. Common attrs must be optional (ADR-0050).",
                    ErrorCode.ERR_EXTEND_REQUIRED_ATTR,
                )
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
        :raises ParseError: ``ERR_EXTEND_REQUIRED_ATTR`` if an attribute being
            added is ``required`` (ADR-0050). ``extend`` is how a concern
            provider PROJECTS an attr onto a type it does not own, and a
            concern can be composed out of a registry composition. A required
            attr arriving this way makes the target type's validity depend on
            an optional provider — the failure is silent: drop the provider
            and the type stays registered while its required-attr rule stops
            firing, so invalid metadata begins loading clean. A genuinely
            required attr is OWN and belongs with its type, in the type's own
            provider — never via ``extend``. Fails CLOSED: the offending attr
            is not appended before the raise.

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

        origin = self._current_provider_id or LIBRARY_ATTR_ORIGIN
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
            # ADR-0050: a REQUIRED attr may never be PROJECTED onto someone else's
            # type. A provider may only project OPTIONAL attributes onto a type it
            # does not own — a required attr registered this way disappears,
            # silently, whenever that provider is composed out. If the attr is
            # genuinely required, it is OWN: declare it with the type instead, in
            # the type's own provider. Checked (and raised) before the attr is
            # appended, so the offending attr is never half-applied.
            if attr.required:
                raise ParseError(
                    f'TypeRegistry.extend: attribute "{attr.name}" being added to '
                    f'"{type_}.{sub_type}" is REQUIRED. A provider may only project '
                    f"OPTIONAL attributes onto a type it does not own — a required "
                    f"attr registered this way disappears, silently, whenever that "
                    f"provider is composed out. Declare it with the type instead "
                    f"(ADR-0050).",
                    ErrorCode.ERR_EXTEND_REQUIRED_ATTR,
                )
            definition.attrs.append(attr)
            # #265 — stamp the extending provider as this attr's origin.
            self._attr_provenance[(type_, sub_type, attr.name)] = origin

        for rule in child_rules or []:
            definition.child_rules.append(rule)
