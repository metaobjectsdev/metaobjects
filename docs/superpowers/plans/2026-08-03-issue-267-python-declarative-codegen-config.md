# Python declarative codegen config (targets registry) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a declarative `metaobjects.config.yaml` for the Python port — a targets registry — so `metaobjects gen` / `verify --codegen` run every target with no flags and provider modules resolve relative to the config (killing the `PYTHONPATH=` requirement and the duplicated CI entity lists), while the existing positional-`metadata_dir` + `--out` flag path stays byte-identical.

**Architecture:** A new `metaobjects.codegen.project_config` module parses + validates a YAML config into typed dataclasses (`ProjectConfig` / `TargetConfig`). `cli.py` gains a config-mode branch on both `gen` and `verify --codegen`: config mode triggers **only** when no positional `metadata_dir` is given, so the flag path is untouched. Config mode loads metadata once, prepends the config's directory to `sys.path` (config-relative providers), and runs each target's generator/entity selection into its own `outDir`, with a cross-target duplicate-output-path guard the per-pass `run_gen` guard can't provide.

**Tech Stack:** Python 3.10+, `argparse`, PyYAML (`yaml.safe_load` — already a dependency, ADR-0006), pytest. Hatchling wheel build (ships non-`.py` package data).

## Global Constraints

- **Python-only, additive.** No metamodel/vocabulary change, no conformance-fixture change, NO coordinated release. TS/Java/C#/Kotlin unchanged.
- **Schema keys identical to TS** (`metaobjects.config.ts` vocabulary): `targets.<name>.{outDir, generators, entities}`, `providers`, `metadata`. Use `outDir` (NOT `out`). The file *surface* differs per port; the *schema* does not (ADR-0021 D3 / FR-025).
- **YAML, not `.py`.** Python's config surface is pure data; the provider CODE stays in its module, referenced by `module:symbol` (#158).
- **Back-compat is load-bearing.** Config mode triggers **only** when the positional `metadata_dir` is absent. An explicit `metadata_dir` + `--out` keeps today's flag path byte-identical; the config is NOT consulted, even if a `metaobjects.config.yaml` sits in cwd.
- **Provider resolution is config-relative.** Prepend the config file's directory to `sys.path` before the existing `_resolve_providers` importlib path; `module:symbol` strings unchanged.
- **Publish a JSON Schema** beside the loader (mirror `template-spec.schema.json`) for editor autocomplete + non-Python validation.
- **Public repo hygiene.** No private/other-project names, no absolute home paths in any committed file, commit message, or fixture. Use generic terms.
- **Named constants / no magic strings** where the codebase already uses them. Reuse existing helpers (`_run_suite`, `_resolve_generators`, `_load_root`, `_relative_set`) — do not re-implement.
- **Commit author** `Doug Mealing <doug@dougmealing.com>` with the repo's `Co-Authored-By` / `Claude-Session` trailers. TDD throughout (RED before GREEN). Run tests scoped: `cd server/python && uv run pytest -q`.

---

## File Structure

- **Create** `server/python/src/metaobjects/codegen/project_config.py` — the config loader: `ConfigError`, `TargetConfig`, `ProjectConfig`, `load_project_config()`, `CONFIG_FILENAME`, `DEFAULT_METADATA_DIR`. One responsibility: YAML text → validated typed config, with path-resolution helpers.
- **Create** `server/python/src/metaobjects/codegen/metaobjects-config.schema.json` — the published JSON Schema (tooling/editor artifact; the loader validates in Python and does not read it at runtime).
- **Modify** `server/python/src/metaobjects/cli.py` — add config-mode helpers (`_find_config`, `_config_providers`, `_select_targets`, `_run_gen_targets`, `_cmd_gen_config`, `_verify_codegen_config`, `_verify_one_target`), branch `_cmd_gen` / `_verify_codegen` on config mode, guard `_verify_templates` against a missing `metadata_dir`, and extend `_build_parser` (`--config` + `--target` on `gen` and `verify`; `verify` positional → optional).
- **Create** `server/python/tests/codegen/test_project_config.py` — loader unit tests.
- **Create** `server/python/tests/codegen/test_cli_config_gen.py` — `gen` config-mode integration tests.
- **Create** `server/python/tests/codegen/test_cli_config_verify.py` — `verify --codegen` config-mode integration tests.
- **Modify** `server/python/src/metaobjects/codegen/KNOWN_GAPS.md` — mark the targets-registry gap closed.
- **Modify** `docs/features/cli.md` — document the Python declarative config.

**Interfaces produced by Task 1 (every later task consumes these exact names):**

```python
# metaobjects.codegen.project_config
CONFIG_FILENAME: str = "metaobjects.config.yaml"
DEFAULT_METADATA_DIR: str = "metaobjects"

class ConfigError(ValueError): ...

@dataclass(frozen=True)
class TargetConfig:
    name: str
    out_dir: str
    generators: list[str] | None   # stable registry names; None => default suite
    entities: list[str] | None     # allowlist; None => all entities

@dataclass(frozen=True)
class ProjectConfig:
    config_dir: Path
    metadata: str
    providers: list[str]
    targets: list[TargetConfig]
    def metadata_dir(self) -> str: ...        # metadata resolved under config_dir (abs path)
    def target(self, name: str) -> TargetConfig | None: ...
    def out_dir_for(self, target: TargetConfig) -> str: ...  # out_dir resolved under config_dir (abs path)

def load_project_config(path: Path) -> ProjectConfig: ...   # raises ConfigError
```

---

## Task 1: Config loader module + JSON Schema

**Files:**
- Create: `server/python/src/metaobjects/codegen/project_config.py`
- Create: `server/python/src/metaobjects/codegen/metaobjects-config.schema.json`
- Test: `server/python/tests/codegen/test_project_config.py`

**Interfaces:**
- Consumes: nothing (leaf module; `yaml` + stdlib only).
- Produces: the full public surface listed above.

- [ ] **Step 1: Write the failing loader tests**

Create `server/python/tests/codegen/test_project_config.py`:

```python
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/python && uv run pytest tests/codegen/test_project_config.py -q`
Expected: FAIL — `ModuleNotFoundError: metaobjects.codegen.project_config`.

- [ ] **Step 3: Write the loader module**

Create `server/python/src/metaobjects/codegen/project_config.py`:

```python
"""Declarative project config for the Python codegen CLI (#267).

`metaobjects.config.yaml` describes a project's codegen surface once — a targets
registry (per-target ``outDir`` + generator selection + entity allowlist), the
metadata dir, and consumer providers — so ``metaobjects gen`` / ``verify --codegen``
run every target with no flags and provider modules resolve relative to the config
(no ``PYTHONPATH=``). YAML, not ``.py``: Python's config surface is pure data (the
provider CODE stays in its module, referenced by ``module:symbol`` per #158) —
unlike TS's executable ``metaobjects.config.ts`` (ADR-0034 owned generators / live
providers).

Schema keys are IDENTICAL to the TS ``metaobjects.config.ts`` vocabulary
(``targets.<name>.{outDir, generators, entities}``, ``providers``, ``metadata``) so
a polyglot adopter learns one vocabulary; the file SURFACE differs per port, the
SCHEMA does not (ADR-0021 D3 / FR-025). A JSON Schema ships beside this loader
(``metaobjects-config.schema.json``) for editor autocomplete + non-Python
validation.

Python-only, additive: no metamodel/vocabulary change; the existing positional
``metadata_dir`` + ``--out`` flag path is untouched and byte-identical.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import yaml  # type: ignore[import-untyped]  # PyYAML ships no type stubs

#: Config filename looked up in the cwd when ``--config`` is not given.
CONFIG_FILENAME = "metaobjects.config.yaml"

#: Default metadata directory (relative to the config file) when ``metadata:`` is omitted.
DEFAULT_METADATA_DIR = "metaobjects"


class ConfigError(ValueError):
    """A ``metaobjects.config.yaml`` that is missing, malformed, or invalid.

    Carries a single user-facing message (no stack trace) — the CLI prints it and
    exits non-zero.
    """


@dataclass(frozen=True)
class TargetConfig:
    """One named run-spec: where to write + which generators/entities to run.

    NOTE (cross-port reconciliation, design §Schema): TS ``targets`` are pure output
    DESTINATIONS (a generator picks a target; ``TargetConfig`` carries no selection),
    while a declarative-port target is a destination PLUS a selection (``generators``
    + ``entities``). The shared keys (``outDir``/``generators``/``entities``) stay
    identical.
    """

    #: The target's map key (``targets.<name>``).
    name: str
    #: Output directory, relative to the config file's directory (or absolute).
    out_dir: str
    #: Stable generator names (registry ids); ``None`` => the default suite.
    generators: list[str] | None
    #: Entity-name allowlist; ``None`` => every entity.
    entities: list[str] | None


@dataclass(frozen=True)
class ProjectConfig:
    #: Directory containing the config file — the base for resolving ``metadata``,
    #: ``providers`` (sys.path), and each target's ``outDir``.
    config_dir: Path
    #: Metadata directory (relative to ``config_dir`` or absolute).
    metadata: str
    #: Consumer provider refs (``module:symbol``), resolved config-relative.
    providers: list[str]
    #: Ordered run-specs (YAML map insertion order preserved).
    targets: list[TargetConfig]

    def metadata_dir(self) -> str:
        """The metadata dir resolved against ``config_dir`` (absolute path string)."""
        return _resolve_under(self.config_dir, self.metadata)

    def target(self, name: str) -> TargetConfig | None:
        return next((t for t in self.targets if t.name == name), None)

    def out_dir_for(self, target: TargetConfig) -> str:
        """``target.out_dir`` resolved against ``config_dir`` (absolute path string)."""
        return _resolve_under(self.config_dir, target.out_dir)


def _resolve_under(base: Path, p: str) -> str:
    q = Path(p)
    return str(q if q.is_absolute() else (base / q).resolve())


def _require_str_list(value: object, ctx: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise ConfigError(f"{ctx} must be a list of strings.")
    return list(value)


def load_project_config(path: Path) -> ProjectConfig:
    """Parse + validate ``metaobjects.config.yaml`` at ``path``.

    Raises :class:`ConfigError` (single user-facing message) on a missing file,
    invalid YAML, or any shape violation. Defaults: ``metadata`` =>
    ``DEFAULT_METADATA_DIR``, ``providers`` => ``[]``, per-target ``generators`` /
    ``entities`` => ``None`` (default suite / all entities).
    """
    if not path.is_file():
        raise ConfigError(f"config file not found: {path}")
    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ConfigError(f"{path}: invalid YAML: {exc}") from exc

    if raw is None:
        raise ConfigError(f"{path}: config is empty.")
    if not isinstance(raw, dict):
        raise ConfigError(f"{path}: top level must be a mapping.")

    metadata = raw.get("metadata", DEFAULT_METADATA_DIR)
    if not isinstance(metadata, str):
        raise ConfigError(f"{path}: 'metadata' must be a string (a directory path).")

    providers = _require_str_list(raw.get("providers", []), f"{path}: 'providers'")

    targets_raw = raw.get("targets")
    if not isinstance(targets_raw, dict) or not targets_raw:
        raise ConfigError(
            f"{path}: 'targets' must be a non-empty mapping of "
            "<name> -> {outDir, generators?, entities?}."
        )

    targets: list[TargetConfig] = []
    for name, spec in targets_raw.items():
        ctx = f"{path}: target '{name}'"
        if not isinstance(spec, dict):
            raise ConfigError(f"{ctx} must be a mapping.")
        out_dir = spec.get("outDir")
        if not isinstance(out_dir, str) or not out_dir:
            raise ConfigError(f"{ctx} must declare a non-empty 'outDir' string.")
        generators = spec.get("generators")
        if generators is not None:
            generators = _require_str_list(generators, f"{ctx} 'generators'")
        entities = spec.get("entities")
        if entities is not None:
            entities = _require_str_list(entities, f"{ctx} 'entities'")
        targets.append(
            TargetConfig(name=str(name), out_dir=out_dir, generators=generators, entities=entities)
        )

    return ProjectConfig(
        config_dir=path.parent.resolve(),
        metadata=metadata,
        providers=providers,
        targets=targets,
    )
```

- [ ] **Step 4: Write the JSON Schema**

Create `server/python/src/metaobjects/codegen/metaobjects-config.schema.json`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://metaobjects.dev/schemas/metaobjects-config.schema.json",
  "title": "MetaObjects Python codegen config",
  "description": "Declarative config for the `metaobjects` Python CLI (#267). Schema keys mirror the TS metaobjects.config.ts vocabulary (outDir/generators/entities/providers/metadata).",
  "type": "object",
  "additionalProperties": false,
  "required": ["targets"],
  "properties": {
    "metadata": {
      "type": "string",
      "description": "Metadata directory, relative to this config file. Default: metaobjects",
      "default": "metaobjects"
    },
    "providers": {
      "type": "array",
      "items": { "type": "string", "pattern": "^[^:]+:[^:]+$" },
      "description": "Consumer provider refs as 'module:symbol', resolved relative to this config file's directory (no PYTHONPATH needed)."
    },
    "targets": {
      "type": "object",
      "minProperties": 1,
      "description": "Named run-specs; each key is a target name.",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": ["outDir"],
        "properties": {
          "outDir": {
            "type": "string",
            "description": "Output directory, relative to this config file."
          },
          "generators": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Stable generator names (see `metaobjects gen --list`). Omit to run the default suite."
          },
          "entities": {
            "type": "array",
            "items": { "type": "string" },
            "description": "Entity-name allowlist. Omit to emit every entity."
          }
        }
      }
    }
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server/python && uv run pytest tests/codegen/test_project_config.py -q`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add server/python/src/metaobjects/codegen/project_config.py \
        server/python/src/metaobjects/codegen/metaobjects-config.schema.json \
        server/python/tests/codegen/test_project_config.py
git commit -m "feat(#267): declarative config loader + JSON Schema (Python)"
```

---

## Task 2: `gen` config mode (all-targets, `--target`, dup guard, config-relative providers)

**Files:**
- Modify: `server/python/src/metaobjects/cli.py`
- Test: `server/python/tests/codegen/test_cli_config_gen.py`

**Interfaces:**
- Consumes: `project_config.{CONFIG_FILENAME, ConfigError, ProjectConfig, TargetConfig, load_project_config}`; existing `cli._run_suite`, `cli._resolve_generators`, `cli._resolve_providers`, `cli._load_root`.
- Produces: `cli._find_config`, `cli._config_providers`, `cli._select_targets`, `cli._run_gen_targets`, `cli._cmd_gen_config`; `gen` gains `--config` / `--target`; `_cmd_gen` branches on config mode.

- [ ] **Step 1: Write the failing gen-config integration tests**

Create `server/python/tests/codegen/test_cli_config_gen.py`:

```python
"""#267 — `metaobjects gen` declarative-config mode (no-arg, targets registry)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

from metaobjects.cli import main

FITNESS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)


def _project(tmp_path: Path, config_text: str, meta_subdir: str = "metaobjects") -> Path:
    """Write a config + a metadata dir (fitness fixture) under tmp_path. Return the config path."""
    meta = tmp_path / meta_subdir
    meta.mkdir(parents=True)
    (meta / "meta.fitness.json").write_text(FITNESS.read_text())
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(config_text)
    return cfg


TWO_TARGETS = """
targets:
  models:
    outDir: gen/models
    generators: [entity]
    entities: [Program, Week]
  other:
    outDir: gen/other
    generators: [entity]
    entities: [Node, Measurement]
"""


def test_gen_no_args_runs_all_targets_via_config_flag(tmp_path: Path) -> None:
    cfg = _project(tmp_path, TWO_TARGETS)
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 0
    assert (tmp_path / "gen/models/Program.py").exists()
    assert (tmp_path / "gen/models/Week.py").exists()
    assert (tmp_path / "gen/other/Node.py").exists()
    assert (tmp_path / "gen/other/Measurement.py").exists()
    # allowlists honored per target
    assert not (tmp_path / "gen/models/Node.py").exists()
    assert not (tmp_path / "gen/other/Program.py").exists()


def test_gen_no_args_discovers_config_in_cwd(tmp_path: Path, monkeypatch) -> None:
    _project(tmp_path, TWO_TARGETS)
    monkeypatch.chdir(tmp_path)
    rc = main(["gen"])
    assert rc == 0
    assert (tmp_path / "gen/models/Program.py").exists()


def test_gen_target_scopes_to_one(tmp_path: Path) -> None:
    cfg = _project(tmp_path, TWO_TARGETS)
    rc = main(["gen", "--config", str(cfg), "--target", "models"])
    assert rc == 0
    assert (tmp_path / "gen/models/Program.py").exists()
    assert not (tmp_path / "gen/other").exists()


def test_gen_unknown_target_errors(tmp_path: Path, capsys) -> None:
    cfg = _project(tmp_path, TWO_TARGETS)
    rc = main(["gen", "--config", str(cfg), "--target", "nope"])
    assert rc == 1
    assert "unknown --target" in capsys.readouterr().err


def test_gen_missing_config_errors(tmp_path: Path, monkeypatch, capsys) -> None:
    monkeypatch.chdir(tmp_path)  # no config here
    rc = main(["gen"])
    assert rc == 2
    assert "metaobjects.config.yaml" in capsys.readouterr().err


DUP_TARGETS = """
targets:
  a:
    outDir: shared/gen
    generators: [entity]
    entities: [Program]
  b:
    outDir: shared/gen
    generators: [entity]
    entities: [Program]
"""


def test_gen_cross_target_duplicate_output_path_guard(tmp_path: Path, capsys) -> None:
    cfg = _project(tmp_path, DUP_TARGETS)
    rc = main(["gen", "--config", str(cfg)])
    assert rc == 1
    assert "duplicate output path across targets" in capsys.readouterr().err


# --- config-relative provider (no PYTHONPATH) -------------------------------

PROVIDER_MODULE = '''
from metaobjects.provider import Provider
from metaobjects.registry import TypeDefinition
from metaobjects.meta.meta_data import MetaData

geo_provider = Provider("test-geocheck", ("metaobjects-core-types",))
geo_provider.add(TypeDefinition(
    type="validator",
    sub_type="geocheck",
    factory=lambda t, s, n: MetaData(t, s, n),
    description="A custom validator",
))
'''

CUSTOM_META = {
    "metadata.root": {
        "package": "acme::geo",
        "children": [
            {
                "object.entity": {
                    "name": "Place",
                    "children": [
                        {"field.long": {"name": "id"}},
                        {
                            "field.string": {
                                "name": "name",
                                "children": [{"validator.geocheck": {"name": "chk"}}],
                            }
                        },
                        {"source.rdb": {"name": "src", "@table": "places"}},
                        {
                            "identity.primary": {
                                "name": "pk",
                                "@fields": ["id"],
                                "@generation": "increment",
                            }
                        },
                    ],
                }
            }
        ],
    }
}


def test_gen_resolves_provider_config_relative_without_pythonpath(tmp_path: Path) -> None:
    """A provider module beside the config resolves via the config dir on sys.path,
    with NO caller PYTHONPATH / sys.path manipulation."""
    meta = tmp_path / "metaobjects_meta"
    meta.mkdir()
    (meta / "meta.json").write_text(json.dumps(CUSTOM_META))
    (tmp_path / "geo_conf_prov.py").write_text(PROVIDER_MODULE)
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(
        """
        metadata: metaobjects_meta
        providers: ["geo_conf_prov:geo_provider"]
        targets:
          models:
            outDir: gen
            generators: [entity]
        """
    )
    assert str(tmp_path) not in sys.path  # precondition: not already importable
    try:
        rc = main(["gen", "--config", str(cfg)])
    finally:
        if str(tmp_path) in sys.path:
            sys.path.remove(str(tmp_path))
        sys.modules.pop("geo_conf_prov", None)
    assert rc == 0
    assert (tmp_path / "gen/Place.py").exists()


def test_gen_flag_path_ignores_config_when_present(tmp_path: Path) -> None:
    """Back-compat: an explicit <metadata_dir> + --out uses the flag path and does
    NOT consult a metaobjects.config.yaml sitting in cwd (byte-identical)."""
    _project(tmp_path, DUP_TARGETS)  # a config that WOULD fail (dup guard) if consulted
    out = tmp_path / "flagout"
    meta = tmp_path / "metaobjects"  # created by _project
    # Flag path: metadata_dir + --out present => config ignored, normal gen.
    rc = main(["gen", str(meta), "--out", str(out)])
    assert rc == 0
    assert (out / "Program.py").exists()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/python && uv run pytest tests/codegen/test_cli_config_gen.py -q`
Expected: FAIL — `gen` with no positional currently errors exit 2 ("gen requires <metadata_dir> and --out"), and `--config`/`--target` are unknown args.

- [ ] **Step 3: Add the imports + config helpers to `cli.py`**

Add to the imports near `from metaobjects.codegen.config import GenConfig` (line ~54):

```python
from metaobjects.codegen.project_config import (
    CONFIG_FILENAME,
    ConfigError,
    ProjectConfig,
    TargetConfig,
    load_project_config,
)
```

Add these helpers (place them just after `_providers_from_args`, ~line 181):

```python
def _find_config(args: argparse.Namespace) -> Path | None:
    """The config path: ``--config`` if given (even if missing → clear load error),
    else ``./metaobjects.config.yaml`` in cwd when it exists, else ``None``."""
    explicit = getattr(args, "config", None)
    if explicit:
        return Path(explicit)
    default = Path.cwd() / CONFIG_FILENAME
    return default if default.is_file() else None


def _config_providers(config: ProjectConfig) -> tuple[list[object], bool]:
    """Resolve ``config.providers`` with the config file's directory on ``sys.path``.

    #267: prepend the config directory so a ``module:symbol`` provider living beside
    the config imports with no ``PYTHONPATH=``. Idempotent; the entry is left in
    place (a short-lived CLI process). Prints resolution errors; returns (providers, ok).
    """
    config_dir = str(config.config_dir)
    if config_dir not in sys.path:
        sys.path.insert(0, config_dir)
    providers, errors = _resolve_providers(config.providers)
    if errors:
        print("error: invalid provider in config:", file=sys.stderr)
        for msg in errors:
            print(f"  {msg}", file=sys.stderr)
        return providers, False
    return providers, True


def _select_targets(
    config: ProjectConfig, target_name: str | None
) -> tuple[list[TargetConfig], str | None]:
    """All targets, or the single ``--target`` (error string when the name is unknown)."""
    if target_name is None:
        return config.targets, None
    t = config.target(target_name)
    if t is None:
        known = ", ".join(sorted(x.name for x in config.targets))
        return [], f"unknown --target {target_name!r}; known targets: {known}"
    return [t], None
```

- [ ] **Step 4: Add `_run_gen_targets` + `_cmd_gen_config`**

Place after `_cmd_gen` (or just before it). `_run_gen_targets` carries the cross-target guard:

```python
def _run_gen_targets(
    config: ProjectConfig, targets: list[TargetConfig], root: MetaData
) -> tuple[list[str], list[str]]:
    """Run each target's suite into its ``outDir``. Returns (all_written, errors).

    Cross-target duplicate-output-path guard (#267): ``run_gen``'s collision guard
    is per-pass, so two targets writing the same full path would silently clobber
    (generated files carry the @generated header). We accumulate every written full
    path across targets and record an error when two targets emit the same one.
    (Detection is post-write — the colliding file may already be on disk — but the
    command still fails, so a misconfigured gate is caught in CI.)
    """
    all_written: list[str] = []
    seen: dict[str, str] = {}  # full path -> target name
    errors: list[str] = []
    for t in targets:
        gens: list[Generator] | None = None
        if t.generators is not None:
            gens, gen_errors = _resolve_generators(",".join(t.generators))
            if gen_errors:
                errors.extend(f"target '{t.name}': {m}" for m in gen_errors)
                continue
        out_dir = config.out_dir_for(t)
        try:
            written = _run_suite(root, out_dir, gens, t.entities)
        except ValueError as exc:  # intra-target run_gen collision → clean error
            errors.append(f"target '{t.name}': {exc}")
            continue
        for full in written:
            prior = seen.get(full)
            if prior is not None and prior != t.name:
                errors.append(
                    f"duplicate output path across targets: {full!r} written by "
                    f"both '{prior}' and '{t.name}'."
                )
            else:
                seen[full] = t.name
        all_written.extend(written)
    return all_written, errors


def _cmd_gen_config(args: argparse.Namespace) -> int:
    """``gen`` with no positional ``metadata_dir`` → declarative-config mode (#267).

    Load ``metaobjects.config.yaml``, load metadata ONCE, and run every target
    (or ``--target``) into its own ``outDir`` with a cross-target duplicate-path
    guard. Providers resolve relative to the config file (no ``PYTHONPATH=``).
    """
    config_path = _find_config(args)
    if config_path is None:
        print(
            "error: no <metadata_dir> given and no metaobjects.config.yaml found. "
            "Either pass <metadata_dir> --out (flag mode) or create a "
            "metaobjects.config.yaml (or pass --config <path>).",
            file=sys.stderr,
        )
        return 2
    try:
        config = load_project_config(config_path)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    targets, target_err = _select_targets(config, getattr(args, "target", None))
    if target_err:
        print(f"error: {target_err}", file=sys.stderr)
        return 1

    providers, providers_ok = _config_providers(config)
    if not providers_ok:
        return 1

    root, load_errors = _load_root(config.metadata_dir(), providers=providers)
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in load_errors:
            print(f"  {msg}", file=sys.stderr)
        return 1

    written, errors = _run_gen_targets(config, targets, root)
    if errors:
        for msg in errors:
            print(f"error: {msg}", file=sys.stderr)
        return 1
    for path in written:
        print(path)
    print(
        f"metaobjects gen: wrote {len(written)} file(s) across {len(targets)} target(s)."
    )
    return 0
```

- [ ] **Step 5: Branch `_cmd_gen` on config mode**

In `_cmd_gen`, replace the early metadata/out guard. Current (lines ~423-430):

```python
    _warn_if_agent_context_stale()

    if args.metadata_dir is None or args.out is None:
        print(
            "error: gen requires <metadata_dir> and --out (or use --list).",
            file=sys.stderr,
        )
        return 2
```

becomes:

```python
    _warn_if_agent_context_stale()

    # #267: config mode ⇔ no positional <metadata_dir>. The explicit
    # <metadata_dir> + --out flag path below is untouched (byte-identical).
    if args.metadata_dir is None:
        return _cmd_gen_config(args)
    if args.out is None:
        print(
            "error: gen requires <metadata_dir> and --out "
            "(or a metaobjects.config.yaml / --list).",
            file=sys.stderr,
        )
        return 2
```

- [ ] **Step 6: Add `--config` / `--target` to the `gen` parser**

In `_build_parser`, after the `gen.add_argument("--provider", ...)` block (~line 857), add:

```python
    gen.add_argument(
        "--config",
        default=None,
        help=(
            "path to a metaobjects.config.yaml (declarative targets registry). "
            "Config mode runs when no <metadata_dir> is given; default lookup is "
            "./metaobjects.config.yaml in cwd."
        ),
    )
    gen.add_argument(
        "--target",
        default=None,
        help="run only this named target from the config (default: every target)",
    )
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server/python && uv run pytest tests/codegen/test_cli_config_gen.py -q`
Expected: PASS (all cases, including the config-relative provider and the back-compat flag path).

- [ ] **Step 8: Run the existing CLI suite (no back-compat regressions)**

Run: `cd server/python && uv run pytest tests/codegen/test_cli.py tests/codegen/test_cli_providers.py tests/codegen/test_cli_registry.py -q`
Expected: PASS (unchanged behavior).

- [ ] **Step 9: Commit**

```bash
git add server/python/src/metaobjects/cli.py \
        server/python/tests/codegen/test_cli_config_gen.py
git commit -m "feat(#267): gen config mode — all-targets, --target, cross-target dup guard, config-relative providers"
```

---

## Task 3: `verify --codegen` config mode (per-target regen+diff, aggregate exit)

**Files:**
- Modify: `server/python/src/metaobjects/cli.py`
- Test: `server/python/tests/codegen/test_cli_config_verify.py`

**Interfaces:**
- Consumes: Task 1 loader + Task 2 helpers (`_find_config`, `_config_providers`, `_select_targets`); existing `cli._run_suite`, `cli._relative_set`, `cli._resolve_generators`, `cli._load_root`, `cli._strict_load_hint`.
- Produces: `cli._verify_codegen_config`, `cli._verify_one_target`; `_verify_codegen` branches on config mode; `verify` positional becomes optional; `verify` gains `--config` / `--target`; `_verify_templates` guards a missing `metadata_dir`.

- [ ] **Step 1: Write the failing verify-config integration tests**

Create `server/python/tests/codegen/test_cli_config_verify.py`:

```python
"""#267 — `metaobjects verify --codegen` declarative-config mode (per-target diff)."""
from __future__ import annotations

from pathlib import Path

from metaobjects.cli import main

FITNESS = (
    Path(__file__).parents[4]
    / "fixtures"
    / "persistence-conformance"
    / "canonical"
    / "meta.fitness.json"
)

TWO_TARGETS = """
targets:
  models:
    outDir: gen/models
    generators: [entity]
    entities: [Program, Week]
  other:
    outDir: gen/other
    generators: [entity]
    entities: [Node, Measurement]
"""


def _project(tmp_path: Path) -> Path:
    meta = tmp_path / "metaobjects"
    meta.mkdir()
    (meta / "meta.fitness.json").write_text(FITNESS.read_text())
    cfg = tmp_path / "metaobjects.config.yaml"
    cfg.write_text(TWO_TARGETS)
    return cfg


def test_verify_codegen_no_args_in_sync(tmp_path: Path) -> None:
    cfg = _project(tmp_path)
    assert main(["gen", "--config", str(cfg)]) == 0
    # Fresh gen → no drift across every target.
    assert main(["verify", "--codegen", "--config", str(cfg)]) == 0


def test_verify_codegen_bare_defaults_to_codegen(tmp_path: Path, monkeypatch) -> None:
    cfg = _project(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["gen"]) == 0
    assert main(["verify"]) == 0  # bare verify → --codegen default, config-driven


def test_verify_codegen_detects_drift_in_one_target(tmp_path: Path, capsys) -> None:
    cfg = _project(tmp_path)
    assert main(["gen", "--config", str(cfg)]) == 0
    target = tmp_path / "gen/other/Node.py"
    target.write_text(target.read_text() + "\n# hand-edited drift\n")
    rc = main(["verify", "--codegen", "--config", str(cfg)])
    assert rc == 1
    err = capsys.readouterr().err
    assert "[other]" in err and "drifted" in err


def test_verify_codegen_target_scopes(tmp_path: Path) -> None:
    cfg = _project(tmp_path)
    assert main(["gen", "--config", str(cfg)]) == 0
    # Drift in `other`, but scope verify to `models` → clean.
    target = tmp_path / "gen/other/Node.py"
    target.write_text(target.read_text() + "\n# drift\n")
    assert main(["verify", "--codegen", "--config", str(cfg), "--target", "models"]) == 0
    assert main(["verify", "--codegen", "--config", str(cfg), "--target", "other"]) == 1


def test_verify_flag_path_still_works_with_config_present(tmp_path: Path) -> None:
    """Back-compat: legacy `verify <dir> --out` diff is unchanged when a config exists."""
    cfg = _project(tmp_path)
    meta = tmp_path / "metaobjects"
    out = tmp_path / "flagout"
    assert main(["gen", str(meta), "--out", str(out)]) == 0
    assert main(["verify", str(meta), "--out", str(out)]) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/python && uv run pytest tests/codegen/test_cli_config_verify.py -q`
Expected: FAIL — `verify` currently requires the positional `metadata_dir`; `--config`/`--target` are unknown.

- [ ] **Step 3: Add `_verify_one_target` + `_verify_codegen_config`**

Place just after `_verify_codegen` (~line 573):

```python
def _verify_one_target(
    config: ProjectConfig, target: TargetConfig, root: MetaData
) -> int:
    """Regenerate one target to a temp dir + diff against its committed ``outDir``.

    Mirrors :func:`_verify_codegen`'s diff, labeled per target. Returns 0 (in sync)
    or 1 (drift / bad generator name)."""
    gens: list[Generator] | None = None
    if target.generators is not None:
        gens, gen_errors = _resolve_generators(",".join(target.generators))
        if gen_errors:
            for m in gen_errors:
                print(f"error: target '{target.name}': {m}", file=sys.stderr)
            return 1

    out_dir = Path(config.out_dir_for(target))
    with tempfile.TemporaryDirectory() as tmp:
        _run_suite(root, tmp, gens, target.entities)
        expected = _relative_set(Path(tmp))
        committed = _relative_set(out_dir)

    changed = sorted(k for k in expected if k in committed and expected[k] != committed[k])
    missing = sorted(k for k in expected if k not in committed)
    extra = sorted(k for k in committed if k not in expected)

    if not changed and not missing and not extra:
        print(f"metaobjects verify [{target.name}]: in sync ({len(expected)} file(s)).")
        return 0

    print(
        f"error: [{target.name}] generated code is out of sync with metadata.",
        file=sys.stderr,
    )
    for k in changed:
        print(f"  drifted: {k}", file=sys.stderr)
    for k in missing:
        print(f"  missing: {k}", file=sys.stderr)
    for k in extra:
        print(f"  extra:   {k}", file=sys.stderr)
    print("regenerate (metaobjects gen) and commit the result.", file=sys.stderr)
    return 1


def _verify_codegen_config(args: argparse.Namespace) -> int:
    """``verify --codegen`` with no positional ``metadata_dir`` → config mode (#267).

    Load the config + metadata ONCE, then regen+diff each target (or ``--target``)
    against its committed ``outDir``, aggregating the exit code (non-zero if ANY
    target drifts). Strict-by-default (ADR-0023) unless ``--lax``.
    """
    config_path = _find_config(args)
    if config_path is None:
        print(
            "error: verify --codegen with no <metadata_dir> requires a "
            "metaobjects.config.yaml (or --config <path>).",
            file=sys.stderr,
        )
        return 2
    try:
        config = load_project_config(config_path)
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    targets, target_err = _select_targets(config, getattr(args, "target", None))
    if target_err:
        print(f"error: {target_err}", file=sys.stderr)
        return 1

    strict = not getattr(args, "lax", False)
    providers, providers_ok = _config_providers(config)
    if not providers_ok:
        return 1

    root, load_errors = _load_root(config.metadata_dir(), strict=strict, providers=providers)
    if root is None:
        print("error: failed to load metadata:", file=sys.stderr)
        for msg in load_errors:
            print(f"  {msg}", file=sys.stderr)
        if strict and any("ERR_UNKNOWN_ATTR" in m for m in load_errors):
            print(_strict_load_hint(), file=sys.stderr)
        return 1

    exit_code = 0
    for t in targets:
        exit_code = max(exit_code, _verify_one_target(config, t, root))
    return exit_code
```

- [ ] **Step 4: Branch `_verify_codegen` on config mode**

At the top of `_verify_codegen` (~line 519), before the `if args.out is None:` guard, add:

```python
    # #267: config mode ⇔ no positional <metadata_dir>. The legacy
    # <metadata_dir> + --out diff below is untouched.
    if args.metadata_dir is None:
        return _verify_codegen_config(args)
```

- [ ] **Step 5: Guard `_verify_templates` against a missing `metadata_dir`**

`--templates` / `--db` are not config-driven. At the top of `_verify_templates` (~line 610, before the `templates_root` check), add:

```python
    if args.metadata_dir is None:
        print(
            "error: verify --templates requires <metadata_dir> (it is not "
            "config-driven; the config's targets registry drives --codegen only).",
            file=sys.stderr,
        )
        return 2
```

- [ ] **Step 6: Make the `verify` positional optional + add `--config` / `--target`**

In `_build_parser`, change the `verify` positional (~line 905):

```python
    verify.add_argument("metadata_dir", help="directory of metadata JSON/YAML files")
```

to:

```python
    verify.add_argument(
        "metadata_dir",
        nargs="?",
        default=None,
        help=(
            "directory of metadata JSON/YAML files. Omit to use a "
            "metaobjects.config.yaml (--codegen config mode, #267)."
        ),
    )
```

and after the `verify.add_argument("--provider", ...)` block (~line 955) add:

```python
    verify.add_argument(
        "--config",
        default=None,
        help=(
            "path to a metaobjects.config.yaml. Config mode runs when no "
            "<metadata_dir> is given; default ./metaobjects.config.yaml in cwd. "
            "Drives --codegen per-target regen+diff."
        ),
    )
    verify.add_argument(
        "--target",
        default=None,
        help="verify only this named target from the config (default: every target)",
    )
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd server/python && uv run pytest tests/codegen/test_cli_config_verify.py -q`
Expected: PASS (all cases).

- [ ] **Step 8: Run the full CLI + verify suites (no regressions)**

Run: `cd server/python && uv run pytest tests/codegen/test_cli.py tests/codegen/test_cli_verify_subverbs.py tests/codegen/test_cli_verify_strict.py tests/codegen/test_cli_providers.py -q`
Expected: PASS (bare-verify default, subverbs, strict, providers all unchanged).

- [ ] **Step 9: Commit**

```bash
git add server/python/src/metaobjects/cli.py \
        server/python/tests/codegen/test_cli_config_verify.py
git commit -m "feat(#267): verify --codegen config mode — per-target regen+diff, aggregate exit"
```

---

## Task 4: Docs — close the KNOWN_GAPS note + document the config

**Files:**
- Modify: `server/python/src/metaobjects/codegen/KNOWN_GAPS.md`
- Modify: `docs/features/cli.md`

**Interfaces:**
- Consumes: the shipped behavior from Tasks 1–3.
- Produces: doc parity (no code).

- [ ] **Step 1: Update `KNOWN_GAPS.md`**

The "When it ships" note at the bottom of `KNOWN_GAPS.md` references the missing targets registry. Update it to record that the per-target output directory / targets registry now exists via `metaobjects.config.yaml` (#267), while noting the router→entity-model import wiring remains the separate deferred piece. Replace the final paragraph (lines ~50-53) with:

```markdown
**When it ships:** the Python codegen now has a per-target output-directory
targets registry via the declarative `metaobjects.config.yaml` (#267 — mirrors
the TS `targets` registry). The remaining deferred piece is the router→entity-model
import wiring itself (`from .<snake>_entity import <Entity>`), which still needs the
path-resolution/import-base machinery; the config's per-target `outDir` is the
prerequisite that is now in place.
```

- [ ] **Step 2: Document the config in `docs/features/cli.md`**

Find the Python CLI section in `docs/features/cli.md` (grep `metaobjects gen`) and add a short "Declarative config (`metaobjects.config.yaml`)" subsection: the schema (`metadata` / `providers` / `targets.<name>.{outDir, generators, entities}`), the no-arg `metaobjects gen` / `metaobjects verify --codegen` behavior, `--config` / `--target`, config-relative provider resolution (no `PYTHONPATH=`), and the back-compat rule (a positional `<metadata_dir>` + `--out` keeps the flag path). State the schema keys are identical to `metaobjects.config.ts` and point to `server/python/src/metaobjects/codegen/metaobjects-config.schema.json`. Keep it generic (public repo — no private names/paths).

- [ ] **Step 3: Verify docs render / no leaks**

Run: `git diff --staged -U0 -- docs/features/cli.md server/python/src/metaobjects/codegen/KNOWN_GAPS.md | grep -nE "/home/|/Users/" || echo clean`
Expected: `clean`.

- [ ] **Step 4: Commit**

```bash
git add server/python/src/metaobjects/codegen/KNOWN_GAPS.md docs/features/cli.md
git commit -m "docs(#267): document the Python declarative config; close the targets-registry KNOWN_GAP"
```

---

## Final verification (after all tasks)

- [ ] Full scoped Python suite: `cd server/python && uv run pytest -q` — all green.
- [ ] Whole-branch review (subagent-driven-development final stage): code-reviewer + code-simplifier over the branch diff; fix findings in place (no follow-up tickets).
- [ ] no-mistakes gate with a rich `--intent` (ensure `.serena/` + `.worktrees/` are in `.git/info/exclude`).
- [ ] PR `Closes #267`; Doug merges.

---

## Self-Review (author checklist — completed at plan-writing time)

**Spec coverage:**
- Problem (flags-only, stale CI lists, `PYTHONPATH=`) → Tasks 2/3 config mode + config-relative providers. ✅
- Decision (YAML not `.py`; TS-identical schema keys; JSON Schema) → Task 1 (`project_config.py` + `metaobjects-config.schema.json`). ✅
- Schema (`metadata`/`providers`/`targets.<name>.{outDir,generators,entities}`; `outDir` not `out`) → Task 1 dataclasses + validation + schema JSON. ✅
- Behavior: provider config-relative sys.path → Task 2 `_config_providers`. ✅ No-arg `gen` all targets + cross-target dup guard + `--target` → Task 2. ✅ No-arg `verify --codegen` per-target regen+diff aggregate + `--target` → Task 3. ✅ Config lookup `--config` else `./metaobjects.config.yaml` → Task 2/3 `_find_config`. ✅ Back-compat positional+`--out` byte-identical → Tasks 2/3 branch on `metadata_dir is None`, tested with a config present. ✅
- Non-goals (no `.py` config, no single cross-port file, no vocabulary/registry change, no coordinated release) → respected; no fixtures touched. ✅
- Testing section items → each has a test in Tasks 1–3 (loader units, no-arg gen/verify, dup guard, provider-without-PYTHONPATH, `--target` scoping, back-compat). ✅

**Placeholder scan:** No TBD/TODO; every code step has full content. ✅

**Type consistency:** `TargetConfig` / `ProjectConfig` field + method names (`out_dir`, `generators`, `entities`, `metadata_dir()`, `out_dir_for()`, `target()`) are used identically across Tasks 1–3; helper names (`_find_config`, `_config_providers`, `_select_targets`, `_run_gen_targets`, `_verify_one_target`, `_verify_codegen_config`, `_cmd_gen_config`) are consistent. `_resolve_generators` takes a comma-string (joined from the list). ✅
