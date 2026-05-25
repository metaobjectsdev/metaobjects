"""Module-level shortcut tests.

Mirrors the Pythonic ``requests.get(url)`` pattern: a single import gives
you the 99% case (load_directory / load_uris / load_string) without
having to construct a MetaDataLoader.
"""
from __future__ import annotations

from pathlib import Path

import metaobjects


_TINY = '{"metadata.root":{"package":"x","children":[]}}'


def test_module_level_load_string() -> None:
    result = metaobjects.load_string(_TINY)
    assert result.errors == []


def test_module_level_load_string_yaml() -> None:
    result = metaobjects.load_string(
        "metadata.root:\n  package: x\n  children: []\n",
        format=metaobjects.MetaDataFormat.YAML,
    )
    assert result.errors == []


def test_module_level_load_directory(tmp_path: Path) -> None:
    (tmp_path / "meta.tiny.json").write_text(_TINY, encoding="utf-8")
    result = metaobjects.load_directory(tmp_path)
    assert result.errors == []


def test_public_exports_are_present() -> None:
    # Spot-check the Tier-1 surface.
    for sym in (
        "MetaDataLoader",
        "LoadResult",
        "MetaDataSource",
        "MetaDataFormat",
        "FileSource",
        "DirectorySource",
        "UriSource",
        "InMemoryStringSource",
        "load_directory",
        "load_uris",
        "load_string",
    ):
        assert hasattr(metaobjects, sym), f"metaobjects.{sym} missing"
