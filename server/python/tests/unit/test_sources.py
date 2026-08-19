"""Unit tests for MetaDataSource implementations.

Mirrors the Tier-1 source contract from the cross-language loader-unification
spec: identity / format / read().
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from metaobjects.loader.sources import (
    DirectorySource,
    FileSource,
    InMemoryStringSource,
    MetaDataFormat,
    UriSource,
)


def test_file_source_infers_format_from_extension(tmp_path: Path) -> None:
    p = tmp_path / "x.yaml"
    p.write_text("k: v", encoding="utf-8")
    src = FileSource(p)
    assert src.format == MetaDataFormat.YAML
    assert src.id == "x.yaml"
    assert src.read() == "k: v"


def test_file_source_explicit_format_overrides(tmp_path: Path) -> None:
    p = tmp_path / "x.txt"
    p.write_text("k: v", encoding="utf-8")
    src = FileSource(p, format=MetaDataFormat.YAML)
    assert src.format == MetaDataFormat.YAML


def test_file_source_defaults_to_json_for_unknown_extension(tmp_path: Path) -> None:
    p = tmp_path / "x.txt"
    p.write_text("{}", encoding="utf-8")
    assert FileSource(p).format == MetaDataFormat.JSON


def test_file_source_strips_utf8_bom(tmp_path: Path) -> None:
    p = tmp_path / "bom.json"
    # Write BOM + body; utf-8-sig decoder must strip it.
    p.write_bytes(b"\xef\xbb\xbf{}")
    assert FileSource(p).read() == "{}"


def test_in_memory_string_source_defaults() -> None:
    src = InMemoryStringSource("{}")
    assert src.id == "<inline>"
    assert src.format == MetaDataFormat.JSON
    assert src.read() == "{}"


def test_in_memory_string_source_custom_identity_and_format() -> None:
    src = InMemoryStringSource("k: v", id="<test>", format=MetaDataFormat.YAML)
    assert src.id == "<test>"
    assert src.format == MetaDataFormat.YAML


def test_directory_source_expand_sorted_filtered(tmp_path: Path) -> None:
    (tmp_path / "b.json").write_text("{}", encoding="utf-8")
    (tmp_path / "a.yaml").write_text("", encoding="utf-8")
    (tmp_path / "ignored.txt").write_text("x", encoding="utf-8")
    expanded = list(DirectorySource(tmp_path).expand())
    assert [s.id for s in expanded] == ["a.yaml", "b.json"]
    assert expanded[0].format == MetaDataFormat.YAML
    assert expanded[1].format == MetaDataFormat.JSON


def test_directory_source_honors_exclude(tmp_path: Path) -> None:
    (tmp_path / "meta.alpha.json").write_text("{}", encoding="utf-8")
    (tmp_path / "meta.beta.json").write_text("{}", encoding="utf-8")
    src = DirectorySource(tmp_path, exclude=["meta.beta.json"])
    expanded = list(src.expand())
    assert [s.id for s in expanded] == ["meta.alpha.json"]


def test_directory_source_recurses_by_default(tmp_path: Path) -> None:
    sub = tmp_path / "nested"
    sub.mkdir()
    (sub / "deep.json").write_text("{}", encoding="utf-8")
    (tmp_path / "top.json").write_text("{}", encoding="utf-8")
    ids = [s.id for s in DirectorySource(tmp_path).expand()]
    # Sorted by file name; both files surfaced.
    assert ids == ["deep.json", "top.json"]


def test_directory_source_non_recursive(tmp_path: Path) -> None:
    sub = tmp_path / "nested"
    sub.mkdir()
    (sub / "deep.json").write_text("{}", encoding="utf-8")
    (tmp_path / "top.json").write_text("{}", encoding="utf-8")
    ids = [s.id for s in DirectorySource(tmp_path, recurse=False).expand()]
    assert ids == ["top.json"]


def test_directory_source_exclude_pending_is_off_by_default(tmp_path: Path) -> None:
    # Loader-level default is OFF (matches TS's loader-level DirectorySource,
    # which has no _pending concept at all) — only the CLI-facing
    # source_resolver.py turns it on. An app embedding DirectorySource(dir)
    # directly must see every file, _pending/ included.
    (tmp_path / "meta.live.json").write_text("{}", encoding="utf-8")
    pending = tmp_path / "_pending"
    pending.mkdir()
    (pending / "meta.draft.json").write_text("{}", encoding="utf-8")

    ids = sorted(s.id for s in DirectorySource(tmp_path).expand())
    assert ids == ["meta.draft.json", "meta.live.json"]


def test_directory_source_excludes_pending_dir_at_any_depth_when_opted_in(tmp_path: Path) -> None:
    # Mirrors TypeScript's PENDING_DIR exclusion (metadata-files.ts) — a draft
    # entity under _pending/ must be invisible to codegen, not merely a file
    # that happens to be NAMED "_pending". source_resolver.py (the CLI-facing
    # caller) opts in via exclude_pending=True; this test exercises the option
    # directly.
    (tmp_path / "meta.live.json").write_text("{}", encoding="utf-8")
    pending = tmp_path / "_pending"
    pending.mkdir()
    (pending / "meta.draft.json").write_text("{}", encoding="utf-8")
    # Nested: _pending/ excluded at ANY depth, not just top-level.
    nested_pending = tmp_path / "nested" / "_pending"
    nested_pending.mkdir(parents=True)
    (nested_pending / "meta.deep-draft.json").write_text("{}", encoding="utf-8")

    ids = [s.id for s in DirectorySource(tmp_path, exclude_pending=True).expand()]
    assert ids == ["meta.live.json"]


def test_directory_source_follows_a_symlinked_root(tmp_path: Path) -> None:
    # I1: the SOURCE path itself is a symlink to a directory. `Path.is_dir()`
    # follows symlinks (the existence guard passes), so the walk must too, or
    # the root resolves to zero files, silently.
    real = tmp_path / "real"
    real.mkdir()
    (real / "meta.a.json").write_text("{}", encoding="utf-8")
    link = tmp_path / "link"
    link.symlink_to(real, target_is_directory=True)

    ids = [s.id for s in DirectorySource(link).expand()]
    assert ids == ["meta.a.json"]


def test_directory_source_follows_a_symlinked_subdirectory(tmp_path: Path) -> None:
    # I1, second arm: a symlinked SUBDIRECTORY inside a walked tree.
    (tmp_path / "meta.top.json").write_text("{}", encoding="utf-8")
    external = tmp_path.parent / f"{tmp_path.name}-external"
    external.mkdir()
    (external / "meta.linked.json").write_text("{}", encoding="utf-8")
    (tmp_path / "linked").symlink_to(external, target_is_directory=True)

    ids = sorted(s.id for s in DirectorySource(tmp_path).expand())
    assert ids == ["meta.linked.json", "meta.top.json"]


def test_directory_source_symlink_cycle_fails_loudly_rather_than_hanging(
    tmp_path: Path,
) -> None:
    from metaobjects.loader.sources import SymlinkLoopError

    (tmp_path / "meta.top.json").write_text("{}", encoding="utf-8")
    # A directory symlinked to its own ancestor — a cycle.
    (tmp_path / "loop").symlink_to(tmp_path, target_is_directory=True)

    with pytest.raises(SymlinkLoopError):
        list(DirectorySource(tmp_path).expand())


def test_uri_source_file_scheme_reads_content(tmp_path: Path) -> None:
    p = tmp_path / "x.json"
    p.write_text("{}", encoding="utf-8")
    src = UriSource(p.as_uri())
    assert src.format == MetaDataFormat.JSON
    assert src.read() == "{}"


def test_uri_source_format_inferred_from_path(tmp_path: Path) -> None:
    p = tmp_path / "x.yaml"
    p.write_text("k: v", encoding="utf-8")
    src = UriSource(p.as_uri())
    assert src.format == MetaDataFormat.YAML


def test_uri_source_http_scheme_decodes_utf8() -> None:
    fake_response = MagicMock()
    fake_response.read.return_value = b'{"metadata.root":{"package":"x","children":[]}}'
    fake_response.__enter__ = lambda self: self
    fake_response.__exit__ = lambda self, *a: None

    with patch(
        "metaobjects.loader.sources.uri_source.urlopen",
        return_value=fake_response,
    ) as mock_open:
        src = UriSource("https://example.com/meta.json")
        content = src.read()

    assert content == '{"metadata.root":{"package":"x","children":[]}}'
    # Verify timeout was passed
    args, kwargs = mock_open.call_args
    assert kwargs.get("timeout") == 30.0


def test_uri_source_rejects_unsupported_scheme() -> None:
    src = UriSource("ftp://example.com/foo.json", format=MetaDataFormat.JSON)
    with pytest.raises(ValueError, match="unsupported scheme"):
        src.read()
