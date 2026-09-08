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


# One release, two ecosystem spellings — the nudge must not fire (F77).
#
# `meta agent-docs` is the canonical scaffolder for EVERY port (ADR-0033), so `generatedBy`
# is always an npm version: `1.0.0-rc.5`. This port reports PEP 440's `1.0.0rc5`. Those are
# ONE release written two ways, `==` said otherwise, and the remedy re-runs the scaffolder
# which re-stamps the same npm string — so the advisory fired on every invocation forever,
# including when the context was perfectly in sync. Issue #347 with a different pair of
# ecosystems: that fix reasoned about ORDERING, never about spelling.
def test_npm_and_pep440_spellings_of_one_prerelease_are_in_sync() -> None:
    assert agent_context_staleness({"generatedBy": "1.0.0-rc.5"}, "1.0.0rc5") is None


def test_the_same_holds_for_a_beta_and_for_an_unnumbered_prerelease() -> None:
    assert agent_context_staleness({"generatedBy": "1.1.0-beta.2"}, "1.1.0b2") is None
    assert agent_context_staleness({"generatedBy": "1.0.0-rc"}, "1.0.0rc") is None


# ...and the exemption stays narrow: a DIFFERENT prerelease is real drift.
def test_a_different_prerelease_iteration_still_nudges() -> None:
    msg = agent_context_staleness({"generatedBy": "1.0.0-rc.4"}, "1.0.0rc5")
    assert msg is not None
    assert "1.0.0-rc.4" in msg


def test_a_prerelease_context_against_a_FINAL_install_still_nudges() -> None:
    # The upgrade this advisory exists for: rc → final is exactly when to re-scaffold.
    assert agent_context_staleness({"generatedBy": "1.0.0-rc.5"}, "1.0.0") is not None


def test_a_final_context_against_a_prerelease_install_still_nudges() -> None:
    assert agent_context_staleness({"generatedBy": "1.0.0"}, "1.0.0rc5") is not None


def test_the_unresolved_sentinel_is_never_canonicalized_into_agreement() -> None:
    # `0.0.0` means "could not resolve". The new spelling-equivalence must not give it a
    # coordinate that could match a real version — an unknown install never asserts
    # "in sync". (Sentinel-vs-sentinel is a plain string match and predates this; it is
    # the one case where both sides genuinely say the same unknown thing.)
    assert agent_context_staleness({"generatedBy": "0.0.0"}, "1.0.0rc5") is not None
    assert agent_context_staleness({"generatedBy": "1.0.0-rc.5"}, "0.0.0") is not None


# ── the MAJOR is information on THIS port ────────────────────────────────────
# Both helpers dropped the leading major, borrowing the Java port's rationale verbatim.
# That rationale is explicitly "a fact peculiar to the JVM": Maven Central carries a
# historical major of npm-major + 7, so `7.24.1` and `0.24.1` ARE one release and the
# coordinate has to drop the major to compare them.
#
# Nothing of the kind is true here. `generatedBy` is stamped by the Node CLI (npm) and
# `installed_metaobjects_version()` reads the PyPI distribution version — and npm and PyPI
# share the major by policy (both go to 1.0.0 at the cut). So on this port the major is
# real information, and dropping it made the nudge assert agreement across a whole major.


def test_a_context_a_MAJOR_behind_is_not_in_sync() -> None:
    # `1.0.0` vs `2.0.0` reduced to the same (0, 0) coordinate and read as one release.
    assert agent_context_staleness({"generatedBy": "1.0.0"}, "2.0.0") is not None
    assert agent_context_staleness({"generatedBy": "0.25.0"}, "1.25.0") is not None


def test_the_1_0_cut_itself_nudges_a_0_x_context() -> None:
    # The live case at the cut, and the reason this is not hypothetical: a Python install
    # upgraded to 1.0.0 whose agent context was scaffolded at 0.25.0 got NO advisory at
    # all. `_context_is_ahead_of_install` compared (25, 0) against (0, 0), concluded the
    # 0.25.0 context was NEWER than the 1.0.0 install, and suppressed the nudge — on the
    # single upgrade the whole feature exists to catch.
    msg = agent_context_staleness(
        {"version": 1, "servers": ["python"], "clients": [], "files": {"a": "h"}, "generatedBy": "0.25.0"},
        "1.0.0",
    )
    assert msg is not None
    assert "0.25.0" in msg


def test_a_context_a_MAJOR_ahead_is_still_silent() -> None:
    # The publish-what-changed exemption is unchanged and still applies WITHIN and ACROSS
    # majors: the canonical scaffolder is npm, so a stamp genuinely newer than this port's
    # install is correct and must not nudge.
    assert agent_context_staleness({"generatedBy": "1.0.0"}, "0.25.0") is None


def test_same_release_and_same_series_agree_on_finals() -> None:
    # The two helpers parsed the same grammar with two different regexes. They must not be
    # able to disagree: the ordering coordinate is the equality coordinate restricted to
    # FINAL releases, so a final that compares equal must also compare not-ahead either way.
    from metaobjects.agent_context.scaffold import (
        _context_is_ahead_of_install,
        _same_release,
    )

    for v in ("0.24.5", "1.0.0", "10.2.30"):
        assert _same_release(v, v) is True
        assert _context_is_ahead_of_install(v, v) is False
    # and a prerelease is "not orderable" to BOTH, so it keeps nudging
    for v in ("1.0.0-rc.5", "1.0.0rc5", "0.24.5+abc", "0.0.0", "nope"):
        assert _context_is_ahead_of_install(v, "1.0.0") is False
