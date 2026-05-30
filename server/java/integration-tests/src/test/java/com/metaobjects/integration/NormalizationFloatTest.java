package com.metaobjects.integration;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * R6: REAL/DOUBLE wire normalization (mirror of the TS {@code normalization.test.ts} cases).
 * {@link Normalization#normalizeValue} routes Float/Double through the canonical-float
 * stringifier: in-band values become plain-decimal strings (trailing zeros + bare decimal
 * point stripped); out-of-band (exponential) values fail loudly so a bad fixture surfaces
 * immediately instead of silently corrupting the cross-port byte-equality compare.
 */
class NormalizationFloatTest {
    @Test void inBandFloat_isPlainDecimalString() {
        assertEquals("1.5", Normalization.normalizeValue(1.5f));   // REAL (float4)
        assertEquals("0.25", Normalization.normalizeValue(0.25d)); // DOUBLE (float8)
    }
    @Test void integerValuedDouble_stripsTrailingZeroAndPoint() {
        assertEquals("2", Normalization.normalizeValue(2.0d)); // "2.0" -> "2." -> "2"
    }
    @Test void outOfBandDouble_throws() {
        assertThrows(IllegalArgumentException.class,
            () -> Normalization.normalizeValue(1.0e-10d)); // Double.toString -> "1.0E-10"
    }
    @Test void outOfBandFloat_throws() {
        assertThrows(IllegalArgumentException.class,
            () -> Normalization.normalizeValue(1.0e-10f)); // Float.toString -> "1.0E-10"
    }
}
