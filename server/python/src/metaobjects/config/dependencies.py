"""FR-023 — metadata dependencies: constants shared by the `dependencies` key
of `.metaobjects/config.json` (DESIGN §3.1), plus the manifest/lock
validation and integrity hashing every later task (the collection resolver)
builds on. Mirrors `server/typescript/packages/sdk/src/dependencies.ts` —
hand-validated dicts here rather than a schema library, same rules; resolving
a declared dependency to bytes on disk lands in a later task.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from metaobjects.errors import ErrorCode, ParseError

#: Directory (under `.metaobjects/`) holding the synced snapshot artifacts,
#: one subdirectory per dependency name: `.metaobjects/deps/<name>/`.
DEPS_DIR = "deps"

#: `meta deps sync`'s output — the only writer (DESIGN §3.3).
LOCK_FILE = "deps.lock.json"

#: The publisher-generated manifest sitting beside a dependency's artifact
#: (DESIGN §3.2).
MANIFEST_FILE = "metaobjects.pkg.json"

#: Suffix of a dependency's canonical-JSON artifact file, e.g.
#: `acme-common.metaobjects.json` (DESIGN §3.5).
ARTIFACT_SUFFIX = ".metaobjects.json"

#: Prefix of a dependency artifact's source id: `dep:<name>/<artifact>`
#: (DESIGN §2.3, "Source ids").
DEPENDENCY_SOURCE_ID_PREFIX = "dep:"

#: Prefix of the `integrity` field's value: `"sha256-" + lowercase hex sha256
#: of the artifact bytes` (DESIGN §3, "Hash format").
INTEGRITY_PREFIX = "sha256-"

#: Directory (relative to a project root) holding `.metaobjects/config.json`,
#: the synced snapshot and the lock — a private, module-local convention
#: mirroring `neutral_config._METAOBJECTS_DIR`. Not a named constant in the
#: cross-port list (DEPS_DIR/LOCK_FILE/etc. above): those are basenames
#: shared with TypeScript; this is Python's own path-join detail, same as
#: TypeScript's `DEFAULT_METAOBJECTS_DIR` (`sdk/src/metadata-files.ts`).
_METAOBJECTS_DIR = ".metaobjects"

#: Mirrors the TS `DependencyName` regex in `sdk/src/dependencies.ts` exactly
#: (DESIGN §3.1) — also the shape of a manifest's `name` and a lock's
#: dependency keys.
_DEPENDENCY_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

#: `major.minor`, no patch — the toolchain's `METAMODEL_VERSION` at
#: generation time (DESIGN §3.2).
_METAMODEL_VERSION_RE = re.compile(r"^\d+\.\d+$")

#: `sha256-` + 64 lowercase hex digits (DESIGN §3, "Hash format").
_INTEGRITY_RE = re.compile(r"^sha256-[0-9a-f]{64}$")

#: Allowed top-level keys of `metaobjects.pkg.json` (DESIGN §3.2). No `mode`
#: (FR-023 §11.3 — removed by Task 6, not reintroduced).
_MANIFEST_KEYS = {
    "schema_version",
    "name",
    "version",
    "metamodelVersion",
    "artifact",
    "integrity",
    "packages",
    "nodes",
}

#: Allowed top-level keys of `.metaobjects/deps.lock.json` (DESIGN §3.3).
_LOCK_KEYS = {"schema_version", "dependencies"}

#: Allowed keys of one `deps.lock.json` `dependencies` entry — the manifest
#: fields minus `schema_version`/`name` (both implicit) plus `resolvedFrom`.
#: No `mode`.
_LOCK_ENTRY_KEYS = {
    "version",
    "metamodelVersion",
    "artifact",
    "integrity",
    "packages",
    "nodes",
    "resolvedFrom",
}

#: The one transport key a lock entry's `resolvedFrom` carries.
_RESOLVED_FROM_TRANSPORT_KEYS = ("path", "npm", "python")


def _is_sorted(values: list[str]) -> bool:
    """`True` iff `values` is already in strict ascending order."""
    return all(values[i] < values[i + 1] for i in range(len(values) - 1))


def _validate_sorted_string_array(
    obj: dict[str, Any], field: str, code: ErrorCode, context: str
) -> list[str]:
    value = obj.get(field)
    if not isinstance(value, list) or not all(isinstance(v, str) and v for v in value):
        raise ParseError(
            f"{context}: '{field}' must be an array of non-empty strings", code=code
        )
    if not _is_sorted(value):
        raise ParseError(f"{context}: '{field}' must be sorted", code=code)
    return list(value)


def _validate_common_fields(obj: dict[str, Any], code: ErrorCode, context: str) -> dict[str, Any]:
    """Validate the fields a manifest and a lock entry share: `version`,
    `metamodelVersion`, `artifact`, `integrity`, `packages`, `nodes`. Same
    shape in both callers — only the failure `code` and diagnostic `context`
    differ (manifest vs. one lock entry)."""
    version = obj.get("version")
    if not isinstance(version, str) or not version:
        raise ParseError(f"{context}: 'version' must be a non-empty string", code=code)

    metamodel_version = obj.get("metamodelVersion")
    if not isinstance(metamodel_version, str) or not _METAMODEL_VERSION_RE.match(
        metamodel_version
    ):
        raise ParseError(f"{context}: 'metamodelVersion' must match ^\\d+\\.\\d+$", code=code)

    artifact = obj.get("artifact")
    if not isinstance(artifact, str) or not artifact.endswith(ARTIFACT_SUFFIX):
        raise ParseError(f"{context}: 'artifact' must end with {ARTIFACT_SUFFIX!r}", code=code)

    integrity = obj.get("integrity")
    if not isinstance(integrity, str) or not _INTEGRITY_RE.match(integrity):
        raise ParseError(
            f"{context}: 'integrity' must match ^sha256-[0-9a-f]{{64}}$", code=code
        )

    packages = _validate_sorted_string_array(obj, "packages", code, context)
    nodes = _validate_sorted_string_array(obj, "nodes", code, context)

    return {
        "version": version,
        "metamodelVersion": metamodel_version,
        "artifact": artifact,
        "integrity": integrity,
        "packages": packages,
        "nodes": nodes,
    }


def validate_manifest(obj: object) -> dict[str, Any]:
    """Validate a parsed `metaobjects.pkg.json` object (DESIGN §3.2).

    Raises `ParseError(code=ERR_DEPENDENCY_MANIFEST_INVALID)` on any shape
    violation — an unknown key (in particular a resurrected `mode`), an
    unsorted `packages`/`nodes`, or a malformed field. Returns the manifest
    normalized (the same fields, a plain dict).
    """
    code = ErrorCode.ERR_DEPENDENCY_MANIFEST_INVALID
    context = MANIFEST_FILE
    if not isinstance(obj, dict):
        raise ParseError(f"{context}: must be an object", code=code)

    extra_keys = set(obj.keys()) - _MANIFEST_KEYS
    if extra_keys:
        raise ParseError(f"{context}: unknown key(s): {sorted(extra_keys)}", code=code)

    schema_version = obj.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        raise ParseError(f"{context}: 'schema_version' must be 1", code=code)

    name = obj.get("name")
    if not isinstance(name, str) or not _DEPENDENCY_NAME_RE.match(name):
        raise ParseError(f"{context}: 'name' must match ^[a-z0-9][a-z0-9._-]*$", code=code)

    common = _validate_common_fields(obj, code, context)
    return {"schema_version": 1, "name": name, **common}


def _validate_resolved_from(obj: object, code: ErrorCode, context: str) -> dict[str, str]:
    """Validate a lock entry's `resolvedFrom` — exactly one of `path` / `npm`
    / `python`, `dir` legal only beside `npm`/`python`. Mirrors
    `neutral_config._validate_dependency_spec`'s transport check, minus
    `name` (a lock entry is already keyed by name)."""
    if not isinstance(obj, dict):
        raise ParseError(f"{context}: 'resolvedFrom' must be an object", code=code)

    transports = [k for k in _RESOLVED_FROM_TRANSPORT_KEYS if k in obj]
    if len(transports) != 1:
        raise ParseError(
            f"{context}: 'resolvedFrom' must have exactly one of 'path' / 'npm' / 'python'",
            code=code,
        )
    transport = transports[0]

    transport_value = obj[transport]
    if not isinstance(transport_value, str) or not transport_value.strip():
        raise ParseError(
            f"{context}: 'resolvedFrom.{transport}' must be a non-empty string", code=code
        )

    allowed_keys = {transport}
    if transport in ("npm", "python"):
        allowed_keys.add("dir")
    extra_keys = set(obj.keys()) - allowed_keys
    if extra_keys:
        raise ParseError(
            f"{context}: 'resolvedFrom' unknown key(s): {sorted(extra_keys)}", code=code
        )

    result: dict[str, str] = {transport: transport_value}
    if "dir" in obj:
        dir_value = obj["dir"]
        if not isinstance(dir_value, str) or not dir_value.strip():
            raise ParseError(
                f"{context}: 'resolvedFrom.dir' must be a non-empty string", code=code
            )
        result["dir"] = dir_value
    return result


def validate_lock(obj: object) -> dict[str, Any]:
    """Validate a parsed `.metaobjects/deps.lock.json` object (DESIGN §3.3).

    Raises `ParseError(code=ERR_DEPENDENCY_SNAPSHOT_STALE)` on any shape
    violation — unsorted dependency keys, an entry with an unknown key
    (`mode` included), two `resolvedFrom` transports, or a malformed field.
    Returns the lock normalized: `dependencies` a plain dict, each entry's
    fields as `_validate_common_fields` + `resolvedFrom` returns them.
    """
    code = ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE
    context = LOCK_FILE
    if not isinstance(obj, dict):
        raise ParseError(f"{context}: must be an object", code=code)

    extra_keys = set(obj.keys()) - _LOCK_KEYS
    if extra_keys:
        raise ParseError(f"{context}: unknown key(s): {sorted(extra_keys)}", code=code)

    schema_version = obj.get("schema_version")
    if isinstance(schema_version, bool) or schema_version != 1:
        raise ParseError(f"{context}: 'schema_version' must be 1", code=code)

    dependencies = obj.get("dependencies")
    if not isinstance(dependencies, dict):
        raise ParseError(f"{context}: 'dependencies' must be an object", code=code)

    names = list(dependencies.keys())
    if not all(isinstance(n, str) for n in names):
        raise ParseError(f"{context}: 'dependencies' keys must be strings", code=code)
    if not _is_sorted(names):
        raise ParseError(f"{context}: dependency keys must be sorted", code=code)

    validated: dict[str, Any] = {}
    for name, entry in dependencies.items():
        entry_context = f"{context} ({name})"
        if not isinstance(entry, dict):
            raise ParseError(f"{entry_context}: must be an object", code=code)
        entry_extra = set(entry.keys()) - _LOCK_ENTRY_KEYS
        if entry_extra:
            raise ParseError(
                f"{entry_context}: unknown key(s): {sorted(entry_extra)}", code=code
            )
        common = _validate_common_fields(entry, code, entry_context)
        resolved_from = _validate_resolved_from(entry.get("resolvedFrom"), code, entry_context)
        validated[name] = {**common, "resolvedFrom": resolved_from}

    return {"schema_version": 1, "dependencies": validated}


def sha256_integrity(data: bytes) -> str:
    """`"sha256-" + lowercase hex sha256 of `data`` (DESIGN §3, "Hash format")."""
    return f"{INTEGRITY_PREFIX}{hashlib.sha256(data).hexdigest()}"


def dependency_source_id(name: str, artifact: str) -> str:
    """`dep:<name>/<artifact>` — a dependency artifact's source id (DESIGN
    §2.3, "Source ids")."""
    return f"{DEPENDENCY_SOURCE_ID_PREFIX}{name}/{artifact}"


def read_lock(config_dir: Path) -> dict[str, Any] | None:
    """Read `.metaobjects/deps.lock.json` under `config_dir`, if present.

    Returns `None` when the file does not exist — a project declaring no
    dependencies has no lock file, and that is not an error. A present but
    malformed file (bad JSON, or a shape `validate_lock` rejects) raises.
    """
    path = config_dir / _METAOBJECTS_DIR / LOCK_FILE
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise ParseError(
            f"{path} exists but could not be read as JSON: {e}",
            code=ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE,
        ) from e
    return validate_lock(raw)


@dataclass(frozen=True)
class ResolvedDependency:
    """A resolved dependency, ready for the collection resolver (a later
    task) to fold its artifact into the loaded tree. Same fields as the TS
    `ResolvedDependency` type in `sdk/src/dependencies.ts`, Pythonic case."""

    name: str
    version: str
    packages: tuple[str, ...]
    nodes: tuple[str, ...]
    artifact_path: str
    source_id: str
