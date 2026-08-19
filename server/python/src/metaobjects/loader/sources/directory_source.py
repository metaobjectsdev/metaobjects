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
#: `PENDING_DIR` in `metadata-files.ts`.
_PENDING_DIR = "_pending"


class DirectorySource:
    """Expands a directory into a sorted, filtered list of FileSource objects."""

    def __init__(
        self,
        directory: Path | str,
        exclude: Iterable[str] | None = None,
        recurse: bool = True,
    ) -> None:
        self._directory = Path(directory)
        self._exclude = set(exclude or ())
        self._recurse = recurse

    @property
    def directory(self) -> Path:
        return self._directory

    def expand(self) -> Iterator[FileSource]:
        candidates = (
            self._directory.rglob("*") if self._recurse else self._directory.iterdir()
        )
        files = sorted(
            (
                p
                for p in candidates
                if p.is_file()
                and p.suffix.lower() in _SUPPORTED_SUFFIXES
                and p.name not in self._exclude
                # Excludes _pending/ at ANY depth — a directory NAME check on every
                # ancestor component between `self._directory` and `p`, not merely
                # a basename filter on `p` itself, so the whole subtree is skipped
                # (a draft entity must be invisible to codegen, not just a file
                # that happens to be named "_pending").
                and _PENDING_DIR not in p.relative_to(self._directory).parts[:-1]
            ),
            key=lambda p: p.name,
        )
        yield from (FileSource(p) for p in files)
