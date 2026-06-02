"""Unit tests for ``FilesystemProvider`` (mirrors the C#/Java FilesystemProvider semantics)."""

from __future__ import annotations

from pathlib import Path

from metaobjects.render import FilesystemProvider


def test_resolves_existing_template(tmp_path: Path) -> None:
    group = tmp_path / "g"
    group.mkdir()
    (group / "s.mustache").write_text("Hi {{name}}.", encoding="utf-8")

    provider = FilesystemProvider(tmp_path)
    assert provider.resolve("g/s") == "Hi {{name}}."


def test_missing_template_returns_none(tmp_path: Path) -> None:
    provider = FilesystemProvider(tmp_path)
    assert provider.resolve("g/missing") is None


def test_path_traversal_ref_returns_none(tmp_path: Path) -> None:
    provider = FilesystemProvider(tmp_path)
    assert provider.resolve("../escape") is None


def test_empty_and_none_ref_returns_none(tmp_path: Path) -> None:
    provider = FilesystemProvider(tmp_path)
    assert provider.resolve("") is None
    assert provider.resolve(None) is None


def test_custom_extension(tmp_path: Path) -> None:
    (tmp_path / "t.txt").write_text("body", encoding="utf-8")
    provider = FilesystemProvider(tmp_path, extension=".txt")
    assert provider.resolve("t") == "body"
