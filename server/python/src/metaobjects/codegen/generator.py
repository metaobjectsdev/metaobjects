"""Codegen plugin engine — Generator protocol + per-entity/once-per-run helpers.
Mirrors server/typescript/packages/codegen-ts/src/generator.ts."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Protocol

from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.meta_data import MetaData
from .config import GenConfig


@dataclass
class EmittedFile:
    path: str            # relative to GenConfig.out_dir
    content: str         # final, formatted Python source
    generated_by: str = ""  # set by the runner from Generator.name


@dataclass
class GenContext:
    entities: list[MetaObject]
    loaded_root: MetaData | None
    matches: Callable[[MetaObject], bool]
    config: GenConfig
    warn: Callable[[str], None]


class Generator(Protocol):
    name: str

    def generate(self, ctx: GenContext) -> list[EmittedFile]: ...


def per_entity(
    fn: Callable[[MetaObject, GenContext], "EmittedFile | list[EmittedFile]"],
) -> Callable[[GenContext], list[EmittedFile]]:
    """One-file-per-entity convenience; selects via ctx.matches."""

    def run(ctx: GenContext) -> list[EmittedFile]:
        out: list[EmittedFile] = []
        for e in ctx.entities:
            if not ctx.matches(e):
                continue
            r = fn(e, ctx)
            out.extend(r if isinstance(r, list) else [r])
        return out

    return run


def once_per_run(
    fn: Callable[[list[MetaObject], GenContext], "EmittedFile | list[EmittedFile]"],
) -> Callable[[GenContext], list[EmittedFile]]:
    """Called once with all matching entities (barrels / cross-entity files)."""

    def run(ctx: GenContext) -> list[EmittedFile]:
        matched = [e for e in ctx.entities if ctx.matches(e)]
        r = fn(matched, ctx)
        return r if isinstance(r, list) else [r]

    return run


def per_package(
    fn: Callable[[str, list[MetaObject], GenContext], "EmittedFile | list[EmittedFile]"],
) -> Callable[[GenContext], list[EmittedFile]]:
    """One-file-per-package convenience. Groups matched entities by effective
    package, runs ``fn(pkg, entities, ctx)`` once per package (packages ascending,
    entities keeping ``ctx.entities`` order). The package scope from
    codegen-concepts §10 (object + model already exist via per_entity + per_model)."""

    def run(ctx: GenContext) -> list[EmittedFile]:
        # Local import avoids a module cycle (template_data imports nothing from here).
        from metaobjects.codegen.template_codegen.template_data import package_of

        by_pkg: dict[str, list[MetaObject]] = {}
        for e in ctx.entities:
            if not ctx.matches(e):
                continue
            by_pkg.setdefault(package_of(e), []).append(e)
        out: list[EmittedFile] = []
        for pkg in sorted(by_pkg):
            r = fn(pkg, by_pkg[pkg], ctx)
            out.extend(r if isinstance(r, list) else [r])
        return out

    return run


#: App-scope alias — run once over the whole model. The canonical name for the
#: one-shot scope (``once_per_run`` stays as a soft-deprecated alias; "run" is
#: ambiguous under multi-target output, ``per_model`` names the data scope).
per_model = once_per_run
