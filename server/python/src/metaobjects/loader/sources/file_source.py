"""Single-file MetaDataSource.

Format defaults to extension-derived (``.yaml`` / ``.yml`` -> YAML; otherwise
JSON). Reads with ``utf-8-sig`` so a leading UTF-8 BOM is silently stripped —
matches the prior `load_directory` behavior.
"""
from __future__ import annotations

from pathlib import Path

from .meta_data_source import MetaDataFormat, MetaDataSource


def _infer_format(path: Path) -> MetaDataFormat:
    suffix = path.suffix.lower()
    if suffix in (".yaml", ".yml"):
        return MetaDataFormat.YAML
    return MetaDataFormat.JSON


class FileSource(MetaDataSource):
    """A single on-disk file, decoded eagerly via ``utf-8-sig``."""

    def __init__(self, path: Path | str, format: MetaDataFormat | None = None) -> None:
        self._path = Path(path)
        self._format = format if format is not None else _infer_format(self._path)

    @property
    def path(self) -> Path:
        return self._path

    @property
    def id(self) -> str:
        return self._path.name

    @property
    def format(self) -> MetaDataFormat:
        return self._format

    def read(self) -> str:
        return self._path.read_text(encoding="utf-8-sig")
