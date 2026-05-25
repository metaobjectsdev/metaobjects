"""metaobjects — Python implementation of the MetaObjects standard.

Top-level exports cover the cross-language loader API (MetaDataLoader +
LoadResult, the four MetaDataSource impls, and Pythonic module-level
shortcuts ``load_directory`` / ``load_uris`` / ``load_string`` that
alias the class factories ala ``requests.get`` over ``Session().get``).
"""
from __future__ import annotations

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

# Module-level shortcuts: the 99% case for callers who don't need a
# long-lived loader. Signatures + docstrings come straight from the
# classmethods — no wrapping layer to drift.
load_directory = MetaDataLoader.from_directory
load_uris = MetaDataLoader.from_uris
load_string = MetaDataLoader.from_string


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
