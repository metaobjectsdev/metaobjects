from __future__ import annotations

import os
from pathlib import Path
from typing import Callable

from metaobjects.errors import ErrorCode, ParseError
from metaobjects.loader.sources import DirectorySource
from metaobjects.naming import package_of_resolution_key
from metaobjects.scope import compile_scope, matches_scope

from .dependencies import (
    Collection,
    ResolvedDependency,
    explicitly_includes,
    read_lock,
    verify_snapshot,
)
from .neutral_config import DEFAULT_METADATA_DIR, NeutralConfig, read_neutral_config


def _list_metadata_files(directory: Path) -> list[Path]:
    """Recursively list metadata files under ``directory``.

    Delegates to the loader's own `DirectorySource` — the SAME code the loader
    uses to turn a directory into metadata files — rather than re-walking with
    a second, driftable definition of "which files count as metadata" (extension
    set). Order is this port's own and is deliberately NOT a cross-port contract
    — see the corpus README.

    `exclude_pending=True`: this IS the CLI-facing resolver — `_pending/` is the
    TypeScript CLI's pending/promote-workflow concept, not a loader concept, so
    the loader-level `DirectorySource` default (off) is overridden here, the one
    place this port's CLI turns it on.
    """
    return [fs.path for fs in DirectorySource(directory, exclude_pending=True).expand()]


def _normalize(p: Path) -> Path:
    """Absolute + lexically normalized (``.``/``..`` collapsed), WITHOUT
    resolving symlinks.

    `Path.resolve()` does both jobs at once — and following symlinks here is
    the wrong half: it would silently rewrite a source declared as a symlink
    (e.g. `sources: [{"path": "link"}]` where `link -> real`) to its target's
    real name, diverging from the other three ports, none of which collapse a
    walked path's symlinked directory components (Java's
    `toAbsolutePath().normalize()`, C#'s `Path.GetFullPath()`, TypeScript's
    `path.resolve()` are all lexical-only, like this). `os.path.abspath` is
    exactly that: anchor to cwd if relative, then `normpath` — no filesystem
    symlink lookups.
    """
    return Path(os.path.abspath(p))


def _validate_kinds(specs: list[dict[str, str]]) -> None:
    """Validate every spec's kind before ANY filesystem access.

    Mirrors `sources.ts`'s `orderedPathSpecs` (`.map(toPathSpec)` runs over the
    whole list before `resolveSources` performs a single `stat()`): a kind
    check interleaved with resolution, one spec at a time, would make which
    error code comes back depend on declaration order — `{"path": "nope"},
    {"resource": "x"}` and its reverse must both report
    `ERR_SOURCE_KIND_UNSUPPORTED`, never `ERR_SOURCE_UNRESOLVED` on one
    ordering and the kind error on the other.
    """
    for spec in specs:
        if "path" not in spec:
            kind = next(iter(spec), "<empty>")
            raise ParseError(
                f'source kind "{kind}" is not supported by this toolchain yet; use a "path" source',
                code=ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED,
            )


def resolve_sources(config_dir: Path, specs: list[dict[str, str]]) -> list[Path]:
    """Resolve a declared source SET to a de-duplicated list of metadata files.

    A relative ``path`` resolves against ``config_dir`` — the directory HOLDING
    the ``.metaobjects/`` folder — never against the process working directory.
    """
    # Whole-list kind validation FIRST — see `_validate_kinds`.
    _validate_kinds(specs)

    # Resolve in CONTENT order (ordinal path-string sort), not declared order —
    # mirrors `orderedPathSpecs` in `sources.ts` (kind-validated, then sorted by
    # `JSON.stringify(spec)`, which for a validated `path`-only spec reduces to
    # the path string alone). Does not change the resolved file SET (the `seen`
    # de-dup below is order-independent); only decides which declared path's
    # `ERR_SOURCE_UNRESOLVED` fires first when more than one is simultaneously
    # unresolvable.
    ordered_specs = sorted(specs, key=lambda s: s["path"])

    seen: dict[Path, None] = {}

    for spec in ordered_specs:
        raw = Path(spec["path"])
        target = raw if raw.is_absolute() else (config_dir / raw)

        if not target.exists():
            raise ParseError(
                f'source path "{spec["path"]}" does not exist '
                f"(resolved to {target}, relative to {config_dir})",
                code=ErrorCode.ERR_SOURCE_UNRESOLVED,
            )

        found = _list_metadata_files(target) if target.is_dir() else [target]
        for f in found:
            seen.setdefault(_normalize(f), None)

    return list(seen)


def _make_in_migrate_scope(
    migrate_scope: list[str] | None,
    imported_packages: frozenset[str],
    has_dependencies: bool,
) -> Callable[[str], bool] | None:
    """Build `Collection.in_migrate_scope` — mirrors the TS `inMigrateScope`
    for completeness (T18 ruling: nothing in the Python CLI's own `gen`/
    `verify --codegen` path consumes this; schema is TS-owned, ADR-0015).

    `None` iff the project declares no `migrate.scope` AND resolves no
    dependencies — the byte-identical path a caller reads as "admits
    everything" (`collection.in_migrate_scope(fqn) if ... else True`).
    """
    if migrate_scope is None and not has_dependencies:
        return None
    compiled = compile_scope(include=migrate_scope)

    def predicate(fqn: str) -> bool:
        if not matches_scope(fqn, compiled):
            return False
        pkg = package_of_resolution_key(fqn)
        if pkg not in imported_packages:
            return True
        return explicitly_includes(migrate_scope, pkg)

    return predicate


def _collection_from_own_files(
    root: Path, own_files: list[Path], cfg: NeutralConfig | None
) -> Collection:
    """The tail shared by `resolve_collection_full` (own files via the source
    ladder) and `build_collection` (own files from an external surface, e.g.
    a native `metaobjects.config.yaml` `metadata:` key) — dependencies, scope
    and migrate.scope come from `root`'s neutral `.metaobjects/config.json`
    regardless of where `own_files` came from (DESIGN §2.3: dependencies are
    read at EVERY rung of the source ladder).
    """
    dependency_specs: list[dict[str, str]] = cfg.dependencies if cfg is not None else []
    scope_include: list[str] = cfg.scope_include if cfg is not None else []
    migrate_scope: list[str] | None = cfg.migrate_scope if cfg is not None else None

    lock = read_lock(root)
    dependencies: list[ResolvedDependency] = (
        [] if not dependency_specs and lock is None else verify_snapshot(root, dependency_specs, lock)
    )

    imported_packages: frozenset[str] = frozenset(
        pkg for dep in dependencies for pkg in dep.packages
    )
    imported_nodes: frozenset[str] = frozenset(node for dep in dependencies for node in dep.nodes)

    # The artifacts LEAD the file list, in dependency-NAME order (verify_snapshot's
    # own return order) — see `Collection.files`.
    dep_paths = [Path(dep.artifact_path) for dep in dependencies]
    file_ids: dict[Path, str] = {p: dep.source_id for p, dep in zip(dep_paths, dependencies)}
    own_files_t = tuple(own_files)

    return Collection(
        files=tuple(dep_paths) + own_files_t,
        own_files=own_files_t,
        file_ids=file_ids,
        dependencies=tuple(dependencies),
        imported_packages=imported_packages,
        imported_nodes=imported_nodes,
        scope_include=tuple(scope_include),
        in_migrate_scope=_make_in_migrate_scope(
            migrate_scope, imported_packages, has_dependencies=bool(dependencies)
        ),
    )


def build_collection(root: Path, own_files: list[Path]) -> Collection:
    """Build a full `Collection` for an EXTERNALLY-determined own-files set —
    e.g. rung 2 of the CLI's source-resolution ladder (`metadata:` in a native
    `metaobjects.config.yaml`) — while dependencies/scope/migrate.scope still
    come from `root`'s neutral `.metaobjects/config.json` (DESIGN §2.3:
    dependencies are read by every port at EVERY rung of the source ladder,
    not just the declared-`sources`/default-directory rungs `resolve_collection_full`
    covers on its own).
    """
    root = root.resolve()
    return _collection_from_own_files(root, own_files, read_neutral_config(root))


def resolve_collection_full(root: Path) -> Collection:
    """The full ladder, FR-023-aware: declared `sources` (else the default
    directory) for this project's OWN files, plus its resolved dependencies
    (DESIGN §4.2) leading the file list, plus the `scope`/`migrate.scope`
    predicates every action surface reads (DESIGN §11.1 item 2).

    Only the DEFAULT source directory may be absent — a declared source that
    does not resolve is `ERR_SOURCE_UNRESOLVED`, a louder failure.
    """
    root = root.resolve()
    cfg = read_neutral_config(root)
    specs = cfg.sources if cfg is not None and cfg.sources else []

    if not specs:
        default_dir = root / DEFAULT_METADATA_DIR
        if not default_dir.is_dir():
            raise ParseError(
                f'no metadata sources declared in {root} and no default '
                f'"{DEFAULT_METADATA_DIR}" directory found. Declare "sources" in '
                f".metaobjects/config.json, or run 'meta init' to scaffold.",
                code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
            )
        specs = [{"path": DEFAULT_METADATA_DIR}]

    own_files = resolve_sources(root, specs)
    return _collection_from_own_files(root, own_files, cfg)


def resolve_collection(root: Path) -> list[Path]:
    """The full ladder: declared `sources`, else the default directory.

    A thin projection of `resolve_collection_full` (T18 ruling) — this
    project's OWN files only, never a dependency's snapshot artifact, so its
    public shape (and every pre-FR-023 caller) is unchanged.
    """
    return list(resolve_collection_full(root).own_files)
