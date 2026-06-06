"""Unit tests for the agent-context staleness nudge (cross-port feature).

Port of the TS reference (``server/typescript/packages/sdk/src/agent-context/
scaffold.ts`` — ``agentContextStaleness`` + ``generatedBy`` manifest stamping).

When an adopter upgrades MetaObjects but does not re-scaffold the copied-in
``.claude/skills`` agent context, ``gen``/``verify`` should print ONE advisory
line nudging a re-scaffold. The decision is a pure function (exact-equality on
the stamped version — ANY drift nudges, never a semver compare), and the manifest
written by ``agent-docs`` carries the installed version under ``generatedBy``
(SAME key as TS — a polyglot repo may cross-read the manifest).
"""

from __future__ import annotations

import json
from pathlib import Path

from metaobjects.agent_context.scaffold import (
    agent_context_staleness,
    installed_metaobjects_version,
)
from metaobjects.cli import main


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
    assert "agent-docs" in msg  # names the Python refresh command
    assert "metaobjects agent-docs" in msg


def test_absent_generated_by_nudges_with_older_phrase() -> None:
    # A manifest written before version tracking existed → still nudge.
    manifest = {"version": 1, "servers": [], "clients": [], "files": {}}
    msg = agent_context_staleness(manifest, "0.7.0")
    assert msg is not None
    assert "an older MetaObjects" in msg
    assert "0.7.0" in msg
    assert "metaobjects agent-docs" in msg


def test_installed_version_is_a_string() -> None:
    # Resolved via importlib.metadata; falls back to "0.0.0" off the package.
    v = installed_metaobjects_version()
    assert isinstance(v, str)
    assert v  # non-empty


# ---- the stamp -------------------------------------------------------------


def test_agent_docs_stamps_generated_by(tmp_path: Path) -> None:
    rc = main(["agent-docs", "--server", "python", "--out", str(tmp_path)])
    assert rc == 0
    manifest = json.loads(
        (tmp_path / ".metaobjects" / ".agent-context.json").read_text()
    )
    assert "generatedBy" in manifest
    assert manifest["generatedBy"] == installed_metaobjects_version()
