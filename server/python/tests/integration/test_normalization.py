"""R6: REAL/DOUBLE wire-normalization unit tests.

Parity with the other ports' standalone float-normalization tests
(``NormalizationFloatTest.java`` / ``NormalizationFloatTest.kt`` /
``normalization.test.ts``). ``_canonical_float`` renders in-band dyadic values as
plain-decimal strings (trailing zeros + a bare decimal point stripped) and raises on
out-of-band (exponential) values so a bad fixture surfaces loudly instead of silently
corrupting the cross-port byte-equality compare. These run without a database.
"""

from __future__ import annotations

import pytest

from .normalization import _canonical_float, normalize_value


def test_in_band_float_is_plain_decimal_string():
    assert _canonical_float(1.5) == "1.5"  # REAL (float4)
    assert _canonical_float(0.25) == "0.25"  # DOUBLE (float8)
    # and via the public route floats take through _canonical_float
    assert normalize_value(1.5) == "1.5"


def test_integer_valued_float_strips_trailing_zero_and_point():
    assert _canonical_float(2.0) == "2"  # repr "2.0" -> "2." -> "2"
    assert normalize_value(2.0) == "2"


def test_out_of_band_float_raises():
    # repr(1e-10) == "1e-10" -> exponential -> loud failure, not silent corruption.
    with pytest.raises(ValueError):
        _canonical_float(1.0e-10)
    with pytest.raises(ValueError):
        normalize_value(1.0e-10)
