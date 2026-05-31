package com.metaobjects.integration.kotlin

import kotlin.test.Test
import kotlin.test.assertFailsWith

/**
 * R6: out-of-band REAL/DOUBLE guard — the ONLY normalization case that cannot be a shared
 * round-trip scenario (you can't seed a value that must THROW). [Normalization.normalizeValue]
 * routes Float/Double through the canonical-float stringifier; out-of-band (exponential) values
 * fail loudly so a bad fixture surfaces immediately instead of silently corrupting the cross-port
 * byte-equality compare. The happy-path float/integer/bigint/numeric cases formerly here are now
 * gated end-to-end by the shared persistence-conformance round-trip corpus (REAL/DOUBLE →
 * queries/measurement-floats.yaml; INTEGER/BIGINT/NUMERIC → queries/projection-aggregates.yaml).
 */
class NormalizationFloatTest {
    @Test fun `out-of-band double throws`() {
        assertFailsWith<IllegalArgumentException> { Normalization.normalizeValue(1.0e-10) } // "1.0E-10"
    }
    @Test fun `out-of-band float throws`() {
        assertFailsWith<IllegalArgumentException> { Normalization.normalizeValue(1.0e-10f) } // "1.0E-10"
    }
}
