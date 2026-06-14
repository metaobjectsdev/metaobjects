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
    "layout.json",
    "object.json",
    "origin.json",
    "prompt.json",
    "relationship.json",
    "source.json",
    "template.json",
    "ui.json",
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
    uses, plus the structural cardinality fields B2 will consume."""

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

    def all_type_keys(self) -> list[tuple[str, str]]:
        """All registered ``(type, subType)`` keys parsed from the JSON (diagnostics)."""
        return list(self._declared_keys)


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
