package com.metaobjects.integration;

import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.time.LocalTime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

/**
 * R6: out-of-band REAL/DOUBLE guard — the ONLY normalization case that cannot be a shared
 * round-trip scenario (you can't seed a value that must THROW). {@link Normalization#normalizeValue}
 * routes Float/Double through the canonical-float stringifier; out-of-band (exponential) values
 * fail loudly so a bad fixture surfaces immediately instead of silently corrupting the cross-port
 * byte-equality compare. The happy-path float/integer/bigint/numeric cases formerly here are now
 * gated end-to-end by the shared persistence-conformance round-trip corpus (REAL/DOUBLE →
 * queries/measurement-floats.yaml; INTEGER/BIGINT/NUMERIC → queries/projection-aggregates.yaml).
 */
class NormalizationFloatTest {
    @Test void outOfBandDouble_throws() {
        assertThrows(IllegalArgumentException.class,
            () -> Normalization.normalizeValue(1.0e-10d)); // Double.toString -> "1.0E-10"
    }
    @Test void outOfBandFloat_throws() {
        assertThrows(IllegalArgumentException.class,
            () -> Normalization.normalizeValue(1.0e-10f)); // Float.toString -> "1.0E-10"
    }

    // SP-A close-out: sub-millisecond fractional seconds TRUNCATE to ms (123456 us of
    // a second = 123_456_000 ns → ".123", NOT ".123456" or a rounded ".124").
    @Test void subMillisecondTime_truncatesToMillis() {
        assertEquals("14:30:00.123",
            Normalization.normalizeValue(LocalTime.of(14, 30, 0, 123_456_000)));
    }
    @Test void subMillisecondTimestamp_truncatesToMillis() {
        assertEquals("2026-05-31T14:30:00.123",
            Normalization.normalizeValue(LocalDateTime.of(2026, 5, 31, 14, 30, 0, 123_456_000)));
    }
}
