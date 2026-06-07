"""ADR-0021 D3 — stable-name generator registry (Python port).

Generators are identified by a STABLE string id (e.g. ``entity``, ``routes``,
``render-helper``) rather than by a language-specific factory import. The id is
the cross-port contract: the same logical generator carries the same stable name
in every port. This module is the discoverability + identity surface behind
``metaobjects gen --list`` and the ``--generators a,b`` selection path.

It is ADDITIVE. The default suite in ``cli.py`` (``_default_generators``) and the
``run_gen(..., generators=[...])`` factory-array path keep working unchanged — the
registry powers ``--list`` and stable identity; it does not replace those paths.

The registry's name set is conformance-tested for SET EQUALITY against the Python
slice of the canonical manifest
(``fixtures/generator-registry-conformance/registry.json``): exactly the manifest
entries whose ``ports`` array includes ``python``. All Python entries are
``tier: native``.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from metaobjects.codegen.generator import Generator
from metaobjects.codegen.generators.entity_model import entity_model
from metaobjects.codegen.generators.extractor_generator import extractor_generator
from metaobjects.codegen.generators.filter_allowlist_generator import (
    filter_allowlist_generator,
)
from metaobjects.codegen.generators.output_parser_generator import (
    output_parser_generator,
)
from metaobjects.codegen.generators.output_prompt_generator import (
    output_prompt_generator,
)
from metaobjects.codegen.generators.payload_vo_generator import payload_vo_generator
from metaobjects.codegen.generators.render_helper_generator import (
    render_helper_generator,
)
from metaobjects.codegen.generators.router_generator import router_generator
from metaobjects.codegen.generators.template_generator import template_generator
from metaobjects.codegen.generators.trace_helper_generator import trace_helper_generator
from metaobjects.render.verify import InMemoryProvider

GeneratorTier = str  # "native" | "neutral"


@dataclass(frozen=True)
class GeneratorEntry:
    """A registry entry: stable name + one-line description + tier + factory."""

    #: Stable, cross-port-consistent id. Equals the registry map key.
    name: str
    #: One-line (no newline) human description for ``--list``.
    description: str
    #: "native" = recommended ``metaobjects gen`` suite; "neutral" = ``meta docs``-owned.
    tier: GeneratorTier
    #: Constructs the generator with sensible defaults. Calling it must not throw.
    factory: Callable[[], Generator]


def _template_primitive() -> Generator:
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


def _render_helper_default() -> Generator:
    """Construct ``render-helper`` with a default ``template_root``.

    The factory ctor only requires ``template_root`` to be non-empty (it builds a
    ``FilesystemProvider`` lazily; no disk access at construction). Real use passes
    the caller's on-disk template root via the factory-array config path; this
    default exists only so registry identity + ``--list`` construct without throwing.
    """
    return render_helper_generator(template_root="templates")


#: Stable name -> GeneratorEntry. The 10 native generators whose manifest `ports`
#: include `python` (ADR-0021 D3). Set-equality conformance-tested vs the manifest.
GENERATOR_REGISTRY: dict[str, GeneratorEntry] = {
    "entity": GeneratorEntry(
        name="entity",
        description="Per-entity model/class — the entity module (table-backed or value object).",
        tier="native",
        factory=entity_model,
    ),
    "routes": GeneratorEntry(
        name="routes",
        description="Per-entity REST endpoint surface (controllers / routes / router).",
        tier="native",
        factory=router_generator,
    ),
    "output-parser": GeneratorEntry(
        name="output-parser",
        description="Per-template tolerant output parser (recover-on-receipt).",
        tier="native",
        factory=output_parser_generator,
    ),
    "output-prompt": GeneratorEntry(
        name="output-prompt",
        description="Per-template output-format prompt fragment generator.",
        tier="native",
        factory=output_prompt_generator,
    ),
    "render-helper": GeneratorEntry(
        name="render-helper",
        description="Per-template.output render helper (document/email typed wrappers).",
        tier="native",
        factory=_render_helper_default,
    ),
    "extractor": GeneratorEntry(
        name="extractor",
        description="Per-template strict typed extract<Name> helper (strict payload extraction).",
        tier="native",
        factory=extractor_generator,
    ),
    "template": GeneratorEntry(
        name="template",
        description="Generic Mustache template primitive (walk + template -> files).",
        tier="native",
        factory=_template_primitive,
    ),
    "filter-allowlist": GeneratorEntry(
        name="filter-allowlist",
        description="Per-entity REST filter allowlist (queryable-field guard).",
        tier="native",
        factory=filter_allowlist_generator,
    ),
    "payload": GeneratorEntry(
        name="payload",
        description="Per-template payload value object (the strict payload type).",
        tier="native",
        factory=payload_vo_generator,
    ),
    "trace-helper": GeneratorEntry(
        name="trace-helper",
        description="Per-entity typed record<Entity> LLM-trace helper (extract + buildLlmCallRow + persist).",
        tier="native",
        factory=trace_helper_generator,
    ),
}


def list_generators() -> list[GeneratorEntry]:
    """All registry entries, sorted by stable name."""
    return sorted(GENERATOR_REGISTRY.values(), key=lambda e: e.name)


def get_generator(name: str) -> GeneratorEntry | None:
    """Resolve a generator entry by its stable id, or ``None`` if unknown."""
    return GENERATOR_REGISTRY.get(name)
