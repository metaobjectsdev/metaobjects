"""Unit tests for the agent-context staleness nudge (cross-port feature).

Port of the TS reference (``server/typescript/packages/sdk/src/agent-context/
scaffold.ts`` — ``agentContextStaleness`` + ``generatedBy`` manifest stamping).

When an adopter upgrades MetaObjects but does not re-scaffold the copied-in
``.claude/skills`` agent context, ``gen``/``verify`` should print ONE advisory
line nudging a re-scaffold. The decision is a pure function (exact-equality on
the stamped version — ANY drift nudges, never a semver compare), and the manifest
written by ``meta agent-docs`` carries the installed version under ``generatedBy``
(SAME key as TS — a polyglot repo may cross-read the manifest).

Note: the stamp test (``test_agent_docs_stamps_generated_by``) was removed when
the Python assembler was deleted — scaffolding now belongs to ``meta agent-docs``
(the Node CLI); the ``metaobjects agent-docs`` command is a redirect stub.
"""

from __future__ import annotations

from metaobjects.agent_context.scaffold import (
    agent_context_staleness,
    installed_metaobjects_version,
)


# ---- the pure decision -----------------------------------------------------


def test_no_manifest_returns_none() -> None:
    # No agent context scaffolded here → nothing to nudge.
    assert agent_context_staleness(None, "0.7.0") is None


def test_matching_version_returns_none() -> None:
    # In sync → silent.
    manifest = {"version": 1, "generatedBy": "0.7.0", "servers": [], "clients": [], "files": {}}
    assert agent_context_staleness(manifest, "0.7.0") is None


def test_differing_version_nudges_naming_both_versions_and_command() -> None:
    manifest = {"version": 1, "generatedBy": "0.6.1", "servers": [], "clients": [], "files": {}}
    msg = agent_context_staleness(manifest, "0.7.0")
    assert msg is not None
    assert "0.6.1" in msg  # the from-version
    assert "0.7.0" in msg  # the current version
    assert "agent-docs" in msg  # names the refresh command
    assert "npx meta agent-docs --server python" in msg


def test_absent_generated_by_nudges_with_older_phrase() -> None:
    # A manifest written before version tracking existed → still nudge.
    manifest = {"version": 1, "servers": [], "clients": [], "files": {}}
    msg = agent_context_staleness(manifest, "0.7.0")
    assert msg is not None
    assert "an older MetaObjects" in msg
    assert "0.7.0" in msg
    assert "npx meta agent-docs --server python" in msg


def test_installed_version_is_a_string() -> None:
    # Resolved via importlib.metadata; falls back to "0.0.0" off the package.
    v = installed_metaobjects_version()
    assert isinstance(v, str)
    assert v  # non-empty


# ── the context is AHEAD of the install (publish-what-changed, docs/RELEASING.md) ──
# A registry publishes only when it has a changed product file, so Python legitimately
# sits behind npm — and ``meta agent-docs`` (npm, canonical for every port) stamps the
# NEWER version. Nudging there is #347's shape: the remedy re-stamps the same newer
# version, so the advisory can never be satisfied and fires forever on a correct setup.
def test_context_from_a_newer_release_is_silent() -> None:
    assert agent_context_staleness({"generatedBy": "0.24.7"}, "0.24.4") is None


def test_context_newer_only_in_the_patch_is_silent() -> None:
    assert agent_context_staleness({"generatedBy": "0.24.5"}, "0.24.4") is None


def test_context_older_than_the_install_still_nudges() -> None:
    msg = agent_context_staleness({"generatedBy": "0.24.4"}, "0.24.7")
    assert msg is not None
    assert "0.24.4" in msg
    assert "0.24.7" in msg


# The suppression is deliberately narrow: anything not orderable as a plain release
# still nudges, preserving the documented "ANY drift nudges" property.
def test_prerelease_context_still_nudges() -> None:
    assert agent_context_staleness({"generatedBy": "0.24.5-rc.1"}, "0.24.4") is not None


def test_build_metadata_still_nudges() -> None:
    assert agent_context_staleness({"generatedBy": "0.24.5+abc"}, "0.24.4") is not None


def test_unresolved_install_never_asserts_in_sync() -> None:
    assert agent_context_staleness({"generatedBy": "0.24.7"}, "0.0.0") is not None


def test_non_numeric_version_still_nudges() -> None:
    assert agent_context_staleness({"generatedBy": "dev"}, "0.24.4") is not None
