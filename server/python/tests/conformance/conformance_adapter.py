"""Bridge the corpus to the Python loader."""
from __future__ import annotations

from pathlib import Path

from metaobjects import LoadResult, MetaDataLoader
from metaobjects.core_types import core_provider
from metaobjects.documentation import doc_provider
from metaobjects.meta.meta_data import MetaData
from metaobjects.serializer_json import canonical_serialize

_PROVIDERS = [core_provider, doc_provider]


def load_fixture(input_dir: Path) -> tuple[list[str], list[str], str]:
    """Return (error_codes, warnings, canonical_serialization)."""
    result = MetaDataLoader.from_directory(input_dir, providers=_PROVIDERS)
    codes = [e.code.name for e in result.errors]
    canonical = canonical_serialize(result.root)
    return codes, list(result.warnings), canonical


def load_fixture_result(input_dir: Path) -> LoadResult:
    """Return the full LoadResult (including the root node) for script.json checks."""
    return MetaDataLoader.from_directory(input_dir, providers=_PROVIDERS)
