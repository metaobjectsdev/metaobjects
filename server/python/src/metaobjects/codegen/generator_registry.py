"""ADR-0021 D3 — stable-name generator registry (Python port).

Generators are identified by a STABLE string id (e.g. ``entity``, ``routes``,
``render-helper``) rather than by a language-specific factory import. The id is
the cross-port contract: the same logical generator carries the same stable name
in every port. This module is the discoverability + identity surface behind
``metaobjects gen --list`` and the ``--generators a,b`` selection path.

It is the ONLY name-based door. ADR-0034 Amendment 2 made codegen opt-in and DELETED
the default suite this note used to name (``cli._default_generators``): a run that
selects no generator generates nothing and raises ``NoGeneratorsSelectedError``. The
``run_gen(..., generators=[...])`` factory-array path remains for in-process callers,
where ``generators`` is likewise required.

The registry's name set is conformance-tested for SET EQUALITY against the Python
slice of the canonical manifest
(``fixtures/generator-registry-conformance/registry.json``): exactly the manifest
entries whose ``ports`` array includes ``python``. All Python entries are
``tier: native``.
"""
from __future__ import annotations

import tempfile
from dataclasses import dataclass
from typing import Callable

from metaobjects.codegen.generator import Generator
from metaobjects.codegen.generators.entity_model import entity_model
from metaobjects.codegen.generators.extractor_generator import extractor_generator
from metaobjects.codegen.generators.filter_allowlist_generator import (
    filter_allowlist_generator,
)
from metaobjects.codegen.generators.names_generator import names_generator
from metaobjects.codegen.generators.output_parser_generator import (
    output_parser_generator,
)
from metaobjects.codegen.generators.output_prompt_generator import (
    output_prompt_generator,
)
from metaobjects.codegen.generators.render_helper_generator import (
    render_helper_generator,
)
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.codegen.generators.template_generator import template_generator
from metaobjects.codegen.generators.trace_helper_generator import trace_helper_generator
from metaobjects.render.verify import InMemoryProvider

GeneratorTier = str  # "native" | "neutral"

#: The six layers a generator can belong to — the axis an adopter SELECTS BY, gated
#: cross-port against the manifest exactly as ``tier`` is. Six, not ten: an earlier
#: draft split ``capability`` four ways, each with ONE member, and a layer with one
#: member does no grouping work. ``capability`` holds the generators the MODEL has
#: already chosen (you declared a ``template.prompt``), which is why they are found
#: by probing a real model rather than by browsing a taxonomy.
GENERATOR_LAYERS: tuple[str, ...] = (
    "model",
    "persistence",
    "api",
    "client",
    "docs",
    "capability",
)

GeneratorLayer = str  # one of GENERATOR_LAYERS


@dataclass(frozen=True)
class GeneratorBuildContext:
    """Extra inputs a factory may need to construct a generator.

    Today only the on-disk template root, required by ``render-helper``'s build-time
    drift gate and used by the ``template`` primitive. Optional so ``--list`` can
    construct every entry without supplying one — a factory must never throw.

    Ported from the C# port's ``GeneratorBuildContext`` rather than invented here, so
    the two registries answer "what does a factory need" the same way. Before this, the
    Python factory took no arguments at all and ``_render_helper_default`` hardcoded
    ``template_root="templates"``: the CLI's ``--templates`` never reached the
    generator, so ``metaobjects gen --generators render-helper`` resolved templates from
    a directory the user had not named and, in a project that keeps them anywhere else,
    from a directory that does not exist.
    """

    #: The on-disk directory template refs resolve under. ``None`` = not supplied
    #: (``--list``, registry identity), which every factory must tolerate.
    template_root: str | None = None


@dataclass(frozen=True)
class GeneratorEntry:
    """A registry entry: stable name + one-line description + tier + layer + factory."""

    #: Stable, cross-port-consistent id. Equals the registry map key.
    name: str
    #: One-line (no newline) human description for ``--list``.
    description: str
    #: "native" = recommended ``metaobjects gen`` suite; "neutral" = ``meta docs``-owned.
    tier: GeneratorTier
    #: The selection axis — one of :data:`GENERATOR_LAYERS`. Gated cross-port.
    layer: GeneratorLayer
    #: Constructs the generator. Calling it — even with an empty
    #: :class:`GeneratorBuildContext` — must not throw; ``--list`` relies on that.
    factory: Callable[[GeneratorBuildContext], Generator]
    #: Stable names of the generators whose output this one imports. ADR-0056: the template
    #: tier imports a value object's model from the ``entity`` generator's module and
    #: declares none of its own, so wiring it without ``entity`` emits a dangling import.
    #: Not gated cross-port (the manifest carries no such column); surfaced by ``--list``
    #: and warned about by :func:`unsatisfied_requires`.
    requires: tuple[str, ...] = ()
    #: The packaged factory an adopter copies with ``metaobjects eject`` (ADR-0034
    #: Amendment 3). Its module is the file copied; its name is the ``module:symbol``
    #: symbol the copy is wired by. ``None`` = not ejectable (the ``template`` primitive
    #: has no emit logic of its own to own).
    source: Callable[..., Generator] | None = None

    @property
    def source_module(self) -> str | None:
        """Dotted module path of the file ``eject`` copies, or ``None``."""
        return self.source.__module__ if self.source is not None else None

    @property
    def symbol(self) -> str | None:
        """The factory name an owned copy exports, or ``None``."""
        return self.source.__name__ if self.source is not None else None


def _template_primitive(_ctx: GeneratorBuildContext) -> Generator:
    """A no-op default for the ``template`` PRIMITIVE generator.

    ``template_generator`` requires caller-supplied ``template`` / ``walk`` /
    ``provider`` (it is not a zero-config per-entity emitter). For registry
    identity + ``--list`` we expose a default that constructs a valid Generator
    without throwing and walks to zero outputs; real use passes opts via the
    factory-array config path. Mirrors the TS ``templatePrimitive()``.
    """
    return template_generator(
        name="template",
        template="",
        walk=lambda _root: [],
        provider=InMemoryProvider(),
    )


def _render_helper_default(ctx: GeneratorBuildContext) -> Generator:
    """Construct ``render-helper`` against the caller's on-disk template root.

    The ctor requires ``template_root`` to be non-empty for its build-time drift gate
    (it builds a ``FilesystemProvider`` lazily; no disk access at construction). With
    no root supplied — ``--list``, registry identity — we hand it a harmless temp dir
    so construction never throws, exactly as the C# registry does.

    It used to hardcode ``"templates"`` here and the CLI never passed anything, so the
    generator was effectively unreachable: selecting it resolved templates from a
    directory the user had not named, whatever ``--templates`` said.
    """
    return render_helper_generator(
        template_root=ctx.template_root or tempfile.gettempdir())


#: Stable name -> GeneratorEntry. The 10 native generators whose manifest `ports`
#: include `python` (ADR-0021 D3). Set equality, tier AND layer are conformance-tested
#: against the manifest.
GENERATOR_REGISTRY: dict[str, GeneratorEntry] = {
    "entity": GeneratorEntry(
        name="entity",
        description=(
            "Per-entity model/class — the entity module (table-backed or value object). "
            "[A field with @stringFormat email is typed pydantic EmailStr, which imports "
            "email-validator when the class is defined, so the consuming project needs "
            "`pydantic[email]` — without it the generated module fails at import.]"
        ),
        tier="native",
        layer="model",
        factory=lambda _ctx: entity_model(),
        source=entity_model,
    ),
    "routes": GeneratorEntry(
        name="routes",
        description="Per-entity REST endpoint surface (controllers / routes / router).",
        tier="native",
        layer="api",
        factory=lambda _ctx: router_generator(),
        source=router_generator,
    ),
    "output-parser": GeneratorEntry(
        name="output-parser",
        description="Per-template tolerant output parser (recover-on-receipt).",
        tier="native",
        layer="capability",
        factory=lambda _ctx: output_parser_generator(),
        requires=("entity",),
        source=output_parser_generator,
    ),
    "output-prompt": GeneratorEntry(
        name="output-prompt",
        description="Per-template output-format prompt fragment generator.",
        tier="native",
        layer="capability",
        factory=lambda _ctx: output_prompt_generator(),
        source=output_prompt_generator,
    ),
    "render-helper": GeneratorEntry(
        name="render-helper",
        description="Per-renderable-template render helper (typed wrappers; document/email for a template.output, the document shape for a template.prompt).",
        tier="native",
        layer="capability",
        factory=_render_helper_default,
        requires=("entity",),
        source=render_helper_generator,
    ),
    "extractor": GeneratorEntry(
        name="extractor",
        description="Per-template strict typed extract<Name> helper (strict payload extraction).",
        tier="native",
        layer="capability",
        factory=lambda _ctx: extractor_generator(),
        requires=("entity",),
        source=extractor_generator,
    ),
    "template": GeneratorEntry(
        name="template",
        description="Generic Mustache template primitive (walk + template -> files).",
        tier="native",
        layer="capability",
        factory=_template_primitive,
    ),
    "filter-allowlist": GeneratorEntry(
        name="filter-allowlist",
        description="Per-entity REST filter allowlist (queryable-field guard).",
        tier="native",
        layer="api",
        factory=lambda _ctx: filter_allowlist_generator(),
        source=filter_allowlist_generator,
    ),
    "names": GeneratorEntry(
        name="names",
        description="Per-entity physical database name constants (table/view name, schema, column names).",
        tier="native",
        layer="model",
        factory=lambda _ctx: names_generator(),
        source=names_generator,
    ),
    "trace-helper": GeneratorEntry(
        name="trace-helper",
        description="Per-entity typed record<Entity> LLM-trace helper (extract + buildLlmCallRow + persist).",
        tier="native",
        layer="capability",
        factory=lambda _ctx: trace_helper_generator(),
        source=trace_helper_generator,
    ),
}


def list_generators() -> list[GeneratorEntry]:
    """All registry entries, sorted by stable name."""
    return sorted(GENERATOR_REGISTRY.values(), key=lambda e: e.name)


def get_generator(name: str) -> GeneratorEntry | None:
    """Resolve a generator entry by its stable id, or ``None`` if unknown."""
    return GENERATOR_REGISTRY.get(name)


def unsatisfied_requires(names: list[str]) -> list[str]:
    """One warning per selected generator whose ``requires`` is not also selected.

    Advisory, never an error: an adopter may keep a hand-written module at the path the
    missing generator would have emitted. Mirrors the TS ``warnUnsatisfiedRequires``."""
    selected = set(names)
    warnings: list[str] = []
    for name in names:
        entry = GENERATOR_REGISTRY.get(name)
        if entry is None:
            continue
        missing = [dep for dep in entry.requires if dep not in selected]
        if not missing:
            continue
        listed = ", ".join(f'"{m}"' for m in missing)
        warnings.append(
            f'"{name}" is selected but {listed} {"is" if len(missing) == 1 else "are"} not. '
            f'The code "{name}" emits imports the value-object models {listed} would have '
            f"emitted, so importing it will fail. Add {listed} to --generators, or keep your "
            "own hand-written models at those module paths."
        )
    return warnings
