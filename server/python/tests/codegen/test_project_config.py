"""#267 — declarative config loader unit tests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.codegen.project_config import (
    CONFIG_FILENAME,
    DEFAULT_METADATA_DIR,
    ConfigError,
    ProjectConfig,
    TargetConfig,
    load_project_config,
)


def _write(tmp_path: Path, text: str, name: str = CONFIG_FILENAME) -> Path:
    p = tmp_path / name
    p.write_text(text, encoding="utf-8")
    return p


def test_minimal_targets_only_applies_defaults(tmp_path: Path) -> None:
    p = _write(
        tmp_path,
        """
        targets:
          models:
            outDir: pkg/generated
        """,
    )
    cfg = load_project_config(p)
    assert isinstance(cfg, ProjectConfig)
    assert cfg.metadata == DEFAULT_METADATA_DIR
    assert cfg.providers == []
    assert len(cfg.targets) == 1
    t = cfg.targets[0]
    assert t == TargetConfig(name="models", out_dir="pkg/generated", generators=None, entities=None)
    # metadata + outDir resolve relative to the config file's directory.
    assert cfg.metadata_dir() == str((tmp_path / DEFAULT_METADATA_DIR).resolve())
    assert cfg.out_dir_for(t) == str((tmp_path / "pkg/generated").resolve())


def test_full_config_parses(tmp_path: Path) -> None:
    p = _write(
        tmp_path,
        """
        metadata: ./meta
        providers: ["my_provider:provider", "other:make"]
        targets:
          models:
            outDir: pkg/models/generated
            generators: [entity]
            entities: [Program, Week]
          other:
            outDir: pkg/other/generated
            generators: [entity, routes]
        """,
    )
    cfg = load_project_config(p)
    assert cfg.metadata == "./meta"
    assert cfg.providers == ["my_provider:provider", "other:make"]
    assert [t.name for t in cfg.targets] == ["models", "other"]  # insertion order preserved
    assert cfg.target("models").entities == ["Program", "Week"]
    assert cfg.target("other").generators == ["entity", "routes"]
    assert cfg.target("nope") is None


def test_absolute_paths_are_not_reparented(tmp_path: Path) -> None:
    abs_out = tmp_path / "elsewhere"
    p = _write(
        tmp_path,
        f"""
        metadata: {abs_out}
        targets:
          t:
            outDir: {abs_out}
        """,
    )
    cfg = load_project_config(p)
    assert cfg.metadata_dir() == str(abs_out.resolve())
    assert cfg.out_dir_for(cfg.targets[0]) == str(abs_out.resolve())


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ConfigError, match="not found"):
        load_project_config(tmp_path / "nope.yaml")


def test_unreadable_non_utf8_config_raises_configerror_not_traceback(tmp_path: Path) -> None:
    """A non-UTF-8 config file must fail with a ConfigError ("cannot read"), not a
    raw UnicodeDecodeError escaping the ConfigError "no stack trace" contract."""
    p = tmp_path / CONFIG_FILENAME
    p.write_bytes(b"\xff\xfe\x00 targets: bad")
    with pytest.raises(ConfigError, match="cannot read"):
        load_project_config(p)


@pytest.mark.parametrize(
    "text, match",
    [
        ("[]", "must be a mapping"),
        ("metadata: 3\ntargets:\n  t:\n    outDir: x\n", "'metadata' must be a string"),
        ("targets: {}\n", "non-empty mapping"),
        ("providers: notalist\ntargets:\n  t:\n    outDir: x\n", "'providers'"),
        ("targets:\n  t: 5\n", "must be a mapping"),
        ("targets:\n  t:\n    generators: [entity]\n", "'outDir'"),
        ("targets:\n  t:\n    outDir: x\n    generators: 3\n", "'generators'"),
        ("targets:\n  t:\n    outDir: x\n    entities: [1, 2]\n", "'entities'"),
        (": : :\n", "invalid YAML"),
        ("", "empty"),
    ],
)
def test_invalid_config_raises_configerror(tmp_path: Path, text: str, match: str) -> None:
    p = _write(tmp_path, text)
    with pytest.raises(ConfigError, match=match):
        load_project_config(p)


def test_schema_file_is_valid_json_and_matches_shape(tmp_path: Path) -> None:
    schema_path = (
        Path(__file__).parents[2]
        / "src"
        / "metaobjects"
        / "codegen"
        / "metaobjects-config.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert schema["type"] == "object"
    assert "targets" in schema["required"]
    props = schema["properties"]
    assert set(props) >= {"metadata", "providers", "targets"}
    target_props = schema["properties"]["targets"]["additionalProperties"]["properties"]
    assert set(target_props) == {"outDir", "generators", "entities"}
