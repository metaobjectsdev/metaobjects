import json
import pytest
from pathlib import Path

from metaobjects.config.source_resolver import resolve_collection, resolve_sources
from metaobjects.errors import ErrorCode, ParseError


def _rel(root: Path, files: list[Path]) -> set[str]:
    return {p.relative_to(root).as_posix() for p in files}


def test_directory_is_walked_recursively(tmp_path: Path) -> None:
    (tmp_path / "model" / "nested").mkdir(parents=True)
    (tmp_path / "model" / "a.json").write_text("{}")
    (tmp_path / "model" / "nested" / "b.yaml").write_text("{}")
    (tmp_path / "model" / "README.md").write_text("x")
    got = resolve_sources(tmp_path, [{"path": "model"}])
    assert _rel(tmp_path, got) == {"model/a.json", "model/nested/b.yaml"}


def test_single_file_spec(tmp_path: Path) -> None:
    (tmp_path / "vendor").mkdir()
    (tmp_path / "vendor" / "one.json").write_text("{}")
    (tmp_path / "vendor" / "two.json").write_text("{}")
    got = resolve_sources(tmp_path, [{"path": "vendor/one.json"}])
    assert _rel(tmp_path, got) == {"vendor/one.json"}


def test_overlapping_sources_dedupe(tmp_path: Path) -> None:
    (tmp_path / "model" / "nested").mkdir(parents=True)
    (tmp_path / "model" / "a.json").write_text("{}")
    (tmp_path / "model" / "nested" / "b.json").write_text("{}")
    got = resolve_sources(tmp_path, [{"path": "model"}, {"path": "model/nested"}])
    assert _rel(tmp_path, got) == {"model/a.json", "model/nested/b.json"}
    assert len(got) == 2


def test_missing_path_raises_unresolved(tmp_path: Path) -> None:
    with pytest.raises(ParseError) as e:
        resolve_sources(tmp_path, [{"path": "nope"}])
    assert e.value.code == ErrorCode.ERR_SOURCE_UNRESOLVED


def test_resource_kind_unsupported(tmp_path: Path) -> None:
    with pytest.raises(ParseError) as e:
        resolve_sources(tmp_path, [{"resource": "com/acme"}])
    assert e.value.code == ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED


def test_collection_falls_back_to_default_dir(tmp_path: Path) -> None:
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "a.json").write_text("{}")
    got = resolve_collection(tmp_path)
    assert _rel(tmp_path, got) == {"metaobjects/a.json"}


def test_collection_with_no_config_and_no_default_raises(tmp_path: Path) -> None:
    with pytest.raises(ParseError) as e:
        resolve_collection(tmp_path)
    assert e.value.code == ErrorCode.ERR_COLLECTION_NOT_FOUND


def test_declared_sources_replace_the_default(tmp_path: Path) -> None:
    (tmp_path / ".metaobjects").mkdir()
    (tmp_path / ".metaobjects" / "config.json").write_text(
        json.dumps({"schema_version": 1, "sources": [{"path": "model"}]})
    )
    (tmp_path / "metaobjects").mkdir()
    (tmp_path / "metaobjects" / "ignored.json").write_text("{}")
    (tmp_path / "model").mkdir()
    (tmp_path / "model" / "used.json").write_text("{}")
    got = resolve_collection(tmp_path)
    assert _rel(tmp_path, got) == {"model/used.json"}
