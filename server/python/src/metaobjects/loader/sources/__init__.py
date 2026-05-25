"""Polymorphic MetaDataSource implementations.

The cross-language Tier-1 contract: every source declares an identity (for
error locations), a format (json | yaml), and a read() returning the decoded
text content. File / directory / URI / in-memory sources are all just
implementations of that contract — the loader is source-agnostic.

See `docs/superpowers/specs/2026-05-25-cross-language-loader-architecture-unification.md`.
"""
from __future__ import annotations

from .directory_source import DirectorySource
from .file_source import FileSource
from .meta_data_source import InMemoryStringSource, MetaDataFormat, MetaDataSource
from .uri_source import UriSource

__all__ = [
    "MetaDataFormat",
    "MetaDataSource",
    "InMemoryStringSource",
    "FileSource",
    "DirectorySource",
    "UriSource",
]
