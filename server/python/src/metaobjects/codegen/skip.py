"""Whole-run codegen skip (ADR-0064).

``gen`` computes ONE fingerprint of every input that can change what it writes, before it
loads any metadata or constructs any generator, and compares it with the one the last
successful run stored in ``<gen_state_dir>/.fingerprint-python.json``. A match, with every
file the manifest records still on disk, skips the run.

The key may be wrong only in the safe direction: anything this module cannot prove
unchanged is reported as changed (``None`` from an input builder means "cannot prove", and
the caller then runs in full).

The fingerprint is built from small named entries (:class:`InputEntry`: a kind, a name and a
content hash) folded into one key by :func:`fold`, so a later per-object key can reuse the
same entries for a subset of the inputs. Its bytes are internal to this port and are never
compared with another port's.
"""
from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from importlib import metadata as importlib_metadata
from importlib import util as importlib_util
from pathlib import Path
from typing import Iterable

from .overwrite_policy import HASHES_FILE, content_hash

#: Bump when the fingerprint's own recipe changes: every stored fingerprint then misses.
FINGERPRINT_FORMAT = 2

#: Where this port keeps its fingerprint, beside the (committed) manifest and never
#: committed itself (``.gen-state/*`` is ignored except ``.hashes.json``).
FINGERPRINT_FILE = ".fingerprint-python.json"

#: The hash of an input that does not exist. A file that appears or disappears changes it.
ABSENT = "absent"

_SKIPPED_DIRS = {"__pycache__", ".git", ".venv", "node_modules", ".mypy_cache", ".ruff_cache"}
_SKIPPED_SUFFIXES = {".pyc", ".pyo"}

KIND_TOOL = "tool"
KIND_ENGINE = "engine"
KIND_CONFIG = "config"
KIND_MODEL = "model"
KIND_FLAG = "flag"
KIND_GENERATOR = "generator"
KIND_TEMPLATES = "templates"
KIND_SOURCE = "source"
KIND_EXTRA = "extra"


@dataclass(frozen=True)
class InputEntry:
    """One named input of the run: what kind it is, its name, and its content hash."""

    kind: str
    name: str
    sha256: str


def fold(entries: Iterable[InputEntry]) -> str:
    """The one key: a SHA-256 over the sorted entries. Order of arrival is irrelevant."""
    lines = sorted(f"{e.kind}\0{e.name}\0{e.sha256}" for e in entries)
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def hash_file(path: Path) -> str:
    """SHA-256 of a file's bytes, or :data:`ABSENT`. Timestamps are never read."""
    try:
        return _sha(path.read_bytes())
    except OSError:
        return ABSENT


def _tree_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in _SKIPPED_DIRS)
        for name in sorted(filenames):
            if Path(name).suffix in _SKIPPED_SUFFIXES:
                continue
            files.append(Path(dirpath, name))
    return files


def hash_tree(root: Path) -> str:
    """One hash over every file under ``root`` (relative path and content), or
    :data:`ABSENT`. Adding, removing, renaming or editing any file changes it."""
    if not root.exists():
        return ABSENT
    if root.is_file():
        return hash_file(root)
    h = hashlib.sha256()
    for f in _tree_files(root):
        h.update(f.relative_to(root).as_posix().encode("utf-8"))
        h.update(b"\0")
        h.update(hash_file(f).encode("ascii"))
        h.update(b"\n")
    return h.hexdigest()


# --- identity of the engine and of generators -------------------------------------------


def _installed_version() -> str:
    try:
        return importlib_metadata.version("metaobjects")
    except importlib_metadata.PackageNotFoundError:
        return "0.0.0"


def engine_identity() -> str:
    """A content hash of the engine's built code (the generators, their templates and
    helpers all live in this package), so a linked or locally built engine changes the key
    with its content and an installed one changes it with its release."""
    return f"content:{hash_tree(Path(__file__).resolve().parent.parent)}"


def engine_entries() -> list[InputEntry]:
    return [
        InputEntry(KIND_TOOL, "fingerprint-format", str(FINGERPRINT_FORMAT)),
        InputEntry(KIND_TOOL, "engine-version", _installed_version()),
        InputEntry(KIND_ENGINE, "metaobjects", engine_identity()),
    ]


def module_source_entries(spec: str, root: Path) -> list[InputEntry] | None:
    """The identity of the code behind a ``module:symbol`` spec (an owned generator, a
    provider, a requirement-tests hook), WITHOUT importing it.

    Found under ``root`` first (the config directory: a ``module.py`` or a package directory)
    and then on the import path. A module under the project is hashed whole, its top-level
    package included, because an owned generator imports its ejected runtime siblings. An
    installed distribution is identified by its version. ``None`` when the module cannot be
    found: the run then cannot be proven unchanged.
    """
    module_name = spec.partition(":")[0]
    top = module_name.split(".")[0]
    if not top:
        return None
    for candidate in (root / f"{top}.py", root / top):
        if candidate.exists():
            return [InputEntry(KIND_SOURCE, top, hash_tree(candidate))]
    try:
        found = importlib_util.find_spec(top)
    except (ImportError, ValueError):
        return None
    if found is None or not found.origin or found.origin in ("built-in", "frozen"):
        return None
    origin = Path(found.origin).resolve()
    package_dir = origin.parent if origin.name == "__init__.py" else origin
    return [InputEntry(KIND_SOURCE, top, hash_tree(package_dir))]


def extras_entries(project_root: Path, paths: Iterable[str]) -> list[InputEntry]:
    """The content of every declared extra input (project-relative paths; a directory is
    hashed whole). A path that does not exist hashes as :data:`ABSENT`."""
    return [
        InputEntry(KIND_EXTRA, rel, hash_tree(project_root / rel))
        for rel in sorted(set(paths))
    ]


# --- the stored fingerprint -------------------------------------------------------------


def fingerprint_path(gen_state_dir: str) -> str:
    return os.path.join(gen_state_dir, FINGERPRINT_FILE)


@dataclass(frozen=True)
class StoredFingerprint:
    key: str
    #: Project-relative paths the last run's generators declared as extra inputs. Kept here
    #: because the check runs before any generator exists and must hash them.
    extras: tuple[str, ...]
    #: Amendment A: every manifest-recorded path (project-relative, as the manifest keys it)
    #: mapped to the sha256 of the bytes on disk when the run finished.
    outputs: dict[str, str]
    #: Every other path the run emitted, which the manifest does not record (a file outside
    #: the project root, or one written without a record): project-relative when inside the
    #: project, absolute otherwise. A skip needs each to exist.
    untracked: tuple[str, ...] = ()


def read_stored(gen_state_dir: str) -> StoredFingerprint | None:
    try:
        with open(fingerprint_path(gen_state_dir), encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    if (
        not isinstance(raw, dict)
        or raw.get("format") != FINGERPRINT_FORMAT
        or not isinstance(raw.get("fingerprint"), str)
    ):
        return None
    extras = raw.get("extras", [])
    if not isinstance(extras, list) or not all(isinstance(x, str) for x in extras):
        return None
    outputs = raw.get("outputs")
    if not isinstance(outputs, dict) or not all(
        isinstance(k, str) and isinstance(v, str) for k, v in outputs.items()
    ):
        return None
    untracked = raw.get("untracked", [])
    if not isinstance(untracked, list) or not all(isinstance(x, str) for x in untracked):
        return None
    return StoredFingerprint(raw["fingerprint"], tuple(extras), dict(outputs), tuple(untracked))


def write_stored(
    gen_state_dir: str,
    key: str,
    extras: Iterable[str],
    outputs: dict[str, str],
    untracked: Iterable[str] = (),
) -> None:
    os.makedirs(gen_state_dir, exist_ok=True)
    payload = {
        "format": FINGERPRINT_FORMAT,
        "fingerprint": key,
        "extras": sorted(set(extras)),
        "outputs": dict(sorted(outputs.items())),
        "untracked": sorted(set(untracked)),
    }
    with open(fingerprint_path(gen_state_dir), "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)
        fh.write("\n")


def delete_stored(gen_state_dir: str) -> None:
    try:
        os.remove(fingerprint_path(gen_state_dir))
    except OSError:
        pass


def current_key(
    entries: list[InputEntry], project_root: Path, stored: StoredFingerprint | None
) -> str:
    """The key the inputs fold to, with the stored run's declared extras hashed in."""
    extras = extras_entries(project_root, stored.extras) if stored else []
    return fold([*entries, *extras])


# --- the manifest's files ---------------------------------------------------------------


def _manifest_records(gen_state_dir: str) -> dict[str, str] | None:
    """key -> recorded hash, or ``None`` when there is no readable manifest."""
    try:
        with open(os.path.join(gen_state_dir, HASHES_FILE), encoding="utf-8") as fh:
            raw = json.load(fh)
    except (OSError, ValueError):
        return None
    if not isinstance(raw, dict):
        return None
    records: dict[str, str] = {}
    for key, value in raw.items():
        if isinstance(value, str):
            records[key] = value
        elif isinstance(value, dict) and isinstance(value.get("hash"), str):
            records[key] = value["hash"]
    return records


def _locate(key: str, project_root: Path, out_dirs: Iterable[str]) -> Path | None:
    """The file a manifest key names: project-relative, else (a pre-re-keying entry)
    relative to one of the output directories."""
    candidate = project_root / key
    if candidate.is_file():
        return candidate
    for out in out_dirs:
        legacy = Path(out) / key
        if legacy.is_file():
            return legacy
    return None


def output_hashes(
    gen_state_dir: str, project_root: Path, out_dirs: Iterable[str]
) -> dict[str, str] | None:
    """Every manifest-recorded path mapped to the sha256 of the bytes on disk now, or
    ``None`` when the manifest is unreadable or any recorded file is missing (a run that
    left a recorded file missing stores no key; a skip then never matches)."""
    records = _manifest_records(gen_state_dir)
    if records is None:
        return None
    outs = list(out_dirs)
    hashes: dict[str, str] = {}
    for key in records:
        found = _locate(key, project_root, outs)
        if found is None:
            return None
        try:
            hashes[key] = _sha(found.read_bytes())
        except OSError:
            return None
    return hashes


def untracked_outputs(
    gen_state_dir: str, project_root: Path, out_dirs: Iterable[str], emitted: Iterable[str]
) -> list[str]:
    """Every emitted path the manifest does not record, project-relative when inside the
    project and absolute otherwise."""
    outs = list(out_dirs)
    root = project_root.resolve()
    recorded: set[str] = set()
    for key in _manifest_records(gen_state_dir) or {}:
        found = _locate(key, project_root, outs)
        if found is not None:
            recorded.add(os.path.realpath(found))
    result: list[str] = []
    for path in emitted:
        real = os.path.realpath(path)
        if real in recorded:
            continue
        rel = os.path.relpath(real, root)
        result.append(real if rel.startswith("..") or os.path.isabs(rel) else rel)
    return sorted(set(result))


def untracked_exist(stored: StoredFingerprint, project_root: Path) -> bool:
    """True when every path the stored run emitted outside the manifest still exists."""
    return all((project_root / p).is_file() for p in stored.untracked)


def outputs_unchanged(
    stored: StoredFingerprint, gen_state_dir: str, project_root: Path, out_dirs: Iterable[str]
) -> bool:
    """Amendment A: every manifest-recorded file exists and still hashes to the value the
    last run left, and every path emitted outside the manifest still exists. A missing entry
    on either side is a mismatch."""
    return (
        output_hashes(gen_state_dir, project_root, out_dirs) == stored.outputs
        and untracked_exist(stored, project_root)
    )


def manifest_files_exist(
    gen_state_dir: str, project_root: Path, out_dirs: Iterable[str]
) -> bool:
    """True when every file the manifest records still exists. A missing or unreadable
    manifest is not proof of anything, so it reads as False."""
    records = _manifest_records(gen_state_dir)
    if records is None:
        return False
    outs = list(out_dirs)
    return all(_locate(key, project_root, outs) is not None for key in records)


def manifest_files_match(
    gen_state_dir: str, project_root: Path, out_dirs: Iterable[str]
) -> bool:
    """True when every file the manifest records still hashes to its recorded entry."""
    records = _manifest_records(gen_state_dir)
    if records is None:
        return False
    outs = list(out_dirs)
    for key, recorded in records.items():
        found = _locate(key, project_root, outs)
        if found is None:
            return False
        try:
            text = found.read_bytes().decode("utf-8")
        except (OSError, UnicodeDecodeError):
            return False
        if content_hash(text) != recorded:
            return False
    return True


def ci_environment(environ: dict[str, str] | None = None) -> bool:
    """The ``CI`` variable is set to anything but empty, ``0`` or ``false``."""
    value = (environ if environ is not None else os.environ).get("CI", "")
    return value.strip().lower() not in ("", "0", "false")


@dataclass
class SkipRunInfo:
    """What a run learned while it resolved its generators, for the fingerprint it stores:
    whether every generator is cacheable, and the extra inputs they declared (with the
    content they had BEFORE the run wrote anything)."""

    cacheable: bool = True
    extras: set[str] | None = None
    extra_entries: list[InputEntry] | None = None

    def __post_init__(self) -> None:
        if self.extras is None:
            self.extras = set()
        if self.extra_entries is None:
            self.extra_entries = []


__all__ = [
    "ABSENT",
    "FINGERPRINT_FILE",
    "FINGERPRINT_FORMAT",
    "InputEntry",
    "SkipRunInfo",
    "StoredFingerprint",
    "ci_environment",
    "current_key",
    "delete_stored",
    "engine_entries",
    "engine_identity",
    "extras_entries",
    "fingerprint_path",
    "fold",
    "hash_file",
    "hash_tree",
    "manifest_files_exist",
    "output_hashes",
    "outputs_unchanged",
    "manifest_files_match",
    "module_source_entries",
    "read_stored",
    "write_stored",
]
