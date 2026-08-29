"""Sidecar manifest + staleness nudge for the agent-context scaffolder.

The assembly path (assemble / plan_scaffold / ScaffoldDecision) has been removed —
that work is now owned by the Node ``meta agent-docs`` CLI. This module retains
only the staleness-nudge machinery (``agent_context_staleness``, ``Manifest``,
``AGENT_CONTEXT_MANIFEST_PATH``, ``installed_metaobjects_version``) which is used
by ``gen``/``verify`` to detect when the scaffolded agent context predates the
installed MetaObjects version.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from importlib.metadata import PackageNotFoundError, version as _pkg_version

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


# The sentinel a port stamps when it cannot resolve its own installed version.
_UNRESOLVED_VERSION = "0.0.0"

_RELEASE_RE = re.compile(r"^(\d+)\.(\d+)\.(\d+)$")


def _release_series(version: object) -> tuple[int, int] | None:
    """Ordered release coordinate ``(minor, patch)``, or ``None`` when not orderable.

    The MAJOR is deliberately dropped. It is a per-registry constant, not information:
    npm/PyPI/NuGet ship ``0.<m>.<p>`` and Maven Central the same ``<m>.<p>`` on its
    historical major ``7``, so minor.patch IS the shared release coordinate across all
    four ports.

    ``None`` means "not orderable, so nudge", and deliberately covers prereleases
    (``0.24.5-rc.1``), build metadata (``0.24.5+abc``) and the ``0.0.0`` sentinel. Each
    must keep nudging: an RC-scaffolded context against a final release is still worth
    refreshing, and an unknown install must never assert "in sync".
    """
    if not isinstance(version, str):
        return None
    v = version.strip()
    if v == _UNRESOLVED_VERSION:
        return None
    m = _RELEASE_RE.match(v)
    if m is None:
        return None
    return int(m.group(2)), int(m.group(3))


def _context_is_ahead_of_install(generated_by: object, current_version: str) -> bool:
    """True when the manifest was stamped by a release STRICTLY NEWER than the install.

    The one exemption from "any drift nudges", and it exists because of the
    publish-what-changed rule (docs/RELEASING.md): a registry publishes only when it has
    a changed product file, so a port legitimately sits behind npm — while
    ``meta agent-docs``, the canonical scaffolder for EVERY port, stamps the npm version
    it was run from. A Python install at ``0.24.4`` whose context was scaffolded by npm
    ``0.24.7`` is correct, and nudging it is issue #347 exactly: the remedy re-runs the
    scaffolder, which re-stamps ``0.24.7``, so the advisory can never be satisfied and
    fires on every build forever.

    KNOWN BOUND, stated rather than hidden: ordering on minor.patch assumes both versions
    sit in the same release SERIES. That holds for every release to date and after the
    1.0/8.0 cut, but not ACROSS it — there a ``0.24.x`` context against a ``1.0.0``
    install reads as "ahead" and the nudge is suppressed once. A missed advisory, never a
    wrong action.
    """
    stamped = _release_series(generated_by)
    installed = _release_series(current_version)
    if stamped is None or installed is None:
        return False  # not orderable → nudge
    return stamped > installed


def agent_context_staleness(
    manifest: dict[str, object] | None, current_version: str
) -> str | None:
    """One-line nudge if the scaffolded agent context predates the install.

    Returns ``None`` when there is nothing to say — no agent context here, or it
    is in sync — and a one-line advisory message otherwise. Pure + advisory:
    never raises, never blocks, never writes.

    The comparison is **exact equality** first: ANY drift nudges (a re-scaffold is
    cheap + idempotent), so this is not a semver compare — a prerelease or
    build-metadata difference is still a reason to refresh. See
    ``_context_is_ahead_of_install`` for the ONE case that is exempt.
    """
    if manifest is None:
        return None  # no agent context here → nothing to nudge
    generated_by = manifest.get("generatedBy")
    if generated_by == current_version:
        return None  # in sync
    if _context_is_ahead_of_install(generated_by, current_version):
        return None  # scaffolded by a NEWER release than this install — see below
    frm = generated_by if generated_by else "an older MetaObjects"
    return (
        f"MetaObjects agent context was generated by {frm}; "
        f"you're on {current_version}. Run 'npx meta agent-docs --server python' to "
        f"refresh the .claude/skills docs."
    )
