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

#: A release with an optional PRE-RELEASE segment, in either spelling one ecosystem uses.
#: npm/NuGet/Maven write ``1.0.0-rc.5``; PEP 440 writes ``1.0.0rc5``. Both are the SAME
#: release, and comparing their SPELLINGS is what made the nudge unsatisfiable — see
#: ``_same_release``.
_PRERELEASE_RE = re.compile(
    r"^(\d+)\.(\d+)\.(\d+)"       # release
    r"(?:-?([A-Za-z]+)\.?(\d+)?)?$"  # optional pre-release: -rc.5 | rc5 | -beta | b2
)


#: PEP 440 abbreviates the pre-release labels that npm spells out, and normalizing to ONE
#: of them is what makes `1.1.0-beta.2` and `1.1.0b2` the same release. Only the spellings
#: PEP 440 itself defines as equivalent — this is a rename table, not a similarity guess.
_PEP440_LABEL_ALIASES = {
    "a": "alpha",
    "b": "beta",
    "c": "rc",
    "pre": "rc",
    "preview": "rc",
}


def _release_coordinate(version: object) -> tuple[int, int, int, str, int] | None:
    """``(major, minor, patch, pre_label, pre_number)`` for a version in ANY ecosystem
    spelling.

    The MAJOR is INFORMATION on this port, and both helpers here used to drop it. That
    reduction is correct on the JVM and only there: Maven Central carries a historical
    major of npm-major + 7 by design, so ``7.24.1`` and ``0.24.1`` genuinely name one
    release and the coordinate must ignore the major to see it. Nothing of the kind holds
    here — ``generatedBy`` is stamped by the Node CLI (an npm version) and
    :func:`installed_metaobjects_version` reads the PyPI distribution version, and npm and
    PyPI share the major by policy. Dropping it made ``1.0.0`` and ``2.0.0`` compare EQUAL,
    and made a ``0.25.0``-stamped context read as NEWER than a ``1.0.0`` install — so the
    1.0 upgrade, the single upgrade this advisory exists to catch, produced no nudge.

    The pre-release label is lower-cased and its separators dropped, so ``-rc.5``,
    ``rc5`` and ``-RC5`` all reduce to ``("rc", 5)``. A final release sorts ABOVE every
    pre-release of the same number, which is what ``("", 0)`` vs ``("rc", 5)`` gives under
    tuple ordering only because ``""`` < ``"rc"`` — so finals carry a sentinel label that
    sorts last instead.

    ``None`` means "not orderable, so nudge": the ``0.0.0`` unresolved-install sentinel,
    build metadata, or anything this cannot parse. Those must never assert "in sync".
    """
    if not isinstance(version, str):
        return None
    v = version.strip()
    if v == _UNRESOLVED_VERSION:
        return None
    m = _PRERELEASE_RE.match(v)
    if m is None:
        return None
    label = _PEP440_LABEL_ALIASES.get((m.group(4) or "").lower(), (m.group(4) or "").lower())
    number = int(m.group(5)) if m.group(5) is not None else 0
    # A FINAL release is newer than every pre-release of the same number. "~" sorts above
    # every ASCII letter, so the sentinel does that with plain tuple comparison.
    return (
        int(m.group(1)),
        int(m.group(2)),
        int(m.group(3)),
        label if label else "~",
        number,
    )


def _same_release(generated_by: object, current_version: str) -> bool:
    """True when two version strings name the SAME release in different spellings.

    The nudge compared spellings, so on the 1.0 RC line it could never be satisfied: the
    canonical scaffolder is the Node CLI (ADR-0033), which stamps npm's ``1.0.0-rc.5``,
    while this port reports PEP 440's ``1.0.0rc5``. Those are one release written two
    ways, ``==`` says otherwise, and the remedy re-runs the scaffolder, which re-stamps
    the same npm string — so the advisory fires on every invocation, forever, including
    when the context is perfectly in sync. That is issue #347 with a different pair of
    ecosystems; the fix for it reasoned about ORDERING and never about spelling.

    Deliberately narrow. Only two versions that parse as the same release coordinate are
    equal; anything unparseable (including the ``0.0.0`` sentinel) still nudges, and an
    ``rc.4`` context against an ``rc.5`` install is a REAL difference and still nudges.
    """
    stamped = _release_coordinate(generated_by)
    installed = _release_coordinate(current_version)
    return stamped is not None and stamped == installed


def _release_series(version: object) -> tuple[int, int, int] | None:
    """Ordered release coordinate ``(major, minor, patch)``, or ``None`` when not orderable.

    Derived from :func:`_release_coordinate` rather than parsed again. These two functions
    used to answer the same grammar with two different regexes — differential-checked
    identical over 200k inputs, which is the good outcome of a coin flip, not a guarantee.
    The ordering coordinate simply IS the equality coordinate restricted to FINAL releases,
    and saying so in code means the two cannot drift apart.

    ``None`` means "not orderable, so nudge", and deliberately covers prereleases
    (``0.24.5-rc.1``, ``1.0.0rc5``), build metadata (``0.24.5+abc``) and the ``0.0.0``
    sentinel. Each must keep nudging: an RC-scaffolded context against a final release is
    still worth refreshing, and an unknown install must never assert "in sync".
    """
    coord = _release_coordinate(version)
    # A pre-release carries a real label; a final carries the "~" sentinel. Only finals are
    # orderable here, which is what the previous release-only regex enforced by construction.
    if coord is None or coord[3] != "~":
        return None
    return coord[0], coord[1], coord[2]


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

    ANY REAL drift nudges (a re-scaffold is cheap + idempotent), so this is not a semver
    compare — an ``rc.4`` context against an ``rc.5`` install is still a reason to
    refresh. Two exemptions, both for cases where nudging can never be SATISFIED:
    ``_same_release`` (one release, two ecosystem spellings) and
    ``_context_is_ahead_of_install`` (a port legitimately behind the npm scaffolder).
    """
    if manifest is None:
        return None  # no agent context here → nothing to nudge
    generated_by = manifest.get("generatedBy")
    if generated_by == current_version:
        return None  # in sync
    if _same_release(generated_by, current_version):
        return None  # one release, two ecosystem spellings — see below
    if _context_is_ahead_of_install(generated_by, current_version):
        return None  # scaffolded by a NEWER release than this install — see below
    frm = generated_by if generated_by else "an older MetaObjects"
    return (
        f"MetaObjects agent context was generated by {frm}; "
        f"you're on {current_version}. Run 'npx meta agent-docs --server python' to "
        f"refresh the .claude/skills docs."
    )
