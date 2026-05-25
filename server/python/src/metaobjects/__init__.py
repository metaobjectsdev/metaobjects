"""metaobjects — Python implementation of the MetaObjects standard.

Top-level exports cover the cross-language loader API (MetaDataLoader +
LoadResult, the four MetaDataSource impls, and Pythonic module-level
shortcuts ``load_directory`` / ``load_uris`` / ``load_string`` that
delegate to the class factories).
"""
from __future__ import annotations

from pathlib import Path

from .errors import ErrorCode, MetaError
from .loader.meta_data_loader import LoadResult, MetaDataLoader
from .loader.sources import (
    DirectorySource,
    FileSource,
    InMemoryStringSource,
    MetaDataFormat,
    MetaDataSource,
    UriSource,
)
from .provider import Provider


def load_directory(
    directory: Path | str,
    providers: list[Provider] | None = None,
    exclude: list[str] | None = None,
    recurse: bool = True,
) -> LoadResult:
    """Module-level shortcut for ``MetaDataLoader.from_directory``."""
    return MetaDataLoader.from_directory(
        directory, providers=providers, exclude=exclude, recurse=recurse,
    )


def load_uris(
    uris: list[str], providers: list[Provider] | None = None
) -> LoadResult:
    """Module-level shortcut for ``MetaDataLoader.from_uris``."""
    return MetaDataLoader.from_uris(uris, providers=providers)


def load_string(
    content: str,
    format: MetaDataFormat = MetaDataFormat.JSON,
    providers: list[Provider] | None = None,
) -> LoadResult:
    """Module-level shortcut for ``MetaDataLoader.from_string``."""
    return MetaDataLoader.from_string(content, format=format, providers=providers)


__all__ = [
    "MetaDataLoader",
    "LoadResult",
    "MetaDataSource",
    "MetaDataFormat",
    "FileSource",
    "DirectorySource",
    "UriSource",
    "InMemoryStringSource",
    "ErrorCode",
    "MetaError",
    "load_directory",
    "load_uris",
    "load_string",
]
