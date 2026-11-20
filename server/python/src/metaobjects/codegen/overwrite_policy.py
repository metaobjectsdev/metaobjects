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

The decision now comes from a hash manifest at ``<gen_state_dir>/.hashes/``,
recording what we wrote (one file per model package under ``.hashes/``, ADR-0064 Amendment 1):

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
from collections.abc import Iterator
from contextlib import contextmanager, suppress

from .constants import GENERATED_MARKER

# status: "new" | "unchanged" | "overwrite" | "refused" | "adopted" | "skipped"

#: The legacy single manifest. Read underneath the per-package files; removed by the next write.
HASHES_FILE = ".hashes.json"
#: ADR-0064 Amendment 1: one manifest file per model package lives in this directory.
HASHES_DIR = ".hashes"
#: The manifest for paths that belong to no package.
ROOT_MANIFEST = ".root.json"
_GITIGNORE_RULE = ".gen-state/*"
_GITIGNORE_LEGACY = "!.gen-state/.hashes.json"
_GITIGNORE_DIR = "!.gen-state/.hashes/"


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


def _hashes_dir(gen_state_dir: str) -> str:
    return os.path.join(gen_state_dir, HASHES_DIR)


# --- placement (ADR-0064 Amendment 1, section 3) ----------------------------------------


def package_file_name(package: str | None) -> str:
    """The manifest file name for a package; ``None`` (or empty) is the root manifest."""
    if not package:
        return ROOT_MANIFEST
    segments = []
    for seg in package.split("::"):
        out = []
        for byte in seg.encode("utf-8"):
            ch = chr(byte)
            if byte < 0x80 and (ch.isalnum() or ch in "_-"):
                out.append(ch)
            else:
                out.append(f"%{byte:02X}")
        segments.append("".join(out))
    return ".".join(segments) + ".json"


def place_entry(
    path: str, entry: object, objects: list[tuple[str, str]]
) -> str | None:
    """The package a manifest entry is filed under, or ``None`` for the root manifest.

    ``objects`` is the loaded root-level objects as ``(name, package)`` (package ``""`` for
    none). A ``sourceNode`` wins; else the object whose name the file's stem begins with.
    """
    if isinstance(entry, dict) and isinstance(entry.get("sourceNode"), str):
        head = entry["sourceNode"].split(".", 1)[0]
        idx = head.rfind("::")
        return head[:idx] if idx >= 0 else None
    stem = _words(os.path.basename(path).split(".", 1)[0])
    best_len = 0
    packages: set[str] = set()
    for name, package in objects:
        words = _words(name)
        if not words or words != stem[: len(words)]:
            continue
        if len(words) > best_len:
            best_len, packages = len(words), {package}
        elif len(words) == best_len:
            packages.add(package)
    if len(packages) != 1:
        return None
    return next(iter(packages)) or None


def _words(text: str) -> list[str]:
    """Lowercase words: split at ``_`` and ``-``, before an uppercase letter that follows a
    lowercase letter or digit, and before the last capital of a run followed by a lowercase
    letter (``HTTPServer`` is ``http``, ``server``). Digits stay with the word before them."""
    words: list[str] = []
    cur = ""
    for i, ch in enumerate(text):
        if ch in "_-":
            if cur:
                words.append(cur)
            cur = ""
            continue
        if ch.isascii() and ch.isupper() and cur:
            prev = text[i - 1]
            nxt = text[i + 1] if i + 1 < len(text) else ""
            lower_before = prev.isascii() and (prev.islower() or prev.isdigit())
            run_end = prev.isascii() and prev.isupper() and nxt.isascii() and nxt.islower()
            if lower_before or run_end:
                words.append(cur)
                cur = ""
        cur += ch.lower() if ch.isascii() else ch
    if cur:
        words.append(cur)
    return words


def objects_of_root(root: object) -> list[tuple[str, str]]:
    """The ``(name, package)`` of every root-level object of a loaded root."""
    from .template_codegen.template_data import package_of  # lazy: avoids an import cycle

    # ADR-0039 sanctioned own: top-level scan of the loader ROOT (never extended).
    return [
        (c.name, package_of(c))
        for c in root.own_children()  # type: ignore[attr-defined]
        if c.type == "object"
    ]


# The loaded model's objects, per gen-state dir, supplied by the runner once the model is
# loaded. Without one the writer keeps each entry where it was found (rule 3).
_placements: dict[str, list[tuple[str, str]] | None] = {}


def set_placement_objects(gen_state_dir: str | None, objects: list[tuple[str, str]] | None) -> None:
    if gen_state_dir is not None:
        _placements[os.path.abspath(gen_state_dir)] = objects


def has_hash_manifest(gen_state_dir: str) -> bool:
    """Whether this project has a manifest AT ALL (the legacy file or a file in ``.hashes/``).

    Distinct from "the manifest has no entry for this path": a project with no
    manifest predates the manifest being committed, so all its refusals share one
    cause and deserve one instruction rather than one warning per file.
    """
    batch = _batches.get(os.path.abspath(gen_state_dir))
    return bool(
        os.path.exists(_manifest_path(gen_state_dir))
        or _package_files(gen_state_dir)
        or (batch and batch.dirty)
    )


def _package_files(gen_state_dir: str) -> list[str]:
    try:
        return sorted(n for n in os.listdir(_hashes_dir(gen_state_dir)) if n.endswith(".json"))
    except OSError:
        return []


class _ManifestBatch:
    __slots__ = ("raw", "dirty")

    def __init__(self, raw: dict[str, object], dirty: bool = False) -> None:
        self.raw = raw
        self.dirty = dirty


# One in-memory manifest per gen-state dir while a run is in progress. Without it every
# recorded file re-read and re-wrote the whole manifest, so a run of N files wrote it N
# times. Mirrors codegen-ts's ``withManifestBatch`` and C#'s and Java's per-run save.
_batches: dict[str, _ManifestBatch] = {}


@contextmanager
def manifest_batch(gen_state_dir: str | None) -> Iterator[None]:
    """Hold the manifest in memory for the block and write it at most once, at the end.

    A nested batch for the same directory joins the outer one, so a CLI run over several
    targets plus the orphan sweep writes the manifest once. The write happens even when
    the block raises: every file recorded so far IS on disk, and dropping its record
    would make the next run refuse output it wrote itself.
    """
    if gen_state_dir is None:
        yield
        return
    key = os.path.abspath(gen_state_dir)
    if key in _batches:
        yield
        return
    # A legacy manifest makes the run dirty: the next write run migrates it.
    batch = _ManifestBatch(
        _read_manifest_file(gen_state_dir), os.path.exists(_manifest_path(gen_state_dir))
    )
    _batches[key] = batch
    try:
        yield
    except BaseException:
        del _batches[key]
        if batch.dirty:
            # The block's exception is the cause to report; a failed write must not replace it.
            with suppress(Exception):
                _write_manifest_file(gen_state_dir, batch.raw)
        raise
    del _batches[key]
    if batch.dirty:
        _write_manifest_file(gen_state_dir, batch.raw)


def _read_raw(gen_state_dir: str) -> dict[str, object]:
    batch = _batches.get(os.path.abspath(gen_state_dir))
    if batch is not None:
        return batch.raw
    return _read_manifest_file(gen_state_dir)


def _read_json_object(path: str) -> dict[str, object]:
    try:
        with open(path, encoding="utf-8") as fh:
            parsed = json.load(fh)
    except (OSError, ValueError):
        # Unreadable or corrupt reads as ABSENT, which fails closed: every file then
        # refuses rather than being assumed ours.
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _read_union(gen_state_dir: str) -> tuple[dict[str, object], dict[str, str]]:
    """The union of every manifest file (legacy underneath, package files in name order
    winning), and the file each key was found in (``""`` for the legacy file)."""
    merged: dict[str, object] = {}
    where: dict[str, str] = {}
    for key, value in _read_json_object(_manifest_path(gen_state_dir)).items():
        merged[key] = value
        where[key] = ""
    for name in _package_files(gen_state_dir):
        for key, value in _read_json_object(os.path.join(_hashes_dir(gen_state_dir), name)).items():
            merged[key] = value
            where[key] = name
    return merged, where


def _read_manifest_file(gen_state_dir: str) -> dict[str, object]:
    return _read_union(gen_state_dir)[0]


def _entry_hash(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict) and isinstance(value.get("hash"), str):
        return value["hash"]
    return None


def _load_hashes(gen_state_dir: str) -> dict[str, str]:
    hashes: dict[str, str] = {}
    for key, value in _read_raw(gen_state_dir).items():
        recorded = _entry_hash(value)
        if isinstance(key, str) and recorded is not None:
            hashes[key] = recorded
    return hashes


def _save_hashes(gen_state_dir: str, hashes: dict[str, str]) -> None:
    raw = _read_raw(gen_state_dir)
    # Keys SORTED, because these files are committed. Insertion order would make the
    # diff — and any merge conflict between two people who both regenerated — depend
    # on which entity happened to generate first.
    ordered: dict[str, object] = {}
    for k in sorted(hashes):
        existing = raw.get(k)
        if isinstance(existing, dict):
            ordered[k] = {**existing, "hash": hashes[k]}
        else:
            ordered[k] = hashes[k]
    batch = _batches.get(os.path.abspath(gen_state_dir))
    if batch is not None:
        batch.raw = ordered
        batch.dirty = True
        return
    _write_manifest_file(gen_state_dir, ordered)


def _manifest_text(entries: dict[str, object]) -> str:
    return json.dumps({k: entries[k] for k in sorted(entries)}, indent=2) + "\n"


def _write_manifest_file(gen_state_dir: str, ordered: dict[str, object]) -> None:
    """Write every manifest file whose bytes changed (ADR-0064 Amendment 1, section 4)."""
    _, where = _read_union(gen_state_dir)
    objects = _placements.get(os.path.abspath(gen_state_dir))
    files: dict[str, dict[str, object]] = {}
    for key, entry in ordered.items():
        if objects is not None:
            package = place_entry(key, entry, objects)
            name = package_file_name(package)
        else:
            name = where.get(key) or ROOT_MANIFEST
        files.setdefault(name, {})[key] = entry
    if not ordered:
        files[ROOT_MANIFEST] = {}

    directory = _hashes_dir(gen_state_dir)
    os.makedirs(directory, exist_ok=True)
    for name, entries in files.items():
        text = _manifest_text(entries)
        path = os.path.join(directory, name)
        try:
            with open(path, encoding="utf-8") as fh:
                if fh.read() == text:
                    continue
        except OSError:
            pass
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
    for name in _package_files(gen_state_dir):
        if name not in files:
            os.remove(os.path.join(directory, name))
    legacy = _manifest_path(gen_state_dir)
    if os.path.exists(legacy):
        os.remove(legacy)
        _ensure_gitignore(gen_state_dir)


def _ensure_gitignore(gen_state_dir: str) -> None:
    """Replace the legacy negation with ``!.gen-state/.hashes/`` (or add it after the rule when
    there is no legacy line), when the ignore file has the ``.gen-state/*`` rule (``<gen-state>/../.gitignore``)."""
    path = os.path.join(os.path.dirname(os.path.abspath(gen_state_dir)), ".gitignore")
    try:
        with open(path, encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return
    lines = text.split("\n")
    if _GITIGNORE_RULE not in [ln.strip() for ln in lines]:
        return
    out: list[str] = []
    have_new = _GITIGNORE_DIR in [ln.strip() for ln in lines]
    for ln in lines:
        if ln.strip() == _GITIGNORE_LEGACY:
            if not have_new:  # the legacy negation is REPLACED by the directory one
                out.append(_GITIGNORE_DIR)
                have_new = True
            continue
        out.append(ln)
        if ln.strip() == _GITIGNORE_RULE and not have_new:
            # No legacy line anywhere: the new negation follows the rule.
            if _GITIGNORE_LEGACY not in [x.strip() for x in lines]:
                out.append(_GITIGNORE_DIR)
                have_new = True
    new_text = "\n".join(out)
    if new_text != text:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(new_text)


class HashManifest:
    """The manifest as ONE in-memory session (ADR-0064 decision 1).

    Loaded once, updated in memory by :func:`decide_and_write`, and saved once by
    :meth:`save`, and only when an entry was added, changed or removed. The bytes it writes
    are exactly what :func:`_save_hashes` has always written (sorted keys, two-space indent,
    trailing newline, extra fields of object entries kept), so a run that changes nothing
    leaves the committed file, and its timestamp, alone.
    """

    def __init__(self, gen_state_dir: str) -> None:
        self.gen_state_dir = gen_state_dir
        self.hashes: dict[str, str] = _load_hashes(gen_state_dir)
        # A legacy manifest is migrated by the next write run, even when nothing else changed.
        self.dirty = os.path.exists(_manifest_path(gen_state_dir))

    def get(self, rel_path: str, legacy_rel_path: str | None = None) -> str | None:
        recorded = self.hashes.get(rel_path)
        if recorded is None and legacy_rel_path is not None:
            return self.hashes.get(legacy_rel_path)
        return recorded

    def is_pristine(self, rel_path: str, current: str, legacy_rel_path: str | None = None) -> bool:
        recorded = self.get(rel_path, legacy_rel_path)
        return recorded is not None and recorded == content_hash(current)

    def record(
        self, rel_path: str, content: str, legacy_rel_path: str | None = None
    ) -> None:
        new = content_hash(content)
        if self.hashes.get(rel_path) != new:
            self.hashes[rel_path] = new
            self.dirty = True
        # Drop the pre-re-keying spelling in the same save (see `_record`).
        if legacy_rel_path is not None and legacy_rel_path != rel_path:
            if self.hashes.pop(legacy_rel_path, None) is not None:
                self.dirty = True

    def save(self) -> bool:
        """Write the manifest if anything changed. Returns whether it wrote."""
        if not self.dirty:
            return False
        _save_hashes(self.gen_state_dir, self.hashes)
        self.dirty = False
        return True


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
    digest = content_hash(content)
    stale_legacy = (
        legacy_rel_path is not None and legacy_rel_path != rel_path and legacy_rel_path in hashes
    )
    if hashes.get(rel_path) == digest and not stale_legacy:
        return  # already recorded exactly so: an unchanged file does not rewrite the manifest
    hashes[rel_path] = digest
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


#: The status of a hand-edited file replaced under ``handEdits: overwrite``.
STATUS_OVERWROTE_EDIT = "overwrote-edit"
#: The file already held this output, so nothing was written.
STATUS_UNCHANGED = "unchanged"
#: skip-existing kept the file as it was.
STATUS_SKIPPED = "skipped"


def decide_and_write(
    path: str,
    content: str,
    strategy: str = "overwrite",
    *,
    gen_state_dir: str | None = None,
    rel_path: str | None = None,
    legacy_rel_path: str | None = None,
    baseline: str = "default",
    hand_edits: str = "keep",
    manifest: HashManifest | None = None,
) -> str:
    """Decide and perform the write for one generated file.

    ``manifest`` is the run's shared :class:`HashManifest` session; the caller saves it
    once at the end of the run. Without one, a session is opened for this single call and
    saved before returning (what every caller did before ADR-0064).

    ``hand_edits="overwrite"`` (the generator's ``handEdits`` setting) replaces a file we
    recorded writing that was edited since with fresh output, re-records it, and returns
    :data:`STATUS_OVERWROTE_EDIT` so the caller names it. A file with no record of being
    generated is refused under either setting.

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
    session = manifest
    if session is None and gen_state_dir is not None:
        session = HashManifest(gen_state_dir)
    try:
        return _decide(
            path, content, strategy, session, gen_state_dir, rel_path, legacy_rel_path,
            baseline, hand_edits,
        )
    finally:
        if manifest is None and session is not None:
            session.save()


def _decide(
    path: str,
    content: str,
    strategy: str,
    session: HashManifest | None,
    gen_state_dir: str | None,
    rel_path: str | None,
    legacy_rel_path: str | None,
    baseline: str,
    hand_edits: str,
) -> str:
    if not os.path.exists(path):
        _write(path, content)
        if session is not None:
            session.record(rel_path or os.path.basename(path), content, legacy_rel_path)
        return "new"

    if strategy == "skip-existing":
        return STATUS_SKIPPED

    with open(path, encoding="utf-8") as fh:
        current = fh.read()

    # No state to reason from: keep the legacy marker rule rather than refuse
    # everything, and let the CLI (which always supplies state) carry the guarantee.
    if session is None or gen_state_dir is None:
        if GENERATED_MARKER not in current:
            return "refused"
        if current != content:
            _write(path, content)
        return "overwrite" if current != content else STATUS_UNCHANGED

    key = rel_path or os.path.basename(path)

    if current == content:
        # Nothing to write, and never a rewrite: it would move the timestamp every build
        # tool downstream watches (ADR-0064 decision 2). Record it in memory: a first run
        # over already-correct output should leave the file recognisable as ours next time.
        session.record(key, content, legacy_rel_path)
        return STATUS_UNCHANGED

    if session.is_pristine(key, current, legacy_rel_path):
        _write(path, content)
        session.record(key, content, legacy_rel_path)
        return "overwrite"

    # Edited since we wrote it, and the generator says to discard hand edits.
    if hand_edits == "overwrite" and session.get(key, legacy_rel_path) is not None:
        _write(path, content)
        session.record(key, content, legacy_rel_path)
        return STATUS_OVERWROTE_EDIT

    # Edited, or never recorded. Deliberately does NOT record the current content:
    # doing so would make the file look pristine next run and turn this into a silent
    # overwrite one run later.
    #
    # ...unless the caller explicitly adopted what is on disk. Placed HERE, at the refusal,
    # rather than earlier in the function: adopting can then only ever convert a refusal
    # into a recorded baseline, leaving "unchanged" and the pristine overwrite exactly as
    # they are, so passing it cannot freeze a project's regeneration.
    if baseline == "adopt":
        session.record(key, current, legacy_rel_path)
        return "adopted"

    return "refused"
