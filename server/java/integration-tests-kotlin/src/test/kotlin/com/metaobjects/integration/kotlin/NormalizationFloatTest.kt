package com.metaobjects.integration.kotlin

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

/**
 * R6: REAL/DOUBLE wire normalization (mirror of the TS `normalization.test.ts` and Java
 * `NormalizationFloatTest` cases). [Normalization.normalizeValue] routes Float/Double through
 * the canonical-float stringifier: in-band values become plain-decimal strings (trailing zeros
 * + bare decimal point stripped); out-of-band (exponential) values fail loudly so a bad fixture
 * surfaces immediately instead of silently corrupting the cross-port byte-equality compare.
 */
class NormalizationFloatTest {
    @Test fun `in-band float is plain decimal string`() {
        assertEquals("1.5", Normalization.normalizeValue(1.5f))   // REAL (float4)
        assertEquals("0.25", Normalization.normalizeValue(0.25)) // DOUBLE (float8)
    }
    @Test fun `integer-valued double strips trailing zero and point`() {
        assertEquals("2", Normalization.normalizeValue(2.0)) // "2.0" -> "2." -> "2"
    }
    @Test fun `out-of-band double throws`() {
        assertFailsWith<IllegalArgumentException> { Normalization.normalizeValue(1.0e-10) } // "1.0E-10"
    }
    @Test fun `out-of-band float throws`() {
        assertFailsWith<IllegalArgumentException> { Normalization.normalizeValue(1.0e-10f) } // "1.0E-10"
    }
}
