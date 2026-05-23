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
