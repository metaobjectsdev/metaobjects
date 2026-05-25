"""Unit tests for the MetaDataLoader class + factory methods.

Covers the Tier-1 invariant: loader.load(sources) -> LoadResult with the
{root, errors, warnings} shape, plus the three class-method factories
(from_directory / from_uris / from_string) for the 99% case.
"""
from __future__ import annotations

from pathlib import Path

from metaobjects.core_types import core_provider
from metaobjects.loader.meta_data_loader import LoadResult, MetaDataLoader
from metaobjects.loader.sources import (
    DirectorySource,
    InMemoryStringSource,
    MetaDataFormat,
)


_TINY_JSON = '{"metadata.root":{"package":"x","children":[]}}'


def test_load_from_directory_source(tmp_path: Path) -> None:
    (tmp_path / "meta.tiny.json").write_text(_TINY_JSON, encoding="utf-8")
    loader = MetaDataLoader(providers=[core_provider])
    result = loader.load(list(DirectorySource(tmp_path).expand()))
    assert isinstance(result, LoadResult)
    assert result.errors == []
    assert result.root is not None


def test_load_returns_empty_root_on_no_sources() -> None:
    loader = MetaDataLoader()
    result = loader.load([])
    assert result.root is not None
    assert result.errors == []


def test_load_from_inline_yaml() -> None:
    loader = MetaDataLoader(providers=[core_provider])
    result = loader.load([
        InMemoryStringSource(
            "metadata.root:\n  package: x\n  children: []\n",
            format=MetaDataFormat.YAML,
        )
    ])
    assert result.errors == []
    assert result.root is not None


def test_load_from_inline_json() -> None:
    loader = MetaDataLoader(providers=[core_provider])
    result = loader.load([InMemoryStringSource(_TINY_JSON)])
    assert result.errors == []


def test_load_from_inline_malformed_json_reports_error() -> None:
    loader = MetaDataLoader(providers=[core_provider])
    result = loader.load([InMemoryStringSource("not json", id="<bad>")])
    assert any(e.code.name == "ERR_MALFORMED_JSON" for e in result.errors)


def test_from_directory_classmethod(tmp_path: Path) -> None:
    (tmp_path / "meta.tiny.json").write_text(_TINY_JSON, encoding="utf-8")
    result = MetaDataLoader.from_directory(tmp_path)
    assert result.errors == []


def test_from_directory_defaults_to_core_provider_when_none(tmp_path: Path) -> None:
    (tmp_path / "meta.tiny.json").write_text(_TINY_JSON, encoding="utf-8")
    # Pass providers=None explicitly to assert the default is applied.
    result = MetaDataLoader.from_directory(tmp_path, providers=None)
    assert result.errors == []


def test_from_string_classmethod() -> None:
    result = MetaDataLoader.from_string(_TINY_JSON, format=MetaDataFormat.JSON)
    assert result.errors == []


def test_from_string_default_format_is_json() -> None:
    result = MetaDataLoader.from_string(_TINY_JSON)
    assert result.errors == []
