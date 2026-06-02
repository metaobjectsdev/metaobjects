"""Filesystem-backed :class:`~metaobjects.render.verify.Provider`.

Resolves a ``group/source`` reference to ``<root>/group/source.mustache``. The render
engine + verify delegate all I/O to a provider, so this is the only file-touching piece
of the render tier. Mirrors the C# ``MetaObjects.Render.FilesystemProvider`` and the Java
``com.metaobjects.render.FilesystemProvider`` semantics: read the file if present, return
``None`` when absent/unreadable, and reject refs that escape the root (via ``..``).
"""

from __future__ import annotations

from pathlib import Path


class FilesystemProvider:
    """Resolves ``group/source`` references to text files under a root directory:
    ``resolve("npc/turn")`` → ``<root>/npc/turn.mustache``. Returns ``None`` when the file
    is absent. Refs that escape the root (via ``..``) are rejected.

    Implements the :class:`~metaobjects.render.verify.Provider` protocol.
    """

    def __init__(self, root: str | Path, extension: str = ".mustache") -> None:
        self._root = Path(root).resolve()
        self._extension = extension

    def resolve(self, ref: str | None) -> str | None:
        # Build <root>/<seg>/<seg> from the slash-separated ref, dropping empties.
        if not ref:
            return None
        segments = [s for s in ref.split("/") if s]
        if not segments or any(s == ".." for s in segments):
            return None

        base = self._root.joinpath(*segments)
        candidate = base.with_name(base.name + self._extension)
        try:
            resolved = candidate.resolve()
        except OSError:
            return None

        # Path-traversal guard: the resolved file must stay under the root.
        if resolved != self._root and self._root not in resolved.parents:
            return None

        if not resolved.is_file():
            return None
        try:
            return resolved.read_text(encoding="utf-8")
        except OSError:
            return None
