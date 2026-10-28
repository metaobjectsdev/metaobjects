"""Filesystem-backed :class:`~metaobjects.render.verify.Provider`.

Resolves a ``group/source`` reference to ``<root>/group/source.mustache`` — or, when no
Mustache file exists, to a Jinja one (``.jinja`` / ``.j2`` / ``.jinja2``, ADR-0061), and
reports which engine the file it found is written for. The render
engine + verify delegate all I/O to a provider, so this is the only file-touching piece
of the render tier. Mirrors the C# ``MetaObjects.Render.FilesystemProvider`` and the Java
``com.metaobjects.render.FilesystemProvider`` semantics: read the file if present, return
``None`` when absent/unreadable, and reject refs that escape the root (via ``..``).
"""

from __future__ import annotations

from pathlib import Path

from .engine import JINJA_EXTENSIONS, MUSTACHE_EXTENSION, engine_for_extension


class FilesystemProvider:
    """Resolves ``group/source`` references to text files under a root directory:
    ``resolve("npc/turn")`` → ``<root>/npc/turn.mustache``, else the first of
    ``turn.jinja`` / ``turn.j2`` / ``turn.jinja2`` that exists. Returns ``None`` when no
    file is present. Refs that escape the root (via ``..``) are rejected.

    Pass ``extension`` to look for that one extension only.

    Implements the :class:`~metaobjects.render.verify.Provider` protocol, including the
    optional ``engine_of``.
    """

    def __init__(self, root: str | Path, extension: str | None = None) -> None:
        self._root = Path(root).resolve()
        self._extensions: tuple[str, ...] = (
            (extension,) if extension is not None else (MUSTACHE_EXTENSION, *JINJA_EXTENSIONS)
        )

    def resolve(self, ref: str | None) -> str | None:
        found = self._find(ref)
        if found is None:
            return None
        try:
            return found[0].read_text(encoding="utf-8")
        except OSError:
            return None

    def engine_of(self, ref: str) -> str | None:
        """The engine the file ``ref`` resolves to is written for, from its extension."""
        found = self._find(ref)
        return None if found is None else engine_for_extension(found[1])

    def _find(self, ref: str | None) -> tuple[Path, str] | None:
        # Build <root>/<seg>/<seg> from the slash-separated ref, dropping empties.
        if not ref:
            return None
        segments = [s for s in ref.split("/") if s]
        if not segments or any(s == ".." for s in segments):
            return None
        base = self._root.joinpath(*segments)
        for extension in self._extensions:
            candidate = base.with_name(base.name + extension)
            try:
                resolved = candidate.resolve()
            except OSError:
                continue
            # Path-traversal guard: the resolved file must stay under the root.
            if resolved != self._root and self._root not in resolved.parents:
                continue
            if resolved.is_file():
                return resolved, extension
        return None
