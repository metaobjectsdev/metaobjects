"""Unit tests for ``coerce`` — FR-010 stage 7 (scalar canonicalization).

Mirrors Coerce(Test|Tests), plus the cross-port radix-prefix guard the C#/TS ports
added (Python's ``int(s, 0)`` would accept ``0x..``/``0b..``/``0o..``; we reject).
"""
from __future__ import annotations

from metaobjects.render.recover import coerce as _coerce
from metaobjects.render.recover.coerce import MALFORMED
from metaobjects.render.recover.types import (
    FieldKind,
    FieldSpec,
    RecoverOptions,
    RecoveryReport,
    Tolerance,
)


def _normal() -> RecoverOptions:
    return RecoverOptions.defaults()


def _kinds(rep: RecoveryReport) -> list[str]:
    return [c.kind for c in rep.coercions()]


# ---- enum ----


def test_enum_exact_match() -> None:
    rep = RecoveryReport()
    f = FieldSpec.enum_field("tone", True, ["FRIENDLY", "HOSTILE"], {})
    assert _coerce.value("FRIENDLY", f, _normal(), "tone", rep) == "FRIENDLY"


def test_enum_case_folded_in_normal() -> None:
    rep = RecoveryReport()
    f = FieldSpec.enum_field("tone", True, ["FRIENDLY"], {})
    assert _coerce.value("friendly", f, _normal(), "tone", rep) == "FRIENDLY"


def test_enum_strict_does_not_case_fold() -> None:
    rep = RecoveryReport()
    f = FieldSpec.enum_field("tone", True, ["FRIENDLY"], {})
    opts = _normal().with_tolerance(Tolerance.STRICT)
    assert _coerce.value("friendly", f, opts, "tone", rep) is MALFORMED


def test_enum_schema_alias_folds() -> None:
    rep = RecoveryReport()
    f = FieldSpec.enum_field("tone", True, ["FRIENDLY"], {"warm": "FRIENDLY"})
    assert _coerce.value("warm", f, _normal(), "tone", rep) == "FRIENDLY"
    assert "alias" in _kinds(rep)


def test_runtime_alias_wins_over_schema() -> None:
    rep = RecoveryReport()
    f = FieldSpec.enum_field("tone", True, ["FRIENDLY", "HOSTILE"], {"x": "FRIENDLY"})
    opts = RecoverOptions(tolerance=Tolerance.NORMAL, aliases={"x": "HOSTILE"})
    assert _coerce.value("x", f, opts, "tone", rep) == "HOSTILE"
    assert "runtime-alias-override" in _kinds(rep)


def test_enum_off_vocab_is_malformed() -> None:
    rep = RecoveryReport()
    f = FieldSpec.enum_field("tone", True, ["FRIENDLY"], {})
    assert _coerce.value("banana", f, _normal(), "tone", rep) is MALFORMED


# ---- int / range ----


def test_int_clamp_to_range() -> None:
    rep = RecoveryReport()
    f = FieldSpec.range_("score", FieldKind.INT, True, 0.0, 10.0)
    assert _coerce.value("42", f, _normal(), "score", rep) == 10
    assert "clamp" in _kinds(rep)


def test_int_unparseable_malformed() -> None:
    rep = RecoveryReport()
    f = FieldSpec.scalar("score", FieldKind.INT, True)
    assert _coerce.value("abc", f, _normal(), "score", rep) is MALFORMED


def test_int_truncates_toward_zero() -> None:
    rep = RecoveryReport()
    f = FieldSpec.scalar("k", FieldKind.INT, True)
    assert _coerce.value("42.9", f, _normal(), "k", rep) == 42
    assert _coerce.value("-42.9", f, _normal(), "k", rep) == -42


def test_radix_prefix_rejected_for_int() -> None:
    # int(s, 0) would accept these; Java/C#/TS reject — we match the rejection.
    rep = RecoveryReport()
    f = FieldSpec.scalar("k", FieldKind.INT, True)
    assert _coerce.value("0x1F", f, _normal(), "k", rep) is MALFORMED
    assert _coerce.value("0b101", f, _normal(), "k", rep) is MALFORMED
    assert _coerce.value("0o17", f, _normal(), "k", rep) is MALFORMED


def test_python_permissive_numeric_syntax_rejected_for_parity() -> None:
    # Python int()/float() accept underscore grouping (PEP 515) and Unicode digits;
    # Java/C# reject. The ASCII-numeric gate rejects them → MALFORMED (cross-port parity).
    rep = RecoveryReport()
    i = FieldSpec.scalar("k", FieldKind.INT, True)
    d = FieldSpec.scalar("g", FieldKind.DOUBLE, True)
    for t in ["1_000", "1_0.0_5", "１２３", "٣"]:
        assert _coerce.value(t, i, _normal(), "k", rep) is MALFORMED
        assert _coerce.value(t, d, _normal(), "g", rep) is MALFORMED
    # but canonical ASCII numerics still coerce
    assert _coerce.value("42", i, _normal(), "k", rep) == 42
    assert _coerce.value("0.85", d, _normal(), "g", rep) == 0.85
    assert _coerce.value("1.5e-3", d, _normal(), "g", rep) == 0.0015


def test_empty_string_is_malformed_for_numbers() -> None:
    rep = RecoveryReport()
    f = FieldSpec.scalar("k", FieldKind.DOUBLE, True)
    assert _coerce.value("   ", f, _normal(), "k", rep) is MALFORMED


# ---- boolean ----


def test_boolean_forms() -> None:
    rep = RecoveryReport()
    f = FieldSpec.scalar("ok", FieldKind.BOOLEAN, True)
    assert _coerce.value("yes", f, _normal(), "ok", rep) is True
    assert _coerce.value("0", f, _normal(), "ok", rep) is False


# ---- onField hook ----


def test_on_field_hook_wins() -> None:
    rep = RecoveryReport()
    f = FieldSpec.scalar("x", FieldKind.STRING, True)
    opts = RecoverOptions(on_field=lambda path, raw, spec: "HOOKED")
    assert _coerce.value("anything", f, opts, "x", rep) == "HOOKED"


# ---- non-finite guard ----


def test_nan_is_malformed_for_double() -> None:
    rep = RecoveryReport()
    f = FieldSpec.scalar("n", FieldKind.DOUBLE, True)
    assert _coerce.value("NaN", f, _normal(), "n", rep) is MALFORMED


def test_infinity_is_malformed_for_int() -> None:
    rep = RecoveryReport()
    f = FieldSpec.scalar("k", FieldKind.INT, True)
    assert _coerce.value("Infinity", f, _normal(), "k", rep) is MALFORMED
    assert _coerce.value("-Infinity", f, _normal(), "k", rep) is MALFORMED


# ---- normalizer ----


def test_normalizer_by_field_name_applied() -> None:
    rep = RecoveryReport()
    f = FieldSpec.scalar("x", FieldKind.STRING, True)
    opts = RecoverOptions(normalizers={"x": lambda raw: raw.upper()})
    assert _coerce.value("hello", f, opts, "x", rep) == "HELLO"
    assert "normalizer" in _kinds(rep)
