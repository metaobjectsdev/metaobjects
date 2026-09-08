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
                                         -> "adopted"     (baseline="adopt": record
                                                           what is there, write nothing)

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

# status: "new" | "unchanged" | "overwrite" | "refused" | "adopted" | "skipped"

HASHES_FILE = ".hashes.json"


def content_hash(content: str) -> str:
    """sha-256 hex of ``content`` — the function that produces the manifest.

    Same algorithm as every other port, so identical file content hashes identically
    everywhere.

    The KEYS are relative to the PROJECT ROOT, as TypeScript's are — the manifest is
    anchored on the project, so a key that means "this name, relative to whichever out
    dir ran last" made two runs with different ``--out`` share one manifest in which run
    B's hash claimed ownership of run A's file. (There is no per-out-dir gen-state dir to
    escape into: ``gen_state_dir`` is derived from the metadata directory, so the advice
    this docstring used to give could not be followed.) A manifest is still NOT portable
    between ports — an earlier version of this docstring claimed a conformance fixture
    could compare them directly, and it never could.
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


def read_generated_hash(
    gen_state_dir: str, rel_path: str, legacy_rel_path: str | None = None
) -> str | None:
    """The hash recorded when we last wrote ``rel_path``, or None if never.

    ``legacy_rel_path`` is the OUT-DIR-relative key the same file was recorded under
    before keys became project-root-relative. Reading both is what keeps the re-keying
    from invalidating every existing manifest: without it a previously-recorded file
    becomes unrecorded, which is fail-closed (``gen`` REFUSES it) but makes every
    adopter regenerate to get past a change they did not ask for. The legacy entry is
    dropped the next time the file is recorded, so a manifest converges on one spelling
    without a migration command.
    """
    hashes = _load_hashes(gen_state_dir)
    recorded = hashes.get(rel_path)
    if recorded is None and legacy_rel_path is not None:
        return hashes.get(legacy_rel_path)
    return recorded


def is_pristine_generated(
    gen_state_dir: str, rel_path: str, current: str, legacy_rel_path: str | None = None
) -> bool:
    """Whether the file is byte-for-byte what we recorded writing.

    FAILS CLOSED — False when it cannot be proven.
    """
    recorded = read_generated_hash(gen_state_dir, rel_path, legacy_rel_path)
    return recorded is not None and recorded == content_hash(current)


def _record(
    gen_state_dir: str, rel_path: str, content: str, legacy_rel_path: str | None = None
) -> None:
    hashes = _load_hashes(gen_state_dir)
    hashes[rel_path] = content_hash(content)
    # Drop the pre-re-keying spelling in the same write. Leaving it would keep a key
    # that means "this name, relative to whichever out dir ran last" alive forever —
    # which is the ambiguity being removed.
    if legacy_rel_path is not None and legacy_rel_path != rel_path:
        hashes.pop(legacy_rel_path, None)
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
    legacy_rel_path: str | None = None,
    baseline: str = "default",
) -> str:
    """Decide and perform the write for one generated file.

    ``gen_state_dir`` enables hash-based hand-edit detection; ``rel_path`` is the key
    it is recorded under (defaults to the basename, which is correct for a single
    flat output directory). ``legacy_rel_path`` is the key the same file may already
    be recorded under from before keys became project-root-relative — read as a
    fallback, and removed once the file is recorded under the new key.

    ``baseline="adopt"`` records the file's CURRENT content as the baseline instead of
    refusing it, and writes nothing. It exists because the refusal's remedy — commit the
    manifest — could not be performed by the population it named: nothing writes a
    manifest until a gen succeeds, and a run where every file refuses writes none. It is
    NOT protection for an edit already in the file: what it records IS that text, so the
    next run regenerates over it. What it guarantees is that establishing the baseline
    writes nothing, which is what lets the regeneration land as its own reviewable diff.
    """
    if not os.path.exists(path):
        _write(path, content)
        if gen_state_dir is not None:
            _record(
                gen_state_dir, rel_path or os.path.basename(path), content, legacy_rel_path
            )
        return "new"

    if strategy == "skip-existing":
        return "skipped"

    with open(path, encoding="utf-8") as fh:
        current = fh.read()

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
        _record(gen_state_dir, key, content, legacy_rel_path)
        return "unchanged"

    if is_pristine_generated(gen_state_dir, key, current, legacy_rel_path):
        _write(path, content)
        _record(gen_state_dir, key, content, legacy_rel_path)
        return "overwrite"

    # Edited, or never recorded. Deliberately does NOT record the current content:
    # doing so would make the file look pristine next run and turn this into a silent
    # overwrite one run later.
    #
    # …unless the caller explicitly adopted what is on disk. Placed HERE, at the refusal,
    # rather than earlier in the function: adopting can then only ever convert a refusal
    # into a recorded baseline, leaving "unchanged" and the pristine overwrite exactly as
    # they are, so passing it cannot freeze a project's regeneration.
    if baseline == "adopt":
        _record(gen_state_dir, key, current, legacy_rel_path)
        return "adopted"

    return "refused"
