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

    # Unknown top-level keys are IGNORED by design — see the module docstring.
    return NeutralConfig(sources=[dict(s) for s in sources], dependencies=dependencies)


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
