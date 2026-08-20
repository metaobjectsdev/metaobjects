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


def test_kind_error_precedes_unresolved_path_regardless_of_order(tmp_path: Path) -> None:
    # Kind validation runs across the WHOLE spec list before any filesystem
    # access, so an unsupported-kind spec always wins over an unresolved-path
    # spec — in EITHER declaration order. Interleaving the two checks one spec
    # at a time (kind-check-then-stat, per spec) would make the reported error
    # code depend on which spec happens to come first; pinned against the
    # TypeScript reference (`sources.ts` `orderedPathSpecs`), verified
    # empirically to raise ERR_SOURCE_KIND_UNSUPPORTED in both orders.
    with pytest.raises(ParseError) as e_missing_first:
        resolve_sources(tmp_path, [{"path": "nope"}, {"resource": "x"}])
    assert e_missing_first.value.code == ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED

    with pytest.raises(ParseError) as e_resource_first:
        resolve_sources(tmp_path, [{"resource": "x"}, {"path": "nope"}])
    assert e_resource_first.value.code == ErrorCode.ERR_SOURCE_KIND_UNSUPPORTED


def test_two_unresolvable_paths_reports_the_content_first_one(tmp_path: Path) -> None:
    # F12 — Pass 2 resolves in CONTENT order (ordinal path-string sort), not
    # declared order, mirroring the TypeScript reference's `orderedPathSpecs`
    # (verified empirically: `resolveSources(dir, [{path:"zzz-missing"},
    # {path:"aaa-missing"}])` names "aaa-missing", the content-first one, even
    # though "zzz-missing" is declared first). With BOTH paths unresolvable,
    # only the port that content-sorts before Pass 2 names "aaa-missing" here;
    # a declared-order implementation would name "zzz-missing" instead.
    with pytest.raises(ParseError) as e:
        resolve_sources(tmp_path, [{"path": "zzz-missing"}, {"path": "aaa-missing"}])
    assert "aaa-missing" in str(e.value)
    assert "zzz-missing" not in str(e.value)


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
