"""FR-033 — the Python reader for the shared ``spec/metamodel/*.json`` files.

The 15 JSON files (one per concern provider) are the cross-port single source of
truth for every type / attr / common-attr **description** (+ optional
``rules``/``example``/``whenToUse``). They are byte-identical across the ports by
design, so each port READS them rather than hand-copying the prose — the exact
duplication FR-033 kills.

This module embeds committed copies of the 15 files **inside the package** (beside
this ``__init__.py``, in ``metaobjects/spec_metamodel/``) and reads them via
``importlib.resources`` — AOT-safe (ships with the wheel, no arbitrary filesystem
scan). A byte-identity gate test (``tests/conformance/test_spec_metamodel_embed.py``)
asserts each embedded copy equals the repo-root ``spec/metamodel/<name>.json``
source so the copies cannot silently drift.

The reader parses the embedded JSON into an in-memory model and exposes, per
``(type, subType)``: the type ``DocFacet`` (description + rules/example/whenToUse)
and, per attr (by name), the attr ``DocFacet`` (+ array flag / cardinality). The
universal ``*.*`` entry's attr children are the documentation common attrs.

Resolution honours the ``extends`` blocks (db/ui/prompt JSON). An attr declared in
a top-level ``extends`` directive (e.g. ``db.json``'s ``@column`` on ``field.*``,
or ``@autoSet`` on ``field: [date, time, timestamp]``) applies additively to the
matching subtypes. :meth:`SpecMetamodelReader.attr_doc` resolves a requested
``(type, subType, attrName)`` by checking, in order: the exact ``types[].children``
entry, the matching ``extends`` block (exact subType / ``"*"`` wildcard / list
membership), then the ``<type>.base`` fallback (the JSON's ``extendsBase``
inheritance). Mirrors the Java ``SpecMetamodelReader``.

The reader does NOT enforce or build the strict children graph / cardinality /
per-subtype scoping — that is sub-step B2. The model it parses (incl. structural
children + cardinality) is the durable foundation B2 extends; B1 uses only the
description-resolution surface.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from importlib import resources

#: The 15 shared provider-definition file names (keep in lockstep with the
#: repo-root ``spec/metamodel/`` directory — the byte-identity gate enforces it).
SPEC_FILES: tuple[str, ...] = (
    "attr.json",
    "db.json",
    "documentation.json",
    "field.json",
    "identity.json",
    "index.json",
    "layout.json",
    "object.json",
    "origin.json",
    "prompt.json",
    "relationship.json",
    "requirement.json",
    "source.json",
    "template.json",
    "ui.json",
    "ui-web.json",
    "validator.json",
    "view.json",
)

#: Wildcard token used in the JSON for "any type / any subType".
_WILDCARD = "*"

#: The abstract base subtype name (the ``extendsBase`` inheritance root per type).
_BASE_SUBTYPE = "base"


@dataclass(frozen=True)
class DocFacet:
    """One documented metamodel facet (a type/subType) — its description plus the
    optional doc fields. Any may be ``None`` when absent in the JSON."""

    description: str | None = None
    rules: str | None = None
    example: str | None = None
    when_to_use: str | None = None


@dataclass(frozen=True)
class AttrEntry:
    """An attr child entry parsed from the JSON — the description-bearing facet B1
    uses, plus the structural cardinality fields B2 will consume.

    FR-033 (provider re-home): ``allowed_values`` / ``default`` are additionally
    parsed so a DATA-DRIVEN provider (``metaobjects-ui`` / ``metaobjects-prompt``)
    can build a fully-specified ``AttrSchema`` from a JSON ``extends`` entry —
    single-sourced, never hand-copied. ``required`` is derived (``min == 1``)."""

    name: str
    sub_type: str | None
    is_array: bool
    min: int | None
    max: int | None
    max_is_null: bool
    description: str | None = None
    rules: str | None = None
    example: str | None = None
    when_to_use: str | None = None
    allowed_values: tuple[str, ...] | None = None
    default: object | None = None

    @property
    def required(self) -> bool:
        """Whether this attr is required — the JSON encodes requiredness as ``min: 1``."""
        return self.min == 1


@dataclass(frozen=True)
class StructChild:
    """FR-033 (sub-step B2a) — one STRUCTURAL child entry parsed from a type's
    ``children`` list (every ``type != "attr"`` entry), carrying the strict
    cross-port cardinality. ``child_sub_type``/``child_name`` default to ``"*"``
    when omitted; ``max_is_null`` distinguishes a declared ``max: null`` (unbounded)
    from an absent ``max``; ``named`` is the optional named-placement flag."""

    child_type: str
    child_sub_type: str
    child_name: str
    min: int | None
    max: int | None
    max_is_null: bool
    named: bool | None


def _struct_key(c: "StructChild") -> str:
    """The ``composeWithBase`` de-dupe key for a structural child (matches the Java
    ``SpecMetamodelReader.structKey``)."""
    return f"{c.child_type} {c.child_sub_type} {c.child_name}"


@dataclass(frozen=True)
class _ExtendsBlock:
    type: str
    sub_types: tuple[str, ...]
    wildcard_sub_type: bool
    attrs: dict[str, AttrEntry]


@dataclass
class SpecMetamodelReader:
    """Parsed view over the embedded ``spec/metamodel/*.json`` provider files."""

    # (type, subType) -> the type's own DocFacet
    _type_docs: dict[tuple[str, str], DocFacet] = field(default_factory=dict)
    # (type, subType) -> attrName -> AttrEntry (from the types[].children attr entries)
    _type_attr_docs: dict[tuple[str, str], dict[str, AttrEntry]] = field(default_factory=dict)
    # (type, subType) -> the type's OWN structural children (pre-extendsBase composition)
    _type_struct_children: dict[tuple[str, str], list[StructChild]] = field(default_factory=dict)
    # (type, subType) -> True when the subtype additively inherits <type>.base's children
    _type_extends_base: dict[tuple[str, str], bool] = field(default_factory=dict)
    # every (type, subType) key that appeared in a spec file
    _declared_keys: set[tuple[str, str]] = field(default_factory=set)
    # extends directives: matcher + its attr entries (applied additively)
    _extends_blocks: list[_ExtendsBlock] = field(default_factory=list)
    # the universal *.* common-attr entries (the documentation vocabulary), by name
    _common_attr_docs: dict[str, AttrEntry] = field(default_factory=dict)

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------

    @classmethod
    def load(cls) -> "SpecMetamodelReader":
        """Load + parse the 15 embedded ``spec/metamodel/*.json`` files via
        ``importlib.resources`` (off the package, AOT-safe)."""
        reader = cls()
        pkg = resources.files(__package__)
        for name in SPEC_FILES:
            resource = pkg / name
            try:
                text = resource.read_text(encoding="utf-8")
            except FileNotFoundError as exc:  # pragma: no cover - packaging guard
                raise RuntimeError(
                    f"FR-033: embedded spec/metamodel file missing from the package: "
                    f"{name} (it must be committed under metaobjects/spec_metamodel/)."
                ) from exc
            try:
                reader._parse(json.loads(text))
            except ValueError as exc:
                raise RuntimeError(
                    f"FR-033: failed parsing embedded spec file {name}: {exc}"
                ) from exc
        return reader

    def _parse(self, provider: dict) -> None:
        for t in provider.get("types") or []:
            type_ = t.get("type")
            sub_type = t.get("subType")
            if type_ == _WILDCARD and sub_type == _WILDCARD:
                # The universal *.* entry: its attr children are the common attrs.
                for a in self._parse_attr_children(t):
                    self._common_attr_docs[a.name] = a
                continue
            key = (type_, sub_type)
            self._declared_keys.add(key)
            self._type_docs[key] = DocFacet(
                description=t.get("description"),
                rules=t.get("rules"),
                example=t.get("example"),
                when_to_use=t.get("whenToUse"),
            )
            attrs = self._type_attr_docs.setdefault(key, {})
            for a in self._parse_attr_children(t):
                attrs[a.name] = a
            # B2a — the type's OWN structural children + extendsBase flag.
            self._type_struct_children[key] = self._parse_struct_children(t)
            self._type_extends_base[key] = bool(t.get("extendsBase"))

        for e in provider.get("extends") or []:
            type_ = e.get("type")
            sub_el = e.get("subType")
            sub_types: list[str] = []
            wildcard = False
            if isinstance(sub_el, list):
                sub_types = [str(s) for s in sub_el]
            elif sub_el is not None:
                if sub_el == _WILDCARD:
                    wildcard = True
                else:
                    sub_types = [str(sub_el)]
            attrs: dict[str, AttrEntry] = {}
            for a in self._parse_attr_children(e):
                attrs[a.name] = a
            self._extends_blocks.append(
                _ExtendsBlock(type_, tuple(sub_types), wildcard, attrs)
            )

    @staticmethod
    def _parse_attr_children(owner: dict) -> list[AttrEntry]:
        out: list[AttrEntry] = []
        for c in owner.get("children") or []:
            if c.get("type") != "attr":
                continue  # structural child — parsed for B2; B1 reads only attr docs
            has_max = "max" in c
            max_val = c.get("max")
            allowed = c.get("allowedValues")
            out.append(
                AttrEntry(
                    name=c.get("name"),
                    sub_type=c.get("subType"),
                    is_array=bool(c.get("isArray")),
                    min=c.get("min"),
                    max=max_val if max_val is not None else None,
                    max_is_null=has_max and max_val is None,
                    description=c.get("description"),
                    rules=c.get("rules"),
                    example=c.get("example"),
                    when_to_use=c.get("whenToUse"),
                    allowed_values=tuple(allowed) if allowed is not None else None,
                    default=c.get("default"),
                )
            )
        return out

    @staticmethod
    def _parse_struct_children(owner: dict) -> list[StructChild]:
        out: list[StructChild] = []
        for c in owner.get("children") or []:
            child_type = c.get("type")
            if child_type is None or child_type == "attr":
                continue  # attr children are the attrs block (B1) — not structural
            has_max = "max" in c
            max_val = c.get("max")
            out.append(
                StructChild(
                    child_type=child_type,
                    child_sub_type=c.get("subType") if c.get("subType") is not None else _WILDCARD,
                    child_name=c.get("name") if c.get("name") is not None else _WILDCARD,
                    min=c.get("min"),
                    max=max_val if max_val is not None else None,
                    max_is_null=has_max and max_val is None,
                    named=c.get("named"),
                )
            )
        return out

    # ------------------------------------------------------------------
    # Lookup surface (B1)
    # ------------------------------------------------------------------

    def type_doc(self, type_: str, sub_type: str) -> DocFacet | None:
        """The ``(type, subType)`` doc facet, or ``None`` when the JSON has no such entry."""
        return self._type_docs.get((type_, sub_type))

    def attr_doc(self, type_: str, sub_type: str, attr_name: str) -> AttrEntry | None:
        """Resolve an attr's doc entry for a ``(type, subType)`` — exact
        ``types[].children`` entry first, then any matching ``extends`` block, then
        the ``<type>.base`` fallback (the JSON's ``extendsBase`` inheritance).
        ``None`` when no JSON source declares this attr for this subtype."""
        exact = self._attr_doc_exact(type_, sub_type, attr_name)
        if exact is not None:
            return exact
        if sub_type != _BASE_SUBTYPE:
            return self._attr_doc_exact(type_, _BASE_SUBTYPE, attr_name)
        return None

    def _attr_doc_exact(self, type_: str, sub_type: str, attr_name: str) -> AttrEntry | None:
        direct = self._type_attr_docs.get((type_, sub_type))
        if direct is not None:
            a = direct.get(attr_name)
            if a is not None:
                return a
        for b in self._extends_blocks:
            if b.type != type_:
                continue
            if b.wildcard_sub_type or sub_type in b.sub_types:
                a = b.attrs.get(attr_name)
                if a is not None:
                    return a
        return None

    def common_attr_doc(self, name: str) -> AttrEntry | None:
        """The universal ``*.*`` common-attr doc entry by name, or ``None``."""
        return self._common_attr_docs.get(name)

    def is_declared(self, type_: str, sub_type: str) -> bool:
        """Whether the JSON declares this ``(type, subType)`` at all (so a caller can
        distinguish "described with an empty children list" from "absent from the
        spec", e.g. ``metadata.root``)."""
        return (type_, sub_type) in self._declared_keys

    # ------------------------------------------------------------------
    # Strict constraint surface (B2)
    # ------------------------------------------------------------------

    def structural_children(self, type_: str, sub_type: str) -> list[StructChild]:
        """FR-033 (sub-step B2a) — the STRICT structural children for
        ``(type, subType)``, composed with ``<type>.base`` when the subtype carries
        ``extendsBase: true`` (the TS ``composeWithBase`` rule: base children ∪ own
        children, additively). Returns the type's OWN structural children when not
        declared ``extendsBase`` (the base subtype itself, or a non-composing
        concern). Returns an empty list when the type is declared with no structural
        children (an attr-only type) — callers gate on :meth:`is_declared` first.

        Order is base-then-own; the emitter sorts the final children block, so order
        here is not load-bearing. De-dupe by ``(child_type, child_sub_type,
        child_name)`` keeps the OWN entry (own-wins), mirroring ``composeWithBase``.
        Mirrors the Java ``SpecMetamodelReader.structuralChildren``."""
        own = self._type_struct_children.get((type_, sub_type), [])
        extends_base = self._type_extends_base.get((type_, sub_type), False)
        if not extends_base or sub_type == _BASE_SUBTYPE:
            return list(own)
        base = self._type_struct_children.get((type_, _BASE_SUBTYPE), [])
        merged: dict[str, StructChild] = {}
        for b in base:
            merged[_struct_key(b)] = b
        for o in own:
            merged[_struct_key(o)] = o  # own wins on overlap
        return list(merged.values())

    def strict_attr_names(self, type_: str, sub_type: str) -> set[str]:
        """FR-033 (sub-step B2b) — the STRICT per-subtype attr-name allow-list for
        ``(type, subType)``: the attr names the cross-port golden scopes to this
        subtype. Composed from the shared JSON exactly as TS composes it:

        - the subtype's OWN ``types[].children`` attr entries, PLUS
        - ``<type>.base``'s attrs when the subtype carries ``extendsBase: true``
          (the ``composeWithBase`` rule — base attrs ∪ own attrs; the base subtype
          contributes only its own), PLUS
        - every ``extends`` block (db/ui/prompt JSON) whose matcher targets this
          ``(type, subType)`` — an exact subType, a list membership, or the ``"*"``
          wildcard (e.g. db.json's ``@column`` on ``field.*``, ``@storage`` on
          ``field.object``, ``@autoSet`` on ``field.[date, time, timestamp]``).

        Callers gate on :meth:`is_declared` first — an undeclared ``(type, subType)``
        (e.g. ``metadata.root``, ``attr.*``) has no JSON-sourced strict set and must
        NOT be pruned. Mirrors the Java ``SpecMetamodelReader.strictAttrNames``."""
        names: set[str] = set()
        own = self._type_attr_docs.get((type_, sub_type))
        if own is not None:
            names.update(own.keys())
        extends_base = self._type_extends_base.get((type_, sub_type), False)
        if extends_base and sub_type != _BASE_SUBTYPE:
            base = self._type_attr_docs.get((type_, _BASE_SUBTYPE))
            if base is not None:
                names.update(base.keys())
        for b in self._extends_blocks:
            if b.type != type_:
                continue
            if b.wildcard_sub_type or sub_type in b.sub_types:
                names.update(b.attrs.keys())
        return names

    def all_type_keys(self) -> list[tuple[str, str]]:
        """All registered ``(type, subType)`` keys parsed from the JSON (diagnostics)."""
        return list(self._declared_keys)


@dataclass(frozen=True)
class ExtendsTarget:
    """FR-033 (provider re-home) — one resolved ``extends`` directive from a single
    provider file: the ``(type, subType)`` it enriches (``subType`` is ``"*"`` for a
    field-wide extend, an explicit subtype, or one of an explicit list) plus the
    ordered attr entries to add. A DATA-DRIVEN provider (``metaobjects-ui`` /
    ``metaobjects-prompt``) iterates these to ``registry.extend`` each target —
    single-sourced from the embedded JSON, never hand-copied."""

    type: str
    sub_type: str
    attrs: tuple[AttrEntry, ...]


def load_provider_extends(file_name: str) -> list[ExtendsTarget]:
    """Parse ONE embedded ``spec/metamodel/<file_name>`` provider file and return its
    ordered ``extends`` directives as :class:`ExtendsTarget`s (one per concrete
    ``(type, subType)``).

    A ``subType`` list in the JSON (e.g. db.json's ``@autoSet`` on
    ``field: [date, time, timestamp]``) expands to one target per member;
    ``subType: "*"`` is preserved as the literal ``"*"`` (the provider hands it to
    ``registry.extend`` per the field-wide subtype loop). The attr ENTRIES preserve
    JSON document order so the registered attr list matches TS.

    Used by ``ui_provider`` / ``prompt_provider`` to build their ``registry.extend``
    sets from the single shared source (FR-033 — kills the cross-port prose/attr
    duplication)."""
    pkg = resources.files(__package__)
    text = (pkg / file_name).read_text(encoding="utf-8")
    provider = json.loads(text)
    out: list[ExtendsTarget] = []
    for e in provider.get("extends") or []:
        type_ = e.get("type")
        sub_el = e.get("subType")
        attrs = tuple(SpecMetamodelReader._parse_attr_children(e))
        sub_types: list[str]
        if isinstance(sub_el, list):
            sub_types = [str(s) for s in sub_el]
        else:
            sub_types = [str(sub_el)]  # explicit subtype, or the literal "*"
        for st in sub_types:
            out.append(ExtendsTarget(type=type_, sub_type=st, attrs=attrs))
    return out


# ----------------------------------------------------------------------
# FR-033 S-B1 — apply spec descriptions onto a composed registry (pre-seal)
# ----------------------------------------------------------------------

# Module-level singleton: parse the embedded JSON once, reuse across composes.
_READER: SpecMetamodelReader | None = None


def _reader() -> SpecMetamodelReader:
    global _READER
    if _READER is None:
        _READER = SpecMetamodelReader.load()
    return _READER


def apply_spec_descriptions(registry) -> None:
    """Source every type / attr / common-attr description (+ rules/example/whenToUse)
    from the embedded ``spec/metamodel/*.json`` onto a composed (UNSEALED) registry.

    Single-sourced, byte-identical to TS — never hand-copied. Called from
    ``compose_registry`` after every provider has run and BEFORE the loader seals
    the registry, so both the default loader registry and the conformance registry
    carry descriptions.

    - **Type descriptions**: ``TypeDefinition`` is a mutable dataclass → set
      ``description``/``rules``/``example``/``when_to_use`` directly for each
      registered ``(type, subType)`` the JSON declares.
    - **Attr descriptions**: ``AttrSchema`` is frozen → rebuild each attr with its
      JSON ``description`` (matched by ``(type.subType, attrName)``, honouring
      ``extends`` blocks + the ``<type>.base`` fallback) via
      ``dataclasses.replace`` and replace it in the definition's ``attrs`` list. An
      attr with no JSON match keeps its existing (empty) description — that residual
      is the S-B2b per-subtype scoping mismatch.
    - **Common-attr descriptions**: rebuild each registered common attr with its
      description from the universal ``*.*`` entry in ``documentation.json``.

    Deferred imports avoid a registry → spec_metamodel import cycle.
    """
    from dataclasses import replace as _replace

    reader = _reader()

    # Type + per-type attr descriptions.
    for definition in registry._defs.values():  # noqa: SLF001 (no public iterator)
        facet = reader.type_doc(definition.type, definition.sub_type)
        if facet is not None:
            definition.description = facet.description or ""
            definition.rules = facet.rules
            definition.example = facet.example
            definition.when_to_use = facet.when_to_use

        new_attrs = []
        for attr in definition.attrs:
            a = reader.attr_doc(definition.type, definition.sub_type, attr.name)
            if a is not None:
                new_attrs.append(
                    _replace(
                        attr,
                        description=a.description or "",
                        rules=a.rules,
                        example=a.example,
                        when_to_use=a.when_to_use,
                    )
                )
            else:
                new_attrs.append(attr)
        definition.attrs[:] = new_attrs

    # FR-033 B2 — strict structural children + per-subtype attr scoping.
    _apply_strict_structural_children(registry, reader)
    _apply_strict_attr_scoping(registry, reader)

    # Common-attr descriptions (the universal *.* documentation vocabulary).
    new_common = []
    for attr in registry._common_attrs:  # noqa: SLF001
        a = reader.common_attr_doc(attr.name)
        if a is not None:
            new_common.append(
                _replace(
                    attr,
                    description=a.description or "",
                    rules=a.rules,
                    example=a.example,
                    when_to_use=a.when_to_use,
                )
            )
        else:
            new_common.append(attr)
    registry._common_attrs[:] = new_common  # noqa: SLF001


def _apply_strict_structural_children(registry, reader: SpecMetamodelReader) -> None:
    """FR-033 (sub-step B2a) — REPLACE every declared type's STRUCTURAL child_rules
    with the strict cross-port graph from ``spec/metamodel/*.json`` (extendsBase-
    composed), carrying cardinality (``min``/``max``/``named``). Python registers
    broad, cardinality-less structural wildcards (e.g. ``object.entity`` accepts
    field/identity/attr/source/relationship/layout/template; every field subtype
    inherits validator/view/origin); the strict graph is the intersection the
    cross-port golden carries. The any-attr wildcard (an ``attr`` child rule) and
    the per-type attr requirements are left UNTOUCHED here (attr scoping is B2b).
    Types NOT declared in the JSON (e.g. ``attr.*``) keep their existing children.

    Deferred import of the registry types avoids the provider import cycle.
    """
    from ..registry import ChildRule
    from ..shared.base_types import TYPE_ATTR

    for definition in registry._defs.values():  # noqa: SLF001
        if not reader.is_declared(definition.type, definition.sub_type):
            continue  # not in the spec → keep Python's existing structural children
        # Keep only the non-structural rules (the any-attr wildcard); drop every
        # broad structural placement, then add the strict graph.
        kept = [r for r in definition.child_rules if r.child_type == TYPE_ATTR]
        for sc in reader.structural_children(definition.type, definition.sub_type):
            kept.append(
                ChildRule(
                    child_type=sc.child_type,
                    child_sub_type=sc.child_sub_type,
                    child_name=sc.child_name,
                    min=sc.min,
                    max=sc.max,
                    max_is_null=sc.max_is_null,
                    named=sc.named,
                )
            )
        definition.child_rules[:] = kept


def _apply_strict_attr_scoping(registry, reader: SpecMetamodelReader) -> None:
    """FR-033 (sub-step B2b) — PRUNE every declared type's LOGICAL (INCLUDED) attrs
    down to the strict per-subtype allow-list the cross-port golden carries (sourced
    from ``spec/metamodel/*.json``, extendsBase- and extends-composed). Python
    registers some attrs broadly (e.g. ``@maxLength``/``@precision``/``@scale``/
    ``@objectRef``/``@storage``/``@autoSet`` on ``field.base`` + every field subtype,
    ``@discriminator``/``@discriminatorValue`` on every object subtype); the strict
    graph scopes each to exactly the subtypes the JSON declares (e.g. ``@maxLength``
    → ``field.string`` only, ``@autoSet`` → ``field.date``/``time``/``timestamp``,
    ``@discriminator*`` → ``object.entity``).

    CARVED-OUT attrs (the ``classify_per_type_attr`` exclusions — isArray/isAbstract/
    extends/implements/isInterface/object/objectAdapter/description) are LEFT
    REGISTERED: the emitter drops them from the manifest anyway and the loader still
    needs them. Only INCLUDED logical attrs are pruned — which also TIGHTENS the
    loader (a misplaced attr → ``ERR_UNKNOWN_ATTR``). Types NOT declared in the JSON
    keep their attrs untouched (no JSON-sourced strict set exists).

    #265 — the prune is PROVENANCE-scoped: only a LIBRARY-origin logical attr
    (registered by one of the library's own providers, or unstamped — see
    ``TypeRegistry.attr_origin`` / ``LIBRARY_ATTR_ORIGIN``) is prunable against
    the strict per-subtype allow-list. An attr a CONSUMER provider added via
    ``registry.extend()`` (e.g. a downstream app widening a spec-declared core
    subtype) is never pruned — the strict allow-list is a library-vocabulary
    contract, blind to consumer-registered vocabulary by design. This does not
    relax the check itself (still own-attrs-only, ADR-0039) and does not widen
    scoping for a misplaced LIBRARY attr just because a consumer provider
    happens to be composed in.

    Deferred import avoids the provider import cycle.
    """
    from ..core_types import LIBRARY_PROVIDER_IDS
    from ..registry import LIBRARY_ATTR_ORIGIN
    from ..registry_manifest import ExclusionReason, classify_per_type_attr

    for definition in registry._defs.values():  # noqa: SLF001
        if not reader.is_declared(definition.type, definition.sub_type):
            continue  # not in the spec → keep Python's existing attr scoping
        allow = reader.strict_attr_names(definition.type, definition.sub_type)
        kept = []
        for attr in definition.attrs:
            is_logical = classify_per_type_attr(attr.name) is ExclusionReason.INCLUDED
            prunable = is_logical and attr.name not in allow
            if prunable:
                origin = registry.attr_origin(definition.type, definition.sub_type, attr.name)
                is_library_origin = origin == LIBRARY_ATTR_ORIGIN or origin in LIBRARY_PROVIDER_IDS
                if is_library_origin:
                    continue  # library-origin logical attr not scoped to this subtype → prune
            kept.append(attr)
        definition.attrs[:] = kept
