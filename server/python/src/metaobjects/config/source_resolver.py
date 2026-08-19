from __future__ import annotations

from pathlib import Path

from metaobjects.errors import ErrorCode, ParseError

from .neutral_config import DEFAULT_METADATA_DIR, read_neutral_config

_SUPPORTED_SUFFIXES = (".json", ".yaml", ".yml")

#: Directory excluded at every level of `_list_metadata_files` — drafts that
#: are deliberately not part of the loaded model. Mirrors TypeScript's
#: `PENDING_DIR` in `metadata-files.ts` and the loader's own
#: `DirectorySource` (`loader/sources/directory_source.py`).
_PENDING_DIR = "_pending"


def _list_metadata_files(directory: Path) -> list[Path]:
    """Recursively list metadata files under ``directory``.

    Mirrors `DirectorySource`'s extension set (`.json`/`.yaml`/`.yml`,
    case-insensitive) AND its `_pending/`-at-any-depth exclusion. Order is
    this port's own and is deliberately NOT a cross-port contract — see the
    corpus README.
    """
    return sorted(
        (
            p
            for p in directory.rglob("*")
            if p.is_file()
            and p.suffix.lower() in _SUPPORTED_SUFFIXES
            and _PENDING_DIR not in p.relative_to(directory).parts[:-1]
        ),
        key=lambda p: p.name,
    )


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

    seen: dict[Path, None] = {}

    for spec in specs:
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
            seen.setdefault(f.resolve(), None)

    return list(seen)


def resolve_collection(root: Path) -> list[Path]:
    """The full ladder: declared `sources`, else the default directory.

    Only the DEFAULT may be absent — a declared source that does not resolve is
    `ERR_SOURCE_UNRESOLVED`, a louder failure.
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

    return resolve_sources(root, specs)
