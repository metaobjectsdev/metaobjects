"""Scaffold planning + sidecar manifest for the agent-context writer.

Port of ``server/typescript/packages/sdk/src/agent-context/scaffold.ts``. Pure:
all filesystem access is via a ``read_current`` callback so the planning logic is
testable without touching disk.

A file is safe to overwrite iff it is absent, or its on-disk sha256 still equals
the hash the prior manifest recorded (the user hasn't hand-edited it). A
hand-edited file is preserved — the fresh contents go to ``<path>.new`` instead.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version as _pkg_version

from .assemble import AssembledFile
from .types import Stack

#: Consumer-relative path of the sidecar manifest that tracks scaffolded files.
AGENT_CONTEXT_MANIFEST_PATH = ".metaobjects/.agent-context.json"


def installed_metaobjects_version() -> str:
    """The installed ``metaobjects`` distribution version, or ``"0.0.0"`` if absent.

    Resolved idiomatically via :func:`importlib.metadata.version`; a
    ``PackageNotFoundError`` (e.g. running straight from a source checkout that
    was never installed) falls back to ``"0.0.0"`` — mirroring the TS reference's
    fallback so the stamp/nudge never crashes.
    """
    try:
        return _pkg_version("metaobjects")
    except PackageNotFoundError:
        return "0.0.0"


@dataclass
class Manifest:
    """Tracks what the assembler last wrote, so re-runs can detect hand-edits."""

    version: int
    servers: list[str]
    clients: list[str]
    #: consumer-relative path → sha256 of the contents as last scaffolded.
    files: dict[str, str]
    #: The MetaObjects version that last scaffolded this context. Drives the
    #: staleness nudge (an upgrade can leave the copied-in skills/docs stale).
    #: Optional for back-compat with manifests written before version tracking.
    #: Serialized as ``generatedBy`` — the SAME key as the TS reference, so a
    #: polyglot repo can cross-read the manifest regardless of which port wrote it.
    generated_by: str | None = None

    def to_json(self) -> dict[str, object]:
        out: dict[str, object] = {"version": self.version}
        if self.generated_by is not None:
            out["generatedBy"] = self.generated_by
        out["servers"] = list(self.servers)
        out["clients"] = list(self.clients)
        out["files"] = dict(self.files)
        return out

    @staticmethod
    def from_json(data: dict[str, object]) -> "Manifest":
        files_raw = data.get("files", {})
        files = (
            {str(k): str(v) for k, v in files_raw.items()}
            if isinstance(files_raw, dict)
            else {}
        )
        servers = data.get("servers", [])
        clients = data.get("clients", [])
        generated_by = data.get("generatedBy")
        return Manifest(
            version=int(data.get("version", 1)),  # type: ignore[arg-type]
            servers=[str(x) for x in servers] if isinstance(servers, list) else [],
            clients=[str(x) for x in clients] if isinstance(clients, list) else [],
            files=files,
            generated_by=str(generated_by) if generated_by is not None else None,
        )


@dataclass
class _Write:
    path: str
    contents: str


@dataclass
class _Conflict:
    path: str
    new_path: str
    contents: str


@dataclass
class ScaffoldDecision:
    """The outcome of planning a (re-)scaffold."""

    #: files to (over)write at their own path: new, or unmodified-since-last-scaffold.
    writes: list[_Write] = field(default_factory=list)
    #: hand-edited files: write the fresh contents to ``<path>.new``, leave the original.
    conflicts: list[_Conflict] = field(default_factory=list)
    #: the manifest to persist after writing.
    manifest: Manifest | None = None
    #: paths the prior manifest tracked that are no longer assembled — reported, never deleted.
    removed: list[str] = field(default_factory=list)


def hash_contents(s: str) -> str:
    """sha256 hex of the UTF-8 bytes of ``s`` (matches the TS digest)."""
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def plan_scaffold(
    stack: Stack,
    assembled: list[AssembledFile],
    prior: Manifest | None,
    read_current: Callable[[str], str | None],
    generated_by: str | None = None,
) -> ScaffoldDecision:
    """Decide what to write for a (re-)scaffold (pure; FS via ``read_current``).

    ``generated_by`` is the MetaObjects version doing the scaffold — stamped into
    the persisted manifest so a later ``gen``/``verify`` can detect staleness.
    """
    writes: list[_Write] = []
    conflicts: list[_Conflict] = []
    files: dict[str, str] = {}

    for f in assembled:
        files[f.path] = hash_contents(f.contents)
        current = read_current(f.path)
        if current is None:
            writes.append(_Write(path=f.path, contents=f.contents))
            continue
        prior_hash = prior.files.get(f.path) if prior else None
        if prior_hash is not None and hash_contents(current) == prior_hash:
            writes.append(_Write(path=f.path, contents=f.contents))  # refresh
        else:
            conflicts.append(
                _Conflict(
                    path=f.path, new_path=f"{f.path}.new", contents=f.contents
                )
            )

    assembled_paths = {f.path for f in assembled}
    removed = (
        [p for p in prior.files if p not in assembled_paths] if prior else []
    )

    return ScaffoldDecision(
        writes=writes,
        conflicts=conflicts,
        manifest=Manifest(
            version=1,
            servers=list(stack.servers),
            clients=list(stack.clients),
            files=files,
            generated_by=generated_by,
        ),
        removed=removed,
    )


def agent_context_staleness(
    manifest: dict[str, object] | None, current_version: str
) -> str | None:
    """One-line nudge if the scaffolded agent context predates the install.

    Returns ``None`` when there is nothing to say — no agent context here, or it
    is in sync — and a one-line advisory message otherwise. Pure + advisory:
    never raises, never blocks, never writes.

    The comparison is **exact equality** on purpose: ANY drift nudges (a
    re-scaffold is cheap + idempotent). Do NOT "fix" this into a semver compare —
    a prerelease/build-metadata difference is still a reason to refresh.
    """
    if manifest is None:
        return None  # no agent context here → nothing to nudge
    generated_by = manifest.get("generatedBy")
    if generated_by == current_version:
        return None  # in sync
    frm = generated_by if generated_by else "an older MetaObjects"
    return (
        f"MetaObjects agent context was generated by {frm}; "
        f"you're on {current_version}. Re-run 'metaobjects agent-docs' to "
        f"refresh the .claude/skills docs."
    )
