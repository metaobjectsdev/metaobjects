"""run_gen — the codegen orchestrator. Mirrors codegen-ts/src/runner.ts."""
from __future__ import annotations

import os
import re
from dataclasses import dataclass, field
from typing import Callable

from metaobjects.meta.meta_root import MetaRoot
from metaobjects.meta.meta_data import MetaData
from metaobjects.meta.core.object.meta_object import MetaObject
from metaobjects.meta.core.object.object_constants import OBJECT_SUBTYPE_REPORT
from metaobjects.meta.core.reporting.report_read_model import report_read_model
from metaobjects.shared.base_types import TYPE_OBJECT
from .collection_name_collision import assert_no_collection_name_collisions
from .config import GenConfig
from .constants import generated_package_init
from .generator import GenContext, Generator
from .import_path import OUTPUT_LAYOUT_PACKAGE
from .name_claims import NameClaims, assert_importable_package_tree
from .instance_artifacts import is_served_report
from .overwrite_policy import (
    STATUS_OVERWROTE_EDIT,
    HashManifest,
    decide_and_write,
    has_hash_manifest,
    manifest_batch,
    objects_of_root,
    set_placement_objects,
)

_VALID_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# How many refused paths to name before falling back to "…and N more". Mirrors
# codegen-ts's MAX_NAMED / C#'s maxNamed — the same cutoff, so the three ports'
# no-manifest warnings read the same shape.
_MAX_NAMED_REFUSALS = 5


@dataclass
class RunGenResult:
    files: list[tuple[str, str]] = field(default_factory=list)  # (path, status)
    warnings: list[str] = field(default_factory=list)
    #: Which generator emitted each path (``verify --codegen`` reads it to apply a
    #: generator's ``handEdits`` to the file).
    generated_by: dict[str, str] = field(default_factory=dict)
    #: How many files were written outside the project root (never recorded).
    untracked: int = 0


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
    select: Callable[[str], bool] | None = None,
    merge_strategy: str = "overwrite",
    in_ledger: Callable[[str], bool] | None = None,
    entity_scope: list[str] | None = None,
) -> RunGenResult:
    """Mirrors ``codegen-ts``'s ``runner.ts``.

    ``entity_filter`` (``gen --entities``) narrows what is WRITTEN: per-entity files for
    the named entities only, while every generator still sees the whole model in
    ``ctx.entities`` (``ctx.selected`` says which entities were named). ``entity_scope``
    narrows the model itself — a config target's declared ``entities``.

    ``select`` (FR-023 §11.1 item 2) — applied AFTER ``entity_filter``, over each
    object's ``resolution_key()`` (never the bare name — two packages may declare
    the same short name). Normally a resolved ``Collection``'s ``in_scope``: the
    output filter that excludes an imported dependency's objects from codegen
    unless the project's own ``scope.include`` names their package. ``None`` (the
    default) admits everything, byte-identical to a project with no dependencies.
    A generator that renders once over the WHOLE selected set (the shared-enums
    module, so far the only one) reads it off ``ctx.entities`` like any other
    generator — no separate wiring needed, since that list is already the
    post-``select`` set (parity with the TS ``codegen-ts`` runner's ``select``).
    """
    result = RunGenResult()
    if not isinstance(metadata, MetaRoot):
        raise ValueError("run_gen: metadata must be a loaded MetaRoot.")

    objs = _objects(metadata)
    model_has_objects = bool(objs)
    # The WHOLE model in scope. `entity_filter` narrows what is written, never what a
    # generator sees: a whole-model file (shared enums, the duration codec, the report
    # writers, relation targets in the object index) rendered from the filtered set would
    # shrink to it, and `gen <Entity>` would rewrite those files for one entity.
    #
    # ``entity_scope`` is the one thing that does shrink it: a config target's declared
    # ``entities``, which IS that target's model (two targets may split one out dir by
    # entity, and each must render its shared files from its own half).
    whole = [
        o for o in objs
        if (entity_scope is None or o.name in entity_scope)
        and (select is None or select(o.resolution_key()))
    ]
    if entity_filter is not None:
        objs = [o for o in objs if o.name in entity_filter]
    if select is not None:
        objs = [o for o in objs if select(o.resolution_key())]

    if not objs:
        if not model_has_objects:
            reason = "root has no object children"
        elif entity_filter is not None:
            reason = "no object children match the provided entity_filter"
        elif select is not None:
            reason = "no object children survived the collection's scope"
        result.warnings.append(f"No entities to generate — {reason}.")
        # A model with no objects at all still has something for a generator that documents
        # the whole model (api-docs writes its index pages), so that run goes on; a selection
        # that matched nothing stops here, as before.
        if model_has_objects:
            return result

    # FR-044: a served report (Table A) is generated from its read model, which the
    # read-only generators emit as a keyless object. Every other report generates nothing:
    # a sourceless report, or one over a kind the lowering skips, has no relation to read.
    # Decided here, at the entity set every generator reads, and not per generator.
    def _generatable(candidates: list[MetaObject]) -> list[MetaObject]:
        return [
            report_read_model(o, metadata) if o.sub_type == OBJECT_SUBTYPE_REPORT else o
            for o in candidates
            if o.sub_type != OBJECT_SUBTYPE_REPORT or is_served_report(o)
        ]

    narrowed = entity_filter is not None
    selected_objs = _generatable(objs)
    selected_keys = {o.resolution_key() for o in [*objs, *selected_objs]}

    def is_selected(o: MetaObject) -> bool:
        return o.resolution_key() in selected_keys

    if not selected_objs and not result.warnings:
        result.warnings.append(
            "No entities to generate — every selected object is an object.report with no "
            "view source, which has no generated output (FR-044)."
        )
        return result

    safe: list[MetaObject] = []
    for o in _generatable(whole) if narrowed else selected_objs:
        if not _VALID_NAME.match(o.name):
            if is_selected(o):
                result.warnings.append(
                    f"Skipping entity with unsafe name {o.name!r} — must match ^[A-Za-z_]\\w*$."
                )
            continue
        safe.append(o)
    if selected_objs and not any(is_selected(o) for o in safe):
        return result

    # Refuse before any generator runs — the one choke point that sees the WHOLE
    # entity set every route/router-emitting generator below reads from.
    assert_no_collection_name_collisions(safe)

    claims = NameClaims()  # one registry per run, shared by every generator
    emitted: dict[str, tuple[str, str]] = {}  # full_path -> (content, generated_by)
    for gen in generators:
        ctx = GenContext(
            entities=safe,
            loaded_root=metadata,
            matches=_matcher(gen),
            config=config,
            warn=_warn_collector(gen.name, result.warnings),
            generators=tuple(g.name for g in generators),
            in_ledger=in_ledger,
            claims=claims,
            selected=is_selected if narrowed else None,
        )
        for f in gen.generate(ctx):
            full = os.path.join(config.out_dir, f.path)
            if full in emitted:
                raise ValueError(
                    f"Output path collision: {full!r} emitted by "
                    f"{emitted[full][1]!r} and {gen.name!r}."
                )
            emitted[full] = (f.content, gen.name)

    if config.output_layout == OUTPUT_LAYOUT_PACKAGE:
        assert_importable_package_tree(
            [os.path.relpath(full, config.out_dir).replace(os.sep, "/") for full in emitted]
        )

    # Make the out dir an importable package: emit an @generated __init__.py in
    # every directory that received a generated file (and the intermediate dirs up
    # to out_dir). The generated modules use package-relative imports, so without
    # this a consumer can't import them. A generator-emitted __init__.py wins; a
    # hand-authored one is left untouched by the overwrite policy below.
    #
    # Only directories that hold a generated PYTHON module: an adopter's own generator
    # emitting JSON Schema or OpenAPI into `schemas/` is not writing a package, and an
    # `__init__.py` there is litter that makes the tree look importable.
    if config.emit_package_init:
        pkg_rel_dirs: set[str] = set()
        for full in [p for p in emitted if p.endswith(".py")]:
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
    set_placement_objects(config.gen_state_dir, objects_of_root(metadata))
    had_manifest = tracking_hashes and has_hash_manifest(config.gen_state_dir or "")

    refused: list[str] = []
    adopted: list[str] = []
    # ONE manifest session for the whole write loop (ADR-0064 decision 1): loaded here,
    # saved once below, and only when an entry changed. A caller that runs several passes
    # hands in its own session through ``config.manifest`` and saves it itself.
    own_session = config.manifest is None and config.gen_state_dir is not None
    session = config.manifest
    if session is None and config.gen_state_dir is not None:
        session = HashManifest(config.gen_state_dir)
    # ``manifest_batch`` joins an outer batch (the CLI's), so the file is still written once
    # per gen-state dir however many passes run.
    with manifest_batch(config.gen_state_dir):
        try:
            _write_all(
                config, emitted, merge_strategy, session, result, refused, adopted
            )
        finally:
            if own_session and session is not None:
                session.save()
    return _finish(result, config, emitted, refused, adopted, tracking_hashes, had_manifest)


def _write_all(
    config: GenConfig,
    emitted: dict[str, tuple[str, str]],
    merge_strategy: str,
    session: HashManifest | None,
    result: RunGenResult,
    refused: list[str],
    adopted: list[str],
) -> None:
    for full, (content, by) in emitted.items():
        result.generated_by[full] = by
        if config.sink is not None:
            config.sink[full] = content
            result.files.append((full, "new"))
            continue
        # The out-dir-relative name: what the manifest used to be keyed by, and still
        # what a refusal is REPORTED as (it is the name the reader sees in `--out`).
        rel = os.path.relpath(full, config.out_dir)
        # The manifest key. Project-root-relative when the caller knows the project, so
        # two runs with different --out cannot collide on one key inside the single
        # manifest that is anchored on that project. `rel` rides along as the legacy
        # spelling so an existing manifest keeps working and converges on the new one.
        # BOTH SIDES RESOLVED. `project_root` arrives resolved (project_root_for calls
        # .resolve()) while `full` is built from the raw `out_dir`, and relpath between a
        # resolved anchor and an unresolved path is not the path between the two
        # directories — under a directory symlink it walks OUT of the project
        # (`../link/gen/X.py`). Every key then points outside, `_is_ours_for` matches
        # none of them, and `verify --codegen` prints `in sync (0 file(s))` over stale
        # output. The pre-existing `relpath(full, out_dir)` was immune by accident: both
        # sides came from the same unresolved string, so it was symmetric. Symmetry is
        # the property, and resolving both is how it is kept deliberately.
        key = (
            os.path.relpath(os.path.realpath(full), config.project_root)
            if config.project_root
            else rel
        )
        # A file written OUTSIDE the project has no place in the project's manifest: its
        # key would be `../`-relative and committed into `.hashes.json`. It gets the
        # manifest-less rule a run with no project gets — written, never recorded.
        outside = bool(config.project_root) and (key.startswith("..") or os.path.isabs(key))
        if outside:
            result.untracked += 1
        status = decide_and_write(
            full,
            content,
            merge_strategy,
            gen_state_dir=None if outside else config.gen_state_dir,
            rel_path=key,
            legacy_rel_path=rel if key != rel else None,
            baseline=config.baseline,
            hand_edits="overwrite" if by in config.overwrite_hand_edits else "keep",
            manifest=None if outside else session,
        )
        result.files.append((full, status))
        if status == STATUS_OVERWROTE_EDIT:
            result.warnings.append(
                f"overwrote hand-edited {rel} with fresh output (handEdits: overwrite on {by})"
            )
        if status == "refused":
            refused.append(rel)
        elif status == "adopted":
            adopted.append(rel)


def _finish(
    result: RunGenResult,
    config: GenConfig,
    emitted: dict[str, tuple[str, str]],
    refused: list[str],
    adopted: list[str],
    tracking_hashes: bool,
    had_manifest: bool,
) -> RunGenResult:
    untracked = result.untracked
    if untracked:
        result.warnings.append(
            f"{untracked} generated file(s) were written outside the project root and are "
            f"not recorded in .metaobjects/.gen-state/.hashes/, so hand-edit protection "
            f"does not apply to them beyond the @generated header rule."
        )

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
                f"its own stale output, and will not guess. This is the expected first run "
                f"for a project created before the manifest was committed. ONE-TIME FIX: "
                f"re-run with --baseline=adopt — it records the files you have as the "
                f"baseline and writes NOTHING — then commit "
                f"'.metaobjects/.gen-state/.hashes/' and run gen again, where the "
                f"regeneration arrives as its own reviewable diff. Adopting DECLARES these "
                f"files to be generated output, so an edit already inside one of them is "
                f"part of the baseline and that regeneration will replace it — commit "
                f"before you run it. Files: {shown}{more}."
            )
        else:
            for rel in refused:
                result.warnings.append(
                    f"Refused to overwrite {rel}: it has been edited since it was "
                    f"generated, or there is no record of generating it. Move your edits "
                    f"into a non-generated file, or delete it to accept fresh output."
                )

    if adopted:
        # Aggregated for the same reason the no-manifest refusal is: one cause, one next
        # step. Reported even though nothing failed, because a run that writes nothing and
        # exits 0 is otherwise indistinguishable from a no-op, while the file it DID
        # produce (the manifest) is the one that now has to be committed.
        shown = ", ".join(adopted[:_MAX_NAMED_REFUSALS])
        more = (
            f", and {len(adopted) - _MAX_NAMED_REFUSALS} more"
            if len(adopted) > _MAX_NAMED_REFUSALS
            else ""
        )
        result.warnings.append(
            f"Recorded {len(adopted)} existing file(s) as the codegen baseline and wrote "
            f"nothing. NEXT: commit '.metaobjects/.gen-state/.hashes/', then run gen "
            f"again — these files regenerate normally from here, as their own reviewable "
            f"diff. Adopting DECLARED them to be generated output: an edit already inside "
            f"one is part of the baseline and that regeneration will replace it, so check "
            f"the diff against git. Files: {shown}{more}."
        )
    return result
