"""FR-023 Phase 2 — the upstream dependency check: ``metaobjects deps check`` and
``metaobjects verify --deps``.

For each declared dependency: resolve its ``path``, read and validate the publisher's
``metaobjects.pkg.json``, hash the artifact beside it, and compare with the lock. Mirrors the
TypeScript ``checkDependencies`` (``cli/src/lib/dependency-sync.ts``) and is gated by the
``expectCheck`` arm of ``fixtures/dependency-conformance/``.

The check is a pure function of the config, the lock and the publisher's directory. It writes
nothing and needs no loader: ``sync`` (Node ``meta deps sync``, the only writer of the lock and
the snapshot) is what repairs a drift this reports.

Only the ``path`` transport is resolved here. An ``npm`` / ``python`` dependency is resolved by
the Node toolchain (it needs the consumer's installed packages), so the Python check reports it
``unresolved`` and names ``meta deps check``: a check that cannot check must not pass.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from metaobjects.config.dependencies import (
    INTEGRITY_PREFIX,
    MANIFEST_FILE,
    read_lock,
    sha256_integrity,
    validate_manifest,
    verify_snapshot,
)
from metaobjects.errors import ErrorCode, ParseError

#: The one code every ``drifted`` or ``unresolved`` result is reported under.
ERR_DEPENDENCY_UPSTREAM_DRIFT = ErrorCode.ERR_DEPENDENCY_UPSTREAM_DRIFT

CheckStatus = Literal["current", "drifted", "unresolved"]


@dataclass(frozen=True)
class DependencyCheckResult:
    """One declared dependency's verdict. ``lock_*`` are ``None`` exactly when the lock has no
    entry for it; ``installed_*`` are ``None`` exactly when resolution itself failed; ``detail``
    is the reason, for ``unresolved`` only."""

    name: str
    status: CheckStatus
    lock_version: str | None
    lock_integrity: str | None
    installed_version: str | None
    installed_integrity: str | None
    detail: str | None


def hash8(integrity: str) -> str:
    """The first 8 hex digits of an ``sha256-<hex>`` integrity, the report's short form."""
    return integrity[len(INTEGRITY_PREFIX) : len(INTEGRITY_PREFIX) + 8]


class _Unresolved(Exception):
    """A dependency whose publisher directory could not be read, with the reason."""


def _resolve_dir(config_dir: Path, spec: dict[str, str]) -> Path:
    if "path" not in spec:
        transport = "npm" if "npm" in spec else "python"
        raise _Unresolved(
            f'the "{transport}" transport is resolved by the Node toolchain; '
            "run `meta deps check` to check this dependency"
        )
    target = (config_dir / spec["path"]).resolve()
    if not target.is_dir():
        raise _Unresolved(f'the "path" transport resolved to {target}, but no directory exists there')
    return target


def _read_manifest(directory: Path) -> tuple[dict[str, Any], bytes]:
    """``<dir>/metaobjects.pkg.json``, strict, plus the artifact bytes beside it, verified to
    hash to the manifest's own ``integrity`` (a publisher who bypassed ``sharedModelFile()`` is
    caught here)."""
    manifest_path = directory / MANIFEST_FILE
    try:
        raw = manifest_path.read_text(encoding="utf-8")
    except OSError:
        raise _Unresolved(f"no {MANIFEST_FILE} found at {manifest_path}") from None
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        raise _Unresolved(f"{manifest_path} is not valid JSON: {exc}") from None
    try:
        manifest = validate_manifest(parsed)
    except ParseError as exc:
        raise _Unresolved(f"{manifest_path} failed schema validation — {exc}") from None

    artifact_path = directory / manifest["artifact"]
    try:
        data = artifact_path.read_bytes()
    except OSError:
        raise _Unresolved(
            f'the manifest names artifact "{manifest["artifact"]}", but it is missing at {artifact_path}'
        ) from None
    actual = sha256_integrity(data)
    if actual != manifest["integrity"]:
        raise _Unresolved(
            f"{artifact_path} hashes to {actual}, but the manifest records {manifest['integrity']}"
        )
    return manifest, data


def check_dependencies(
    config_dir: Path,
    specs: list[dict[str, str]],
    lock: dict[str, Any] | None,
) -> list[DependencyCheckResult]:
    """Resolve each declared dependency and compare its artifact's TRUE hash (re-hashed from the
    bytes on disk, never the manifest's own field taken on faith) with the lock's. Read-only.
    One result per declared dependency, in name order.

    ``lock`` is the already-validated dict :func:`read_lock` returns, or ``None`` for no lock
    file, which makes every dependency ``unresolved`` ("nothing to compare against").
    """
    entries: dict[str, Any] = lock["dependencies"] if lock is not None else {}
    results: list[DependencyCheckResult] = []
    for spec in sorted(specs, key=lambda s: s["name"]):
        name = spec["name"]
        entry = entries.get(name)
        lock_version = entry["version"] if entry is not None else None
        lock_integrity = entry["integrity"] if entry is not None else None
        try:
            manifest, data = _read_manifest(_resolve_dir(config_dir, spec))
        except _Unresolved as exc:
            results.append(
                DependencyCheckResult(
                    name, "unresolved", lock_version, lock_integrity, None, None, str(exc)
                )
            )
            continue
        installed = sha256_integrity(data)
        if entry is None:
            results.append(
                DependencyCheckResult(
                    name,
                    "unresolved",
                    None,
                    None,
                    manifest["version"],
                    installed,
                    "declared, and resolves, but is not in the lock yet",
                )
            )
            continue
        results.append(
            DependencyCheckResult(
                name,
                "current" if installed == lock_integrity else "drifted",
                lock_version,
                lock_integrity,
                manifest["version"],
                installed,
                None,
            )
        )
    return results


def format_check_line(result: DependencyCheckResult) -> str:
    """One report line per dependency (the same shape as the TypeScript ``formatCheckLine``)."""
    lock_desc = (
        f"{result.lock_version or '(none)'} "
        f"({hash8(result.lock_integrity) if result.lock_integrity else 'n/a'})"
    )
    installed_desc = (
        f"{result.installed_version or '(none)'} "
        f"({hash8(result.installed_integrity) if result.installed_integrity else 'n/a'})"
    )
    if result.status == "current":
        return f"{result.name}: current — {lock_desc}"
    if result.status == "drifted":
        return (
            f"{result.name}: drifted — lock {lock_desc}, installed {installed_desc}; "
            "run meta deps sync and review the artifact diff"
        )
    return (
        f"{result.name}: unresolved — {result.detail or 'could not resolve the dependency'}; "
        "run meta deps sync once the dependency is reachable"
    )


def summary_line(command: str, failing: int, total: int) -> str:
    """The failure summary both commands print, naming the one code."""
    plural = "y" if total == 1 else "ies"
    return (
        f"{command}: {failing} of {total} dependenc{plural} drifted or unresolved "
        f"({ERR_DEPENDENCY_UPSTREAM_DRIFT.value})."
    )


def prove_locked_set_loads(config_dir: Path, specs: list[dict[str, str]]) -> str | None:
    """Matching hashes only prove the snapshot is the locked one, not that it still loads. Verify
    the snapshot against the lock (a stale one is ``ERR_DEPENDENCY_SNAPSHOT_STALE``) and load the
    locked artifacts together, so a collision between two dependencies or an artifact that does not
    load is reported. The project's own metadata is not loaded here (``gen`` / ``verify`` are the
    full check). Returns ``None`` when it loads, else the reason."""
    from metaobjects import MetaDataLoader
    from metaobjects.loader.sources import FileSource

    try:
        resolved = verify_snapshot(config_dir, specs, read_lock(config_dir))
    except ParseError as exc:
        return f"{exc.code}: {exc}"
    if not resolved:
        return None
    result = MetaDataLoader().load(
        [FileSource(Path(d.artifact_path), id=d.source_id) for d in resolved]
    )
    if result.errors:
        return "; ".join(f"{e.code}: {e.message}" for e in result.errors)
    return None
