"""``metaobjects docs`` — the docs run: the generators that write the reference pages, and
the collision-checked write.

The api reference is a generator (``api-docs``, ``docs_surface = "api"``), so a project can
own it with ``metaobjects eject api-docs``. The owned copy is listed in the config's
``docs.generators`` — never the top-level ``generators`` ``gen`` runs — and ``docs`` runs it
in place of the packaged one. Engine code: an owned copy imports none of it.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from metaobjects.codegen.config import GenConfig
from metaobjects.codegen.eject import build_owned
from metaobjects.codegen.generator import (
    DOCS_SURFACE_API,
    DocsRunFacts,
    GenContext,
    Generator,
)
from metaobjects.codegen.generator_registry import GENERATOR_REGISTRY, GeneratorBuildContext
from metaobjects.meta.meta_data import MetaData


@dataclass
class DocsOutcome:
    #: ``(path relative to the docs out dir, content)`` in emission order.
    files: list[tuple[str, str]] = field(default_factory=list)
    #: A user-facing failure (duplicate page path, bad ``docs.generators`` entry), or ``None``.
    error: str | None = None


def resolve_docs_generators(
    specs: list[str], root: Path,
) -> tuple[list[Generator], str | None]:
    """The generators ``docs`` runs: each owned entry in *specs* (``docs.generators``), then
    the packaged generator for every surface no owned one takes over.

    An entry that is not a docs generator (no ``docs_surface``) or a second one for a
    surface already taken is refused by name: either would write the same pages twice, or
    write code into the docs tree."""
    ctx = GeneratorBuildContext()
    owned: list[Generator] = []
    taken: dict[str, str] = {}
    for spec in specs:
        gen, err = build_owned(spec, root, ctx)
        if err is not None or gen is None:
            return [], err
        surface = getattr(gen, "docs_surface", None)
        if surface is None:
            return [], (
                f"docs.generators entry {spec!r} is not a docs generator: it carries no "
                "`docs_surface`. A generator that writes code belongs in a target's "
                "`generators`."
            )
        if surface in taken:
            return [], (
                f"docs.generators lists two generators for the {surface!r} surface: "
                f"{taken[surface]!r} and {spec!r}."
            )
        taken[surface] = spec
        owned.append(gen)
    if DOCS_SURFACE_API not in taken:
        owned.append(GENERATOR_REGISTRY["api-docs"].factory(ctx))
    return owned, None


def run_docs(
    root: MetaData, out_dir: str, facts: DocsRunFacts, generators: list[Generator],
) -> DocsOutcome:
    """Run *generators* over *root* and collect their pages, failing on a duplicate page path
    BEFORE anything is written (the caller writes ``outcome.files``)."""
    outcome = DocsOutcome()
    seen: dict[str, str] = {}
    for gen in generators:
        ctx = GenContext(
            entities=[],
            loaded_root=root,
            matches=lambda _e: True,
            config=GenConfig(out_dir=out_dir),
            warn=lambda _msg: None,
            docs=facts,
        )
        for f in gen.generate(ctx):
            if f.path in seen:
                outcome.error = f"docs — duplicate api page output path: {f.path}"
                return outcome
            seen[f.path] = gen.name
            outcome.files.append((f.path, f.content))
    return outcome
