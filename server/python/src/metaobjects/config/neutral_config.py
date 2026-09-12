from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path

from metaobjects.errors import ErrorCode, ParseError

#: The DEFAULT value of `sources` when the key is absent or empty — never a
#: requirement, and never assumed to exist by any other code path.
DEFAULT_METADATA_DIR = "metaobjects"

_METAOBJECTS_DIR = ".metaobjects"
_CONFIG_FILE = "config.json"

#: `/^[a-z0-9][a-z0-9._-]*$/` — mirrors the TS `DependencyName` regex in
#: `sdk/src/dependencies.ts` exactly (DESIGN §3.1).
_DEPENDENCY_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

#: The one transport key a dependency spec may carry.
_DEPENDENCY_TRANSPORT_KEYS = ("path", "npm", "python")


@dataclass(frozen=True)
class NeutralConfig:
    """The port-neutral subset of `.metaobjects/config.json`."""

    #: Raw source specs, each a single-key mapping (`path` / `resource` / `package`).
    sources: list[dict[str, str]]

    #: Declared metadata dependencies (FR-023) — each dict already validated:
    #: `name`, exactly one transport key (`path` / `npm` / `python`), optional
    #: `dir` only beside `npm`/`python`.
    dependencies: list[dict[str, str]]

    #: FR-023 §11.1 item 2 — the user's declared `scope.include` patterns, READ
    #: ONLY for the explicit-include rule (`explicitly_includes`): a dependency's
    #: package survives selection only when one of these patterns NAMES it
    #: literally. Unlike TypeScript, the Python CLI has never applied `scope` to
    #: its OWN objects (no caller of `matches_scope`/`compile_scope` exists in
    #: `server/python/src` before this) — `scope.exclude` is therefore not read
    #: at all, and adding that would be new behaviour, not parity (T18 ruling).
    #: Empty when `scope` / `scope.include` is absent.
    scope_include: list[str]

    #: FR-023 §11.1 item 2 — the user's declared `migrate.scope` patterns
    #: (include-only, same grammar as `scope.include`), or `None` when the key
    #: is absent. Mirrors TS `migrate.scope` for completeness — nothing in the
    #: Python CLI's own `gen`/`verify --codegen` path consumes it (schema is
    #: TS-owned, ADR-0015); it exists so `Collection.in_migrate_scope` can be
    #: built with full TS parity.
    migrate_scope: list[str] | None


def read_neutral_config(config_dir: Path) -> NeutralConfig | None:
    """Read the neutral subset from ``config_dir/.metaobjects/config.json``.

    Returns ``None`` when the file does not exist. A file that EXISTS but is
    malformed raises — swallowing it would make a typo'd config behave
    identically to no config at all, silently resolving a possibly-stale
    default directory with no diagnostic.
    """
    path = config_dir / _METAOBJECTS_DIR / _CONFIG_FILE
    if not path.is_file():
        return None

    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise ParseError(
            f"{path} exists but could not be read as JSON: {e}",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        ) from e

    if not isinstance(raw, dict):
        raise ParseError(
            f"{path} must contain a JSON object",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    version = raw.get("schema_version")
    # `isinstance(version, bool)` must be checked FIRST and separately: Python's
    # `bool` is a subclass of `int` and `True == 1`, so a bare `version != 1`
    # check accepts `schema_version: true` — a divergence from Java's
    # `isNumber()` and C#'s `ValueKind != Number`, both of which reject a JSON
    # boolean outright.
    if isinstance(version, bool) or not isinstance(version, (int, float)) or version != 1:
        raise ParseError(
            f"{path}: unsupported schema_version {version!r} (expected 1)",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    # `.get("sources", [])` only applies the [] default when the key is ABSENT —
    # a present `sources: null` returns None here, which correctly fails the
    # `isinstance(sources, list)` check below rather than silently reading as
    # "absent" and falling back to the default directory with no diagnostic.
    sources = raw.get("sources", [])
    if not isinstance(sources, list) or not all(
        isinstance(s, dict)
        and len(s) == 1
        # Every source-spec value (`path`/`resource`/`package`) must be a
        # non-empty (after stripping whitespace) string — a bare number/
        # boolean/null would otherwise reach `Path()` downstream and raise an
        # uncaught TypeError instead of this coded error, and an empty or
        # whitespace-only `path` would resolve to the config-holding directory
        # itself rather than failing loudly on the typo'd config.
        and all(isinstance(v, str) and v.strip() for v in s.values())
        for s in sources
    ):
        raise ParseError(
            f"{path}: 'sources' must be an array of single-key objects, each "
            "value a non-empty string",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    dependencies_raw = raw.get("dependencies", [])
    if not isinstance(dependencies_raw, list):
        raise ParseError(
            f"{path}: 'dependencies' must be an array",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    dependencies = [_validate_dependency_spec(d, path) for d in dependencies_raw]
    names = [d["name"] for d in dependencies]
    if len(set(names)) != len(names):
        raise ParseError(
            f"{path}: 'dependencies' names must be unique",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    scope_include = _read_scope_include(raw, path)
    migrate_scope = _read_migrate_scope(raw, path)

    # Unknown top-level keys are IGNORED by design — see the module docstring.
    return NeutralConfig(
        sources=[dict(s) for s in sources],
        dependencies=dependencies,
        scope_include=scope_include,
        migrate_scope=migrate_scope,
    )


def _string_array_or_raise(value: object, field: str, path: Path) -> list[str]:
    if not isinstance(value, list) or not all(isinstance(v, str) and v.strip() for v in value):
        raise ParseError(
            f"{path}: '{field}' must be an array of non-empty strings",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )
    return list(value)


def _read_scope_include(raw: dict[str, object], path: Path) -> list[str]:
    """FR-023 §11.1 item 2 — `scope.include`, read only for the explicit-include
    rule. `scope.exclude` and every other key inside `scope` are ignored, same
    tolerance the module docstring already grants unknown TOP-level keys: this
    port models the neutral subset it actually consumes, not the whole
    TypeScript-owned `scope` vocabulary.
    """
    scope = raw.get("scope")
    if scope is None:
        return []
    if not isinstance(scope, dict):
        raise ParseError(f"{path}: 'scope' must be an object", code=ErrorCode.ERR_COLLECTION_NOT_FOUND)
    include = scope.get("include")
    if include is None:
        return []
    return _string_array_or_raise(include, "scope.include", path)


def _read_migrate_scope(raw: dict[str, object], path: Path) -> list[str] | None:
    """FR-023 §11.1 item 2 — `migrate.scope`, read for completeness
    (`Collection.in_migrate_scope`). Every other key inside `migrate`
    (`dialect`, `outDir`, ...) is TypeScript-owned and ignored — see
    `test_unknown_top_level_keys_are_ignored`.
    """
    migrate = raw.get("migrate")
    if migrate is None:
        return None
    if not isinstance(migrate, dict):
        raise ParseError(f"{path}: 'migrate' must be an object", code=ErrorCode.ERR_COLLECTION_NOT_FOUND)
    scope = migrate.get("scope")
    if scope is None:
        return None
    return _string_array_or_raise(scope, "migrate.scope", path)


def _validate_dependency_spec(dep: object, path: Path) -> dict[str, str]:
    """Validate one entry of `dependencies` (DESIGN §3.1) and return it
    normalized. Mirrors the TS `DependencySpecSchema` union in
    `sdk/src/dependencies.ts` exactly: a `name`, exactly one transport key
    (`path` | `npm` | `python`), an optional `dir` that is legal only beside
    `npm`/`python`, and no other keys. `mode` is REMOVED (FR-023 §11.3 —
    superseded by explicit `scope.include`); any `mode` key is now an
    unknown-key error like any other unrecognized key.
    """

    def fail(reason: str) -> ParseError:
        return ParseError(
            f"{path}: invalid 'dependencies' entry ({reason})",
            code=ErrorCode.ERR_COLLECTION_NOT_FOUND,
        )

    if not isinstance(dep, dict):
        raise fail("must be an object")

    name = dep.get("name")
    if not isinstance(name, str) or not _DEPENDENCY_NAME_RE.match(name):
        raise fail("'name' must match ^[a-z0-9][a-z0-9._-]*$")

    transports = [k for k in _DEPENDENCY_TRANSPORT_KEYS if k in dep]
    if len(transports) != 1:
        raise fail("exactly one of 'path' / 'npm' / 'python' is required")
    transport = transports[0]

    transport_value = dep[transport]
    if not isinstance(transport_value, str) or not transport_value.strip():
        raise fail(f"'{transport}' must be a non-empty string")

    allowed_keys = {"name", transport}
    if transport in ("npm", "python"):
        allowed_keys.add("dir")
    extra_keys = set(dep.keys()) - allowed_keys
    if extra_keys:
        raise fail(f"unknown key(s): {sorted(extra_keys)}")

    result: dict[str, str] = {"name": name, transport: transport_value}

    if "dir" in dep:
        dir_value = dep["dir"]
        if not isinstance(dir_value, str) or not dir_value.strip():
            raise fail("'dir' must be a non-empty string")
        result["dir"] = dir_value

    return result
