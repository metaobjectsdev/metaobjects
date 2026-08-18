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
from .overwrite_policy import decide_and_write, has_hash_manifest

_VALID_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# How many refused paths to name before falling back to "…and N more". Mirrors
# codegen-ts's MAX_NAMED / C#'s maxNamed — the same cutoff, so the three ports'
# no-manifest warnings read the same shape.
_MAX_NAMED_REFUSALS = 5


@dataclass
class RunGenResult:
    files: list[tuple[str, str]] = field(default_factory=list)  # (path, status)
    warnings: list[str] = field(default_factory=list)


def _objects(root: MetaData) -> list[MetaObject]:
    # ADR-0039 sanctioned own: top-level object scan on the loader ROOT
    # (metadata.root is never extended, so own == effective).
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

    # Captured BEFORE any write, because the first write creates the manifest — read
    # it afterwards and every project looks migrated.
    tracking_hashes = config.gen_state_dir is not None
    had_manifest = tracking_hashes and has_hash_manifest(config.gen_state_dir or "")

    refused: list[str] = []
    for full, (content, _by) in emitted.items():
        rel = os.path.relpath(full, config.out_dir)
        status = decide_and_write(
            full,
            content,
            merge_strategy,
            gen_state_dir=config.gen_state_dir,
            rel_path=rel,
        )
        result.files.append((full, status))
        if status == "refused":
            refused.append(rel)

    if refused:
        if not tracking_hashes:
            # No state to reason from, so decide_and_write can only have refused for
            # ONE reason: the file carries no @generated marker. Reporting the
            # hash-manifest message here would describe a mechanism that is not
            # running and send the reader to fix the wrong thing.
            for rel in refused:
                result.warnings.append(
                    f"Refused to overwrite {rel}: the file exists and carries no "
                    f"@generated header, so it is treated as hand-written."
                )
        elif not had_manifest:
            # Every refusal here has the SAME cause and the same one-line fix, so
            # stating it once beats a wall of per-file warnings that buries the
            # instruction. Self-extinguishing: once the manifest exists, never again.
            shown = ", ".join(refused[:_MAX_NAMED_REFUSALS])
            more = (
                f", and {len(refused) - _MAX_NAMED_REFUSALS} more"
                if len(refused) > _MAX_NAMED_REFUSALS
                else ""
            )
            result.warnings.append(
                f"Refused to overwrite {len(refused)} existing file(s), and this project "
                f"has no codegen hash manifest — so codegen cannot tell your edits from "
                f"its own stale output, and will not guess. Commit "
                f"'.metaobjects/.gen-state/.hashes.json' and re-run. Files: {shown}{more}."
            )
        else:
            for rel in refused:
                result.warnings.append(
                    f"Refused to overwrite {rel}: it has been edited since it was "
                    f"generated, or there is no record of generating it. Move your edits "
                    f"into a non-generated file, or delete it to accept fresh output."
                )
    return result
