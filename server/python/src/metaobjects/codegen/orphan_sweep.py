"""The orphan sweep: delete a file ``gen`` wrote earlier and no longer generates.

Mirrors the run-wide sweep in ``codegen-ts`` (``runner.ts`` / ``orphan-sweep.ts``), so every
port shares one rule (``docs/features/own-your-codegen.md``, "Files that are no longer
generated"):

- A candidate is a file under an output directory of a FULL run that the hash manifest
  records writing and that no generator of the run emitted. A file the manifest does not
  record is not ours, whatever its name, and is never touched.
- An untouched candidate (its content still hashes to what was recorded) is deleted and its
  manifest entry dropped.
- An edited candidate is REFUSED by name and stays recorded, so the refusal repeats until
  someone deletes the file or moves the edits.
- A recorded path whose file is already gone is forgotten.

The jurisdiction is the one ``verify --codegen`` convicts ``extra:`` files on
(``cli._is_ours_for``): the same disk walk, the same manifest keys, the same legacy
out-dir-relative fallback. ``gen`` therefore removes exactly the untouched files the gate
reports, which is what makes the gate's "regenerate" remedy work.

The caller decides whether a run may sweep at all: a run narrowed by ``--generators``,
``--entities`` or a ``--target`` that leaves out another target writing into the same
directory produces a subset of the output by construction, so every file of the unselected
part would look orphaned.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from .overwrite_policy import (
    _load_hashes,
    _save_hashes,
    content_hash,
    has_hash_manifest,
)

# Never walked: interpreter droppings and tool state, the same set ``verify --codegen``
# skips, so a candidate here is always a file the gate would also see.
_SKIPPED_DIRS = {"__pycache__", ".gen-state", ".metaobjects"}
_SKIPPED_SUFFIXES = {".pyc", ".pyo"}


@dataclass
class SweepResult:
    #: Absolute paths deleted (or, with ``dry_run``, that would be).
    removed: list[str] = field(default_factory=list)
    #: Project-relative paths of edited orphans, left in place.
    refused: list[str] = field(default_factory=list)
    #: Project-relative paths of edited orphans deleted anyway, because every generator
    #: writing into their directory is declared ``handEdits: overwrite``. Also in ``removed``.
    discarded: list[str] = field(default_factory=list)


def _under(path: Path, dirs: list[Path]) -> bool:
    return any(path.is_relative_to(d) for d in dirs)


def _walk(out_dir: Path, nested: list[Path] | None = None) -> list[Path]:
    if not out_dir.is_dir():
        return []
    files: list[Path] = []
    for p in sorted(out_dir.rglob("*")):
        if not p.is_file() or _under(p, nested or []):
            continue
        rel = p.relative_to(out_dir)
        if any(part in _SKIPPED_DIRS for part in rel.parts) or p.suffix in _SKIPPED_SUFFIXES:
            continue
        files.append(p)
    return files


def sweep_orphans(
    gen_state_dir: str,
    project_root: str,
    out_dirs: list[str],
    emitted: set[str],
    *,
    dry_run: bool = False,
    overwrite_dirs: frozenset[str] = frozenset(),
    exclude_nested: frozenset[str] = frozenset(),
) -> SweepResult:
    """Delete the untouched files under ``out_dirs`` that the manifest records and
    ``emitted`` (absolute paths this run produced, refused ones included) does not hold.

    In a directory of ``overwrite_dirs`` (every generator writing there is declared
    ``handEdits: overwrite``) an edited such file is deleted too, and listed in
    ``discarded``. A file under another output directory nested in a swept one, swept or
    listed in ``exclude_nested`` (every configured output directory), is that directory's,
    and is left alone. ``dry_run`` decides and reports without touching the disk or the
    manifest.
    """
    overwrite_real = {os.path.realpath(d) for d in overwrite_dirs}
    result = SweepResult()
    if not has_hash_manifest(gen_state_dir):
        return result
    hashes = _load_hashes(gen_state_dir)
    root = Path(project_root).resolve()
    emitted_real = {os.path.realpath(p) for p in emitted}
    forget: set[str] = set()

    resolved = list(dict.fromkeys(Path(out).resolve() for out in out_dirs))
    every_dir = set(resolved) | {Path(out).resolve() for out in exclude_nested}
    for out_path in resolved:
        nested = [o for o in every_dir if o != out_path and o.is_relative_to(out_path)]
        # The out dir relative to the project: the prefix that turns an out-dir-relative
        # name into a manifest key. Both sides resolved, as `cli._out_prefix` does.
        prefix = os.path.relpath(out_path, root)
        outside = prefix.startswith("..") or os.path.isabs(prefix)
        seen_keys: set[str] = set()
        for p in _walk(out_path, nested):
            if os.path.realpath(p) in emitted_real:
                continue
            rel = str(p.relative_to(out_path))
            key = os.path.join(prefix, rel)
            # A file written outside the project is never recorded (runner.py), so only
            # the legacy out-dir-relative spelling could match, and that spelling is
            # ambiguous across out dirs. Nothing outside the project is ours to delete.
            if outside:
                continue
            recorded_key = key if key in hashes else (rel if rel in hashes else None)
            if recorded_key is None:
                continue  # not ours
            seen_keys.add(key)
            try:
                with open(p, encoding="utf-8") as fh:
                    current = fh.read()
            except (UnicodeDecodeError, OSError):
                current = None
            if current is None:
                result.refused.append(key)
                continue
            if hashes[recorded_key] == content_hash(current):
                result.removed.append(str(p))
                forget.add(recorded_key)
            elif os.path.realpath(out_path) in overwrite_real:
                result.removed.append(str(p))
                result.discarded.append(key)
                forget.add(recorded_key)
            else:
                result.refused.append(key)
        # Recorded under this out dir, not emitted, and no longer on disk: forget it, so a
        # stranger's file created later under that name is not mistaken for ours.
        if not outside:
            for key in hashes:
                if key in seen_keys or not key.startswith(prefix + os.sep):
                    continue
                full = root / key
                if _under(full.resolve(), nested):
                    continue
                if os.path.realpath(full) in emitted_real or full.exists():
                    continue
                forget.add(key)

    if not dry_run:
        for path in result.removed:
            try:
                os.remove(path)
            except FileNotFoundError:
                pass
        if forget:
            _save_hashes(gen_state_dir, {k: v for k, v in hashes.items() if k not in forget})
    result.removed.sort()
    result.refused.sort()
    result.discarded.sort()
    return result


def refused_orphan_message(paths: list[str], owner: str = "metaobjects gen") -> str:
    """The warning for edited orphans. The same wording as ``codegen-ts``'s
    ``refusedOrphanMessage``: it says what happened, why nothing was deleted, and the two
    ways out, because an unexplained refusal invites deleting the file blind."""
    return (
        f"{owner}: {len(paths)} generated file(s) are no longer generated but have been "
        f"edited by hand, so they were NOT deleted: {', '.join(paths)}. Delete each one, or, "
        f"if what produced it was renamed, move your edits into the newly generated file "
        f"first and then delete it (regeneration cannot follow a rename)."
    )
