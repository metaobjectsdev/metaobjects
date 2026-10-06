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

import re
from dataclasses import dataclass
from pathlib import Path

import yaml  # type: ignore[import-untyped]  # PyYAML ships no type stubs

#: Config filename looked up in the cwd when ``--config`` is not given.
CONFIG_FILENAME = "metaobjects.config.yaml"

#: Default metadata directory (relative to the config file) when ``metadata:`` is omitted.
DEFAULT_METADATA_DIR = "metaobjects"

#: Every key this loader reads at the top level, and the ONLY ones it accepts.
#: ``metaobjects-config.schema.json`` declares ``additionalProperties: false``, so the
#: shipped schema has always said an unknown key is invalid; naming the set here is what
#: lets the loader — the thing that actually runs — say the same. Kept in step with the
#: schema by ``test_schema_and_loader_accept_EXACTLY_the_same_keys``.
TOP_LEVEL_KEYS: tuple[str, ...] = ("metadata", "providers", "libraries", "targets", "requirementTests")

#: Every key a ``targets.<name>`` mapping may carry. Same contract as above.
TARGET_KEYS: tuple[str, ...] = ("outDir", "generators", "entities")


#: Every key the ``requirementTests`` block may carry (the ``requirement-tests`` generator's
#: options). Same contract as above.
REQUIREMENT_TESTS_KEYS: tuple[str, ...] = (
    "witnessModule",
    "grain",
    "renderer",
    "filter",
    "warnUncovered",
)

#: The grains the ``requirementTests.grain`` key accepts. Spelled out here, in the loader
#: that validates it, rather than imported from the generator, so this module keeps loading
#: a config without importing the codegen engine; ``test_schema_and_loader_accept_EXACTLY_the_same_keys``
#: and the generator's own refusal keep the two in step.
REQUIREMENT_TEST_GRAIN_VALUES: tuple[str, ...] = ("concern", "member")

#: The module the witnesses are looked up in when the project names none. The ONE spelling:
#: the generator, the build-context options and this loader all take it from here, and a test
#: ties the schema's ``default`` to it.
DEFAULT_REQUIREMENT_WITNESS_MODULE = "tests.requirement_witnesses"

#: A dotted module name: what ``requirementTests.witnessModule`` must be, and what the generated
#: file interpolates into a string literal and imports. The schema's ``pattern`` is this one.
DOTTED_MODULE_PATTERN = r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$"

#: The ``module:symbol`` form of the ``renderer`` and ``filter`` keys: two non-empty halves with
#: no whitespace in either (a stray newline would otherwise validate and fail later as a
#: missing attribute). The schema's ``pattern`` for those two keys is this one.
MODULE_SYMBOL_PATTERN = r"^[^:\s]+:[^:\s]+$"


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
class RequirementTestsConfig:
    """The ``requirementTests`` block: options of the ``requirement-tests`` generator.

    ``renderer`` and ``filter`` are ``module:symbol`` strings, resolved relative to the
    config directory the way ``providers`` are (the CLI imports them; this loader never does).
    """

    witness_module: str = DEFAULT_REQUIREMENT_WITNESS_MODULE
    grain: str = "concern"
    renderer: str | None = None
    filter: str | None = None
    warn_uncovered: bool = True


@dataclass(frozen=True)
class ProjectConfig:
    #: Directory containing the config file — the base for resolving ``metadata``,
    #: ``providers`` (sys.path), and each target's ``outDir``.
    config_dir: Path
    #: Metadata directory (relative to ``config_dir`` or absolute).
    metadata: str
    #: Consumer provider refs (``module:symbol``), resolved config-relative.
    providers: list[str]
    #: MetaObjects-shipped library packages to load alongside ``metadata``
    #: (e.g. ``["ai"]`` for ``metaobjects::ai::LlmCallBase``). Without this the
    #: CLI cannot load the metadata that shipped generators like ``trace-helper``
    #: exist to consume, and an adopter's ``extends`` fails ERR_UNRESOLVED_SUPER.
    libraries: list[str]
    #: Ordered run-specs (YAML map insertion order preserved).
    targets: list[TargetConfig]
    #: Options of the ``requirement-tests`` generator; ``None`` => its defaults.
    requirement_tests: RequirementTestsConfig | None = None

    def metadata_dir(self) -> str:
        """The metadata dir resolved against ``config_dir`` (absolute path string)."""
        return _resolve_under(self.config_dir, self.metadata)

    def target(self, name: str) -> TargetConfig | None:
        return next((t for t in self.targets if t.name == name), None)

    def out_dir_for(self, target: TargetConfig) -> str:
        """``target.out_dir`` resolved against ``config_dir`` (absolute path string)."""
        return _resolve_under(self.config_dir, target.out_dir)


def _reject_unknown_keys(
    mapping: dict[object, object], accepted: tuple[str, ...], ctx: str
) -> None:
    """Refuse a key this loader does not read.

    Silently dropping one is the failure this exists to prevent: a config key that looks
    honoured and is not lets an author believe they have configured something, and the
    tool reports success for work it never did. It is the same call the ``libraries``
    check below already makes for an unknown package name — *"a name typed into a config
    file is a mistake worth failing on"* — applied to the key as well as the value.

    The message names the accepted set, because the fix for a typo is the right spelling.
    """
    unknown = sorted(str(k) for k in mapping if str(k) not in accepted)
    if unknown:
        raise ConfigError(
            f"{ctx}: unknown key(s) {unknown}; accepted: {list(accepted)}."
        )


def _resolve_under(base: Path, p: str) -> str:
    q = Path(p)
    return str(q if q.is_absolute() else (base / q).resolve())


def _require_str_list(value: object, ctx: str) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(x, str) for x in value):
        raise ConfigError(f"{ctx} must be a list of strings.")
    return list(value)


def _parse_requirement_tests(raw: object, ctx: str) -> RequirementTestsConfig:
    if not isinstance(raw, dict):
        raise ConfigError(f"{ctx} must be a mapping.")
    _reject_unknown_keys(raw, REQUIREMENT_TESTS_KEYS, ctx)
    defaults = RequirementTestsConfig()

    def string(key: str, default: str | None) -> str | None:
        if key not in raw:
            return default
        value = raw[key]
        if not isinstance(value, str) or not value:
            raise ConfigError(f"{ctx}: '{key}' must be a non-empty string.")
        return value

    def symbol(key: str) -> str | None:
        value = string(key, None)
        if value is not None and not re.fullmatch(MODULE_SYMBOL_PATTERN, value):
            raise ConfigError(
                f"{ctx}: '{key}' must be in 'module:symbol' form (e.g. codegen.requirement_{key}:{key})."
            )
        return value

    grain = string("grain", defaults.grain)
    if grain not in REQUIREMENT_TEST_GRAIN_VALUES:
        raise ConfigError(
            f"{ctx}: 'grain' must be one of {list(REQUIREMENT_TEST_GRAIN_VALUES)}, got {grain!r}."
        )
    warn = raw.get("warnUncovered", defaults.warn_uncovered)
    if not isinstance(warn, bool):
        raise ConfigError(f"{ctx}: 'warnUncovered' must be a boolean.")
    witness = string("witnessModule", defaults.witness_module)
    assert witness is not None and grain is not None  # the defaults are never None
    if not re.fullmatch(DOTTED_MODULE_PATTERN, witness):
        raise ConfigError(
            f"{ctx}: 'witnessModule' must be a dotted module name such as "
            f"{DEFAULT_REQUIREMENT_WITNESS_MODULE!r}, got {witness!r}."
        )
    return RequirementTestsConfig(
        witness_module=witness,
        grain=grain,
        renderer=symbol("renderer"),
        filter=symbol("filter"),
        warn_uncovered=warn,
    )


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
    _reject_unknown_keys(raw, TOP_LEVEL_KEYS, str(path))

    metadata = raw.get("metadata", DEFAULT_METADATA_DIR)
    if not isinstance(metadata, str):
        raise ConfigError(f"{path}: 'metadata' must be a string (a directory path).")

    providers = _require_str_list(raw.get("providers", []), f"{path}: 'providers'")
    libraries = _require_str_list(raw.get("libraries", []), f"{path}: 'libraries'")
    if libraries:
        # Validated HERE and not in library_sources(): the programmatic API skips an
        # unknown package on purpose (cross-port parity with TS), but a name typed
        # into a config file is a mistake worth failing on — silently skipping it
        # resurfaces later as ERR_UNRESOLVED_SUPER pointing at the adopter's own
        # metadata, which is the wrong place to go looking.
        from metaobjects.library import known_packages

        available = known_packages()
        unknown = [name for name in libraries if name not in available]
        if unknown:
            raise ConfigError(
                f"{path}: 'libraries' has unknown package(s) {unknown}; "
                f"available: {available}"
            )

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
        _reject_unknown_keys(spec, TARGET_KEYS, ctx)
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

    requirement_tests = (
        _parse_requirement_tests(raw["requirementTests"], f"{path}: 'requirementTests'")
        if "requirementTests" in raw
        else None
    )

    return ProjectConfig(
        config_dir=path.parent.resolve(),
        metadata=metadata,
        providers=providers,
        libraries=libraries,
        targets=targets,
        requirement_tests=requirement_tests,
    )
