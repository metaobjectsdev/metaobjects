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
from .meta.core.object.meta_object_aware import (
    MetaObjectAware,
    is_meta_object_aware,
)
from .meta.core.object.object_class_registry import (
    ObjectClassRegistry,
    ObjectFactory,
    default_object_class_registry,
)
from .meta.core.object.object_extract import (
    MAX_NEST_DEPTH,
    ExtractError,
    assemble,
    or_throw,
    extract_object,
    extract_schema_for,
)
from .meta.core.object.value_object import ValueObject

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
    # Runtime object model (Phase A)
    "ValueObject",
    "MetaObjectAware",
    "is_meta_object_aware",
    "ObjectClassRegistry",
    "ObjectFactory",
    "default_object_class_registry",
    # Phase B metadata-driven extract bridge
    "extract_object",
    "extract_schema_for",
    "assemble",
    "or_throw",
    "ExtractError",
    "MAX_NEST_DEPTH",
]
