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
