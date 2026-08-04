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
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise ConfigError(f"{path}: cannot read config file: {exc}") from exc
    try:
        raw = yaml.safe_load(text)
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
