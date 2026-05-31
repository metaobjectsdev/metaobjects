package com.metaobjects.integration.kotlin

import java.math.BigDecimal
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
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

    // === SP-A: BigDecimal canonicalization (NUMERIC) ===
    @Test fun `decimal strips trailing zeros`() {
        assertEquals("12.5", Normalization.normalizeValue(BigDecimal("12.5000")))
        assertEquals("-3.25", Normalization.normalizeValue(BigDecimal("-3.2500")))
    }
    @Test fun `decimal drops the dot when integer-valued`() {
        assertEquals("100", Normalization.normalizeValue(BigDecimal("100.0000")))
    }
    @Test fun `decimal zero canonicalizes to 0 (the 0E-4 pitfall)`() {
        assertEquals("0", Normalization.normalizeValue(BigDecimal("0.0000")))
    }
    @Test fun `decimal preserves high-scale digits`() {
        assertEquals("0.0001", Normalization.normalizeValue(BigDecimal("0.0001")))
    }

    // === SP-A: millisecond fractional temporal suffix (omit when sub-second is zero) ===
    @Test fun `timestamptz keeps millis before the Z`() {
        // 14:30:00.123 UTC seeded as 09:30:00.123-05:00 → re-anchored to UTC.
        val odt = OffsetDateTime.of(2026, 5, 31, 9, 30, 0, 123_000_000, ZoneOffset.ofHours(-5))
        assertEquals("2026-05-31T14:30:00.123Z", Normalization.normalizeValue(odt))
    }
    @Test fun `plain timestamp strips trailing fractional zeros and adds no Z`() {
        val ldt = LocalDateTime.of(2026, 5, 31, 14, 30, 0, 120_000_000)
        assertEquals("2026-05-31T14:30:00.12", Normalization.normalizeValue(ldt))
    }
    @Test fun `whole-second timestamp omits the dot`() {
        val ldt = LocalDateTime.of(2026, 5, 31, 14, 30, 0, 0)
        assertEquals("2026-05-31T14:30:00", Normalization.normalizeValue(ldt))
    }
    @Test fun `time keeps millis`() {
        assertEquals("14:30:00.123", Normalization.normalizeValue(LocalTime.of(14, 30, 0, 123_000_000)))
    }
    @Test fun `whole-second time omits the dot`() {
        assertEquals("14:30:00", Normalization.normalizeValue(LocalTime.of(14, 30, 0, 0)))
    }
    // SP-A close-out: sub-millisecond fractional seconds TRUNCATE to ms (.123456 → .123),
    // never round to .124 or pass through 6 digits.
    @Test fun `sub-millisecond time truncates to millis`() {
        assertEquals("14:30:00.123", Normalization.normalizeValue(LocalTime.of(14, 30, 0, 123_456_000)))
    }
    @Test fun `sub-millisecond timestamp truncates to millis`() {
        assertEquals("2026-05-31T14:30:00.123",
            Normalization.normalizeValue(LocalDateTime.of(2026, 5, 31, 14, 30, 0, 123_456_000)))
    }
}
