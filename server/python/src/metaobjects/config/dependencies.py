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
from typing import Any, Callable, Sequence

from metaobjects.errors import ErrorCode, ParseError
from metaobjects.meta.meta_data import MetaData
from metaobjects.naming import package_of_resolution_key
from metaobjects.registry_manifest import METAMODEL_VERSION
from metaobjects.shared.base_types import TYPE_OBJECT

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


def _metamodel_major(version: str) -> str:
    """The MAJOR half of a `major.minor` metamodel version. The metadata
    contract is promised on the major alone (ADR-0035 Amendment 2)."""
    return version.split(".")[0]


def _stale(detail: str) -> ParseError:
    """Every stale-snapshot refusal, in one place so every one of them ends
    with the command that fixes it. Returns rather than raises (unlike the TS
    `never`-typed sibling) — Python has no control-flow narrowing on `raise
    fn()`, so the call site still writes `raise _stale(...)`."""
    return ParseError(f"{detail}; run `meta deps sync`", code=ErrorCode.ERR_DEPENDENCY_SNAPSHOT_STALE)


def verify_snapshot(
    config_dir: Path,
    specs: list[dict[str, Any]],
    lock: dict[str, Any] | None,
) -> list[ResolvedDependency]:
    """Verify a project's committed snapshot against its lock, and resolve the
    dependencies the collection will load FIRST (DESIGN §4.2 step 2-3). Mirrors
    the TS `verifySnapshot` (`sdk/src/dependencies.ts`) exactly.

    ``lock`` is the ALREADY-VALIDATED dict :func:`read_lock` / :func:`validate_lock`
    return (``dependencies`` a plain dict keyed by name), never raw JSON.

    Two failures are NOT staleness and get their own codes: a dependency published
    against a different metamodel MAJOR (``ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE``)
    and two dependencies exporting the same fully-qualified node
    (``ERR_DEPENDENCY_NODE_COLLISION``).

    Result order is dependency NAME order, never the config's declaration order —
    the artifacts lead the loaded file list, so declaration order must not decide
    what the loader sees first.

    A project with no dependencies and no lock resolves to ``[]`` without touching
    the filesystem — the byte-identical path.
    """
    declared = [d["name"] for d in specs]

    if lock is None:
        # No dependencies AND no lock is the untouched project, not a stale one.
        if not declared:
            return []
        raise _stale(
            f"{len(declared)} dependenc{'y is' if len(declared) == 1 else 'ies are'} declared "
            f"({', '.join(declared)}) but there is no {_METAOBJECTS_DIR}/{LOCK_FILE}"
        )

    entries: dict[str, Any] = lock["dependencies"]
    declared_names = set(declared)
    for name in entries:
        if name not in declared_names:
            raise _stale(
                f'{_METAOBJECTS_DIR}/{LOCK_FILE} locks dependency "{name}", which '
                f"{_METAOBJECTS_DIR}/config.json no longer declares"
            )

    resolved: list[ResolvedDependency] = []
    for name in sorted(declared_names):
        entry = entries.get(name)
        if entry is None:
            raise _stale(
                f'dependency "{name}" is declared but {_METAOBJECTS_DIR}/{LOCK_FILE} has no '
                "entry for it"
            )

        artifact_path = config_dir / _METAOBJECTS_DIR / DEPS_DIR / name / entry["artifact"]
        try:
            data = artifact_path.read_bytes()
        except OSError:
            raise _stale(
                f'the committed snapshot for "{name}" is missing (expected {artifact_path})'
            ) from None

        actual = sha256_integrity(data)
        if actual != entry["integrity"]:
            raise _stale(
                f'the committed snapshot for "{name}" does not match the lock — {artifact_path} '
                f'hashes to {actual}, the lock records {entry["integrity"]}'
            )

        if _metamodel_major(entry["metamodelVersion"]) != _metamodel_major(METAMODEL_VERSION):
            raise ParseError(
                f'dependency "{name}" was published against metamodel {entry["metamodelVersion"]}; '
                f"this toolchain speaks {METAMODEL_VERSION}. A different metamodel MAJOR is a "
                f'different metadata contract — upgrade the toolchain, or use a release of "{name}" '
                "built against it.",
                code=ErrorCode.ERR_DEPENDENCY_METAMODEL_INCOMPATIBLE,
            )

        resolved.append(
            ResolvedDependency(
                name=name,
                version=entry["version"],
                packages=tuple(entry["packages"]),
                nodes=tuple(entry["nodes"]),
                artifact_path=str(artifact_path),
                source_id=dependency_source_id(name, entry["artifact"]),
            )
        )

    # Collision is checked across the WHOLE resolved set, so the error names the
    # two dependencies in name order however the config declared them.
    owner: dict[str, str] = {}
    for dep in resolved:
        for node in dep.nodes:
            prior = owner.get(node)
            if prior is not None:
                raise ParseError(
                    f'dependencies "{prior}" and "{dep.name}" both export "{node}" — one '
                    "fully-qualified node cannot come from two places, and whichever loaded "
                    "second would silently win",
                    code=ErrorCode.ERR_DEPENDENCY_NODE_COLLISION,
                )
            owner[node] = dep.name

    return resolved


def explicitly_includes(patterns: Sequence[str] | None, pkg: str) -> bool:
    """Does some pattern in `patterns` name `pkg` LITERALLY (DESIGN §11.1 item 2)?

    Drop the pattern's final segment — which names the node — and what remains
    must be wildcard-free and equal to `pkg`. So `acme::common::**` and
    `acme::common::Address` both name `acme::common`; `acme::**` and `**` reach
    its nodes but name nothing, and an absent or empty list names nothing.

    Matching is therefore NOT `matches_scope` — a pattern that MATCHES a
    package's nodes is a weaker statement than one that NAMES the package.
    Mirrors the TS `explicitlyIncludes` (`sdk/src/dependencies.ts`) exactly.
    """
    if not patterns or pkg == "":
        return False
    for pattern in patterns:
        named = package_of_resolution_key(pattern)
        if named and "*" not in named and named == pkg:
            return True
    return False


def imported_from(pkg: str, dependencies: Sequence[ResolvedDependency]) -> str | None:
    """The name of the dependency that owns package `pkg`, or `None` when no
    resolved dependency exports it. Used by the CLI's `meta gen <Name>`-style
    refusal message (FR-023 §11.1 item 2) to name the offending dependency."""
    for dep in dependencies:
        if pkg in dep.packages:
            return dep.name
    return None


def refuse_unowned_packages(
    root: MetaData,
    imported_packages: frozenset[str] | None,
    imported_nodes: frozenset[str] | None,
) -> None:
    """FR-023 §11.5 — a consumer may not declare a NEW top-level node into a
    package one of its dependencies owns.

    This is what keeps the package-keyed exclusion rule from failing silently.
    Imported-ness is decided by PACKAGE, so such a node would be excluded from
    this project's own codegen, migrate and ledger — producing no output and no
    error. An overlay of the dependency's own node is untouched: its resolution
    key is in `imported_nodes`, because the node it merged into came from the
    artifact. Mirrors the TS `refuseUnownedPackages` (`sdk/src/memory.ts`) —
    called AFTER the loader's own errors, never before (an unflagged overlay
    whose target the upstream removed fails first, with its own coded error).

    No-op when nothing is imported, which is every project that declares no
    dependencies.
    """
    if not imported_packages:
        return
    nodes = imported_nodes or frozenset()

    # ADR-0039 SANCTIONED own-accessor case: a root-level scan. `MetaRoot` has
    # no super, so own and effective children are the same set here, and the
    # question asked is precisely "what did this tree declare at the top
    # level", which is the own layer by definition.
    for node in root.own_children():
        if node.type != TYPE_OBJECT:
            continue
        key = node.resolution_key()
        pkg = package_of_resolution_key(key)
        if pkg not in imported_packages or key in nodes:
            continue
        raise ParseError(
            f'"{key}" is declared here, but the package "{pkg}" belongs to a metadata '
            f'dependency this project imports, and "{key}" is not one of the nodes that '
            "dependency exports. Declare it in a package this project owns and 'extends' "
            "the dependency's node if it needs its shape; if it was meant to AMEND the "
            "dependency's node, give it that node's name and 'overlay: true'; if this "
            f'project really does own "{pkg}", name it in \'scope.include\' and stop '
            "importing it.",
            code=ErrorCode.ERR_DEPENDENCY_PACKAGE_NOT_OWNED,
        )


@dataclass(frozen=True)
class Collection:
    """Everything the FR-023-aware source ladder resolved for one project:
    its own metadata files, its dependencies' snapshot artifacts (leading the
    file list — see `files`), and the predicates every action surface reads to
    decide whether an imported object should be excluded (DESIGN §11.1 item 2).
    Mirrors the TS `Collection` interface (`sdk/src/collection.ts`), the
    Python-relevant subset.
    """

    #: Canonically-ordered absolute file paths: dependency artifacts (in
    #: dependency-NAME order) followed by this project's own files, in
    #: `resolve_sources`'s canonical (content) order. Identical to `own_files`
    #: when nothing is imported.
    files: tuple[Path, ...]

    #: `files` minus the dependency artifacts — this project's own metadata.
    own_files: tuple[Path, ...]

    #: The `FileSource` id each dependency artifact loads under
    #: (`dep:<name>/<artifact>`), keyed by its path in `files`. Own files are
    #: absent from this map and keep the default `basename(path)`.
    file_ids: dict[Path, str]

    #: The resolved dependencies, in dependency-NAME order. Empty for a
    #: project that declares none.
    dependencies: tuple[ResolvedDependency, ...]

    #: THE exclusion key (DESIGN §11.5): the union of every dependency's
    #: `packages`. A `frozenset`, not a sorted sequence — nothing here reads it
    #: in order.
    imported_packages: frozenset[str]

    #: The union of every dependency's `nodes` — read only by
    #: `refuse_unowned_packages`, to tell an overlay of an imported node from a
    #: genuinely new local declaration in the dependency's package. NOT the
    #: exclusion key.
    imported_nodes: frozenset[str]

    #: The user's declared `scope.include` patterns, for `in_scope`'s
    #: explicit-include rule.
    scope_include: tuple[str, ...]

    #: `migrate.scope`-governed predicate, or `None` when the project declares
    #: no `migrate.scope` AND resolves no dependencies (mirrors TS's
    #: `inMigrateScope`; nothing in the Python CLI consumes this today — schema
    #: is TS-owned, ADR-0015).
    in_migrate_scope: Callable[[str], bool] | None

    def imported(self, fqn: str) -> bool:
        """Is `fqn` in a package one of this project's dependencies owns?"""
        return package_of_resolution_key(fqn) in self.imported_packages

    def in_scope(self, fqn: str) -> bool:
        """Output filter for codegen (`run_gen`'s `select`) and `verify --codegen`.

        `(not imported(fqn)) or explicitly_includes(scope_include, packageOf(fqn))`
        — UNLIKE TypeScript this does NOT also apply `matches_scope` to the
        project's OWN objects: the Python CLI has never applied `scope` to its
        own generated output (T18 ruling, 2026-09-11) — only the import-
        exclusion rule is new behaviour here.
        """
        pkg = package_of_resolution_key(fqn)
        if pkg not in self.imported_packages:
            return True
        return explicitly_includes(self.scope_include, pkg)
