"""run_gen — the codegen orchestrator. Mirrors codegen-ts/src/runner.ts."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Callable

from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.shared.base_types import TYPE_OBJECT
from .config import GenConfig
from .constants import generated_package_init
from .generator import GenContext, Generator
from .overwrite_policy import decide_and_write

_VALID_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


@dataclass
class RunGenResult:
    files: list[tuple[str, str]] = field(default_factory=list)  # (path, status)
    warnings: list[str] = field(default_factory=list)


def _objects(root: MetaData) -> list[MetaObject]:
    return [c for c in root.own_children()
            if c.type == TYPE_OBJECT and isinstance(c, MetaObject)]


def _matcher(gen: Generator) -> Callable[[MetaObject], bool]:
    flt = getattr(gen, "filter", None)
    if callable(flt):
        return flt  # type: ignore[no-any-return]

    def _all(_e: MetaObject) -> bool:
        return True

    return _all


def _warn_collector(name: str, sink: list[str]) -> Callable[[str], None]:
    def warn(msg: str) -> None:
        sink.append(f"[{name}] {msg}")

    return warn


def run_gen(
    config: GenConfig,
    metadata: MetaData,
    *,
    generators: list[Generator],
    entity_filter: list[str] | None = None,
    merge_strategy: str = "overwrite",
) -> RunGenResult:
    result = RunGenResult()
    if not isinstance(metadata, MetaRoot):
        raise ValueError("run_gen: metadata must be a loaded MetaRoot.")

    objs = _objects(metadata)
    if entity_filter is not None:
        objs = [o for o in objs if o.name in entity_filter]

    if not objs:
        reason = (
            "no object children match the provided entity_filter"
            if entity_filter is not None
            else "root has no object children"
        )
        result.warnings.append(f"No entities to generate — {reason}.")
        return result

    safe: list[MetaObject] = []
    for o in objs:
        if not _VALID_NAME.match(o.name):
            result.warnings.append(
                f"Skipping entity with unsafe name {o.name!r} — must match ^[A-Za-z_]\\w*$."
            )
            continue
        safe.append(o)
    if not safe:
        return result

    emitted: dict[str, tuple[str, str]] = {}  # full_path -> (content, generated_by)
    for gen in generators:
        ctx = GenContext(
            entities=safe,
            loaded_root=metadata,
            matches=_matcher(gen),
            config=config,
            warn=_warn_collector(gen.name, result.warnings),
        )
        for f in gen.generate(ctx):
            full = os.path.join(config.out_dir, f.path)
            if full in emitted:
                raise ValueError(
                    f"Output path collision: {full!r} emitted by "
                    f"{emitted[full][1]!r} and {gen.name!r}."
                )
            emitted[full] = (f.content, gen.name)

    # Make the out dir an importable package: emit an @generated __init__.py in
    # every directory that received a generated file (and the intermediate dirs up
    # to out_dir). The generated modules use package-relative imports, so without
    # this a consumer can't import them. A generator-emitted __init__.py wins; a
    # hand-authored one is left untouched by the overwrite policy below.
    if config.emit_package_init:
        pkg_rel_dirs: set[str] = set()
        for full in list(emitted):
            d = os.path.dirname(os.path.relpath(full, config.out_dir))
            while True:
                pkg_rel_dirs.add(d)
                if d == "":
                    break
                d = os.path.dirname(d)
        for d in pkg_rel_dirs:
            init_full = os.path.join(config.out_dir, d, "__init__.py")
            if init_full not in emitted:
                emitted[init_full] = (generated_package_init(), "package-init")

    for full, (content, _by) in emitted.items():
        status = decide_and_write(full, content, merge_strategy)
        result.files.append((full, status))
        if status == "refused":
            result.warnings.append(
                f"Refused to overwrite {full}: file exists without the @generated header."
            )
    return result
