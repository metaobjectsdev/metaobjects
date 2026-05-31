"""R6: out-of-band REAL/DOUBLE guard.

The ONLY normalization case that cannot be a shared round-trip scenario (you can't
seed a value that must RAISE). ``_canonical_float`` raises on out-of-band (exponential)
values so a bad fixture surfaces loudly instead of silently corrupting the cross-port
byte-equality compare. Runs without a database.

The happy-path float/integer/bigint/numeric normalization cases formerly here are now
gated end-to-end by the shared persistence-conformance round-trip corpus:
REAL/DOUBLE → ``queries/measurement-floats.yaml``; INTEGER/BIGINT/NUMERIC →
``queries/projection-aggregates.yaml``. See
``fixtures/persistence-conformance/normalization.md``.
"""

from __future__ import annotations

import pytest

from .normalization import _canonical_float, normalize_value


def test_out_of_band_float_raises():
    # repr(1e-10) == "1e-10" -> exponential -> loud failure, not silent corruption.
    with pytest.raises(ValueError):
        _canonical_float(1.0e-10)
    with pytest.raises(ValueError):
        normalize_value(1.0e-10)
