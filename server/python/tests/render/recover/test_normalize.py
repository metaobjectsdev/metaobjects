"""Unit tests for ``normalize_enum`` — FR-011 ASCII enum normalization.

Mirrors the cross-port Normalize tests (TS ``normalizeEnum`` / C# ``Normalize.Enum`` /
Java ``Normalize.enumValue``). The rule is ASCII-only and byte-identical across ports.
"""
from __future__ import annotations

from metaobjects.render.recover.normalize import (
    COLLAPSE,
    DEFAULT,
    NONE,
    STRIP,
    normalize_enum,
)


def test_default_is_strip() -> None:
    assert DEFAULT == STRIP == "strip"


def test_none_is_identity() -> None:
    assert normalize_enum("In Progress", NONE) == "In Progress"
    assert normalize_enum("", NONE) == ""


def test_collapse_uppercases_trims_and_collapses_runs() -> None:
    assert normalize_enum("in progress", COLLAPSE) == "IN_PROGRESS"
    assert normalize_enum("  in   progress  ", COLLAPSE) == "IN_PROGRESS"
    assert normalize_enum("in-progress", COLLAPSE) == "IN_PROGRESS"
    assert normalize_enum("in__progress", COLLAPSE) == "IN_PROGRESS"
    assert normalize_enum("IN_PROGRESS", COLLAPSE) == "IN_PROGRESS"


def test_collapse_does_not_match_run_together_word() -> None:
    # "inprogress" has no separator, so it does NOT collapse to IN_PROGRESS.
    assert normalize_enum("inprogress", COLLAPSE) == "INPROGRESS"


def test_strip_uppercases_and_keeps_only_alnum() -> None:
    assert normalize_enum("in progress", STRIP) == "INPROGRESS"
    assert normalize_enum("In-Progress!", STRIP) == "INPROGRESS"
    assert normalize_enum("in_progress", STRIP) == "INPROGRESS"
    assert normalize_enum("IN PROGRESS 2", STRIP) == "INPROGRESS2"


def test_unknown_mode_treated_as_strip() -> None:
    assert normalize_enum("in progress", "bogus") == "INPROGRESS"


def test_ascii_only_fold_leaves_non_ascii_untouched() -> None:
    # MANUAL a-z fold: a non-ASCII lowercase letter must NOT be uppercased
    # (str.upper would fold it; the cross-port rule must not). It is then dropped
    # by strip's [A-Z0-9] filter.
    assert normalize_enum("café", STRIP) == "CAF"
    # Turkish dotless-i (U+0131) is NOT folded by the manual ASCII rule (str.upper
    # WOULD fold it to "I"). Only the ASCII "k" survives, folded to "K".
    assert normalize_enum("ışık", STRIP) == "K"


def test_collapse_keeps_non_ascii_payload_chars() -> None:
    # collapse only folds ASCII a-z and collapses separators; non-ascii letters
    # survive (they are neither separators nor stripped).
    assert normalize_enum("aé b", COLLAPSE) == "Aé_B"
