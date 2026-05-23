"""Bridge the corpus to the Python loader."""
from __future__ import annotations

from pathlib import Path

from metaobjects.core_types import core_provider
from metaobjects.loader.meta_data_loader import load_directory
from metaobjects.serializer_json import canonical_serialize


def load_fixture(input_dir: Path) -> tuple[list[str], list[str], str]:
    """Return (error_codes, warnings, canonical_serialization)."""
    result = load_directory(str(input_dir), providers=[core_provider])
    codes = [e.code.name for e in result.errors]
    canonical = canonical_serialize(result.root)
    return codes, list(result.warnings), canonical
