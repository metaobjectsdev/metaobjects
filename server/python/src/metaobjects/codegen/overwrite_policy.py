"""Per-file write decision.

Mirrors ``codegen-ts/src/overwrite-policy.ts``, minus the three-way merge (which
remains TS-only — it needs a snapshot of previously-written content and ``git
merge-file``).

WHY THIS IS NOT MARKER-BASED ANY MORE. The original rule refused a file whose
``@generated`` header was ABSENT and overwrote everything else. But a hand-edited
generated file still carries its header, so the single case worth protecting was the
single case that got overwritten — silently. And it was wrong in the other direction
too: a file this generator wrote, whose template later stopped emitting the header,
was refused as though it were somebody's hand-written source.

The decision now comes from a hash manifest at ``<gen_state_dir>/.hashes.json``,
recording what we wrote:

    identical fresh content              -> "unchanged"
    file still hashes to what we wrote   -> "overwrite"   (nothing is lost)
    hash mismatch, or no record at all   -> "refused"     (fail closed)

That file is meant to be COMMITTED — it is one hash per generated path, and it is the
only thing that lets a machine which did not generate the output tell "this is exactly
what I wrote" from "somebody edited this".

With no ``gen_state_dir`` there is no record to consult, so the legacy marker rule
stands. This mirrors TS, where a ``runGen`` given no ``projectRoot`` also falls back to
weaker guarantees; the CLI always supplies one.
"""

from __future__ import annotations

import hashlib
import json
import os

from .constants import GENERATED_MARKER

# status: "new" | "unchanged" | "overwrite" | "refused" | "skipped"

HASHES_FILE = ".hashes.json"


def content_hash(content: str) -> str:
    """sha-256 hex of ``content`` — the function that produces the manifest.

    Same algorithm as every other port, so a manifest written by one is readable by
    another and a future conformance fixture can compare them directly.
    """
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def _manifest_path(gen_state_dir: str) -> str:
    return os.path.join(gen_state_dir, HASHES_FILE)


def has_hash_manifest(gen_state_dir: str) -> bool:
    """Whether this project has a manifest AT ALL.

    Distinct from "the manifest has no entry for this path": a project with no
    manifest predates the manifest being committed, so all its refusals share one
    cause and deserve one instruction rather than one warning per file.
    """
    return os.path.exists(_manifest_path(gen_state_dir))


def _load_hashes(gen_state_dir: str) -> dict[str, str]:
    path = _manifest_path(gen_state_dir)
    if not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            parsed = json.load(fh)
    except (OSError, ValueError):
        # Unreadable or corrupt reads as ABSENT, which fails closed: every file then
        # refuses rather than being assumed ours.
        return {}
    if not isinstance(parsed, dict):
        return {}
    return {k: v for k, v in parsed.items() if isinstance(k, str) and isinstance(v, str)}


def _save_hashes(gen_state_dir: str, hashes: dict[str, str]) -> None:
    os.makedirs(gen_state_dir, exist_ok=True)
    # Keys SORTED, because this file is committed. Insertion order would make the
    # diff — and any merge conflict between two people who both regenerated — depend
    # on which entity happened to generate first.
    ordered = {k: hashes[k] for k in sorted(hashes)}
    with open(_manifest_path(gen_state_dir), "w", encoding="utf-8") as fh:
        json.dump(ordered, fh, indent=2)
        fh.write("\n")


def read_generated_hash(gen_state_dir: str, rel_path: str) -> str | None:
    """The hash recorded when we last wrote ``rel_path``, or None if never."""
    return _load_hashes(gen_state_dir).get(rel_path)


def is_pristine_generated(gen_state_dir: str, rel_path: str, current: str) -> bool:
    """Whether the file is byte-for-byte what we recorded writing.

    FAILS CLOSED — False when it cannot be proven.
    """
    recorded = read_generated_hash(gen_state_dir, rel_path)
    return recorded is not None and recorded == content_hash(current)


def _record(gen_state_dir: str, rel_path: str, content: str) -> None:
    hashes = _load_hashes(gen_state_dir)
    hashes[rel_path] = content_hash(content)
    _save_hashes(gen_state_dir, hashes)


def _write(path: str, content: str) -> None:
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def decide_and_write(
    path: str,
    content: str,
    strategy: str = "overwrite",
    *,
    gen_state_dir: str | None = None,
    rel_path: str | None = None,
) -> str:
    """Decide and perform the write for one generated file.

    ``gen_state_dir`` enables hash-based hand-edit detection; ``rel_path`` is the key
    it is recorded under (defaults to the basename, which is correct for a single
    flat output directory).
    """
    if not os.path.exists(path):
        _write(path, content)
        if gen_state_dir is not None:
            _record(gen_state_dir, rel_path or os.path.basename(path), content)
        return "new"

    with open(path, encoding="utf-8") as fh:
        current = fh.read()

    if strategy == "skip-existing":
        return "skipped"

    # No state to reason from: keep the legacy marker rule rather than refuse
    # everything, and let the CLI (which always supplies state) carry the guarantee.
    if gen_state_dir is None:
        if GENERATED_MARKER not in current:
            return "refused"
        _write(path, content)
        return "overwrite"

    key = rel_path or os.path.basename(path)

    if current == content:
        # Nothing to do, but record it: a first run over already-correct output should
        # leave the file recognisable as ours next time.
        _record(gen_state_dir, key, content)
        return "unchanged"

    if is_pristine_generated(gen_state_dir, key, current):
        _write(path, content)
        _record(gen_state_dir, key, content)
        return "overwrite"

    # Edited, or never recorded. Deliberately does NOT record the current content:
    # doing so would make the file look pristine next run and turn this into a silent
    # overwrite one run later.
    return "refused"
