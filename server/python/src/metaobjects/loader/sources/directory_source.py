"""Directory expander -> sorted list of FileSource.

Walks the directory (recursively by default), filters to supported authoring
extensions (``.json`` / ``.yaml`` / ``.yml``), honors a name-based exclude
list, and yields FileSource instances in deterministic ordinal-filename
order. Deterministic order is required because overlay merging is
order-sensitive (last-writer-wins on attr conflicts).
"""
from __future__ import annotations

from collections.abc import Iterable, Iterator
from pathlib import Path

from .file_source import FileSource

_SUPPORTED_SUFFIXES = (".json", ".yaml", ".yml")

#: Directory excluded at every level of a recursive expand() — drafts that are
#: deliberately not part of the loaded model. Mirrors TypeScript's
#: `PENDING_DIR` in `metadata-files.ts`. OFF by default — see
#: `DirectorySource.__init__`'s `exclude_pending` doc.
_PENDING_DIR = "_pending"


class SymlinkLoopError(OSError):
    """Raised when expand() finds a directory symlink that revisits an ancestor.

    A clear error beats a hang: expand() follows symlinked directories (I1 —
    matching TypeScript's `stat`-not-`lstat` walk and C#'s
    `EnumerateFiles(..., AllDirectories)`, both of which have always followed
    them), so an accidental or malicious symlink cycle must be caught explicitly
    rather than recursing forever.
    """


class DirectorySource:
    """Expands a directory into a sorted, filtered list of FileSource objects."""

    def __init__(
        self,
        directory: Path | str,
        exclude: Iterable[str] | None = None,
        recurse: bool = True,
        exclude_pending: bool = False,
    ) -> None:
        """``exclude_pending`` (I2) — exclude ``_pending/`` at any depth.

        Default ``False``: this is a LOADER-level primitive, and ``_pending/`` is
        a CLI/pending-promote-workflow concept (TypeScript's `metadata-files.ts`,
        not its loader-level `DirectorySource`, which has no `_pending` concept
        at all). `source_resolver.py` — the CLI-facing caller — turns this ON
        explicitly rather than baking the exclusion into every embedder of this
        class; an app calling ``DirectorySource(dir)`` directly gets every file
        back, matching the reference loader.
        """
        self._directory = Path(directory)
        self._exclude = set(exclude or ())
        self._recurse = recurse
        self._exclude_pending = exclude_pending

    @property
    def directory(self) -> Path:
        return self._directory

    def expand(self) -> Iterator[FileSource]:
        files = sorted(self._collect(self._directory, frozenset()), key=lambda p: p.name)
        yield from (FileSource(p) for p in files)

    def _collect(self, directory: Path, ancestors: frozenset[Path]) -> list[Path]:
        """Recursively collect matching files under ``directory``, following
        symlinked subdirectories (I1) — `iterdir()`/`is_dir()` naturally follow a
        symlink, unlike `rglob("*")`'s `**` traversal, which does not descend
        into one.

        Paths are built by lexical join (`directory / name`) throughout, exactly
        like a plain non-symlink-aware walk would build them — a symlinked
        directory's OWN name survives in the reported path; only the WALK follows
        the link, matching Java/C#/TypeScript, none of which collapse a source's
        directory name to its symlink target's real name.

        ``ancestors`` is a set of REAL (`Path.resolve()`) directory paths already
        on the current walk branch, used only to detect a symlink cycle — never
        to rewrite a reported path.
        """
        real = directory.resolve()
        if real in ancestors:
            raise SymlinkLoopError(
                f"symlink loop detected while expanding {self._directory}: "
                f"{directory} revisits {real}"
            )
        ancestors = ancestors | {real}

        out: list[Path] = []
        for entry in directory.iterdir():
            if entry.is_dir():
                if self._recurse:
                    out.extend(self._collect(entry, ancestors))
            elif (
                entry.is_file()
                and entry.suffix.lower() in _SUPPORTED_SUFFIXES
                and entry.name not in self._exclude
                # Excludes _pending/ at ANY depth — a directory NAME check on every
                # ancestor component between `self._directory` and `entry`, not
                # merely a basename filter on `entry` itself, so the whole subtree
                # is skipped (a draft entity must be invisible to codegen, not
                # just a file that happens to be named "_pending").
                and not (
                    self._exclude_pending
                    and _PENDING_DIR in entry.relative_to(self._directory).parts[:-1]
                )
            ):
                out.append(entry)
        return out
