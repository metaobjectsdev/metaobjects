"""#267 — declarative config loader unit tests."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from metaobjects.codegen.project_config import (
    CONFIG_FILENAME,
    DEFAULT_METADATA_DIR,
    TARGET_KEYS,
    TOP_LEVEL_KEYS,
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


# A key you write into the config and the loader silently drops is the failure class the
# 0.24.x line was cut to prevent — the tool reporting success for work it did not do.
# `metaobjects-config.schema.json` has ALWAYS declared `"additionalProperties": false`, at
# the top level and per target, so an editor validating against the shipped schema already
# rejects an unknown key. The loader — the thing that actually runs — accepted it and moved
# on, so the two disagreed and the permissive one won.
def test_an_unknown_top_level_key_is_refused_not_silently_dropped(tmp_path: Path) -> None:
    p = _write(
        tmp_path,
        """
        columnNaming: snake_case
        targets:
          models:
            outDir: out
        """,
    )
    with pytest.raises(ConfigError, match="columnNaming"):
        load_project_config(p)


def test_the_refusal_names_what_is_accepted(tmp_path: Path) -> None:
    # Naming only the offender leaves the author guessing at the spelling; the fix for a
    # typo is the correct key, so the message has to carry it.
    p = _write(tmp_path, "metadta: model\ntargets:\n  m:\n    outDir: out\n")
    with pytest.raises(ConfigError, match="metadata"):
        load_project_config(p)


def test_an_unknown_per_target_key_is_refused(tmp_path: Path) -> None:
    p = _write(
        tmp_path,
        """
        targets:
          models:
            outDir: out
            columnNaming: snake_case
        """,
    )
    with pytest.raises(ConfigError, match="columnNaming"):
        load_project_config(p)


def test_libraries_is_accepted_and_is_not_mistaken_for_an_unknown_key(tmp_path: Path) -> None:
    # The refusal must not convict a key the loader has supported all along.
    p = _write(tmp_path, "libraries: []\ntargets:\n  m:\n    outDir: out\n")
    assert load_project_config(p).libraries == []


def test_schema_and_loader_accept_EXACTLY_the_same_keys(tmp_path: Path) -> None:
    """The gate that would have caught this, in BOTH directions.

    The existing shape test asserts ``set(props) >= {...}`` — a superset — so it could
    never see a key the loader accepts and the schema omits. ``libraries`` was exactly
    that: supported by the loader since the library-packages work, absent from the schema,
    so any editor validating a perfectly valid config against the shipped schema flagged
    it (the schema declares ``additionalProperties: false``). Compare EXACT sets, so a key
    added to either side without the other fails here.
    """
    schema_path = (
        Path(__file__).parents[2]
        / "src" / "metaobjects" / "codegen" / "metaobjects-config.schema.json"
    )
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    assert set(schema["properties"]) == set(TOP_LEVEL_KEYS)
    target_props = schema["properties"]["targets"]["additionalProperties"]["properties"]
    assert set(target_props) == set(TARGET_KEYS)
    # Both levels must keep saying unknown keys are invalid — that claim is what the
    # loader now enforces.
    assert schema["additionalProperties"] is False
    assert schema["properties"]["targets"]["additionalProperties"]["additionalProperties"] is False
