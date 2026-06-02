package com.metaobjects.integration.kotlin

import com.fasterxml.jackson.databind.ObjectMapper
import com.fasterxml.jackson.databind.SerializationFeature
import java.math.BigDecimal
import java.nio.charset.StandardCharsets
import java.sql.Time
import java.sql.Timestamp
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Base64
import java.util.TreeMap
import java.util.UUID

/**
 * Per-type normalization matching `fixtures/persistence-conformance/normalization.md`.
 * Identical contract to the Java / C# / TS runners: the same DB row produces the
 * same JSON on every port, so `expect` blocks compare byte-equal after canonical
 * serialization.
 */
object Normalization {

    private val mapper: ObjectMapper = ObjectMapper().configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true)
    // Fixed-width whole-second formatters — java.time's own toString() ELIDES a zero
    // seconds field (LocalTime(14,30) → "14:30", not "14:30:00"), which would diverge
    // from the canonical "HH:MM:SS" / "YYYY-MM-DDTHH:MM:SS" wire forms. The fractional
    // component (SP-A) is appended SEPARATELY via [fractionalSuffix] so the whole-second
    // omit-the-dot rule stays byte-identical to the other ports.
    private val timestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")
    private val timeFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm:ss")

    fun normalizeRow(row: Map<String, Any?>): Map<String, Any?> {
        val out = TreeMap<String, Any?>()
        for ((k, v) in row) out[k] = normalizeValue(v)
        return out
    }

    fun normalizeValue(v: Any?): Any? = when (v) {
        null -> null
        is Boolean -> v
        // BIGINT → string (cross-language wire contract; avoids JS Number 2^53 cliff).
        is Long -> v.toString()
        is Int -> v
        is Short -> v.toInt()
        is Byte -> v.toInt()
        is Float -> canonicalFloat(v)
        is Double -> canonicalFloat(v)
        is BigDecimal -> canonicalDecimal(v)
        is UUID -> v.toString().lowercase()
        is ByteArray -> Base64.getEncoder().encodeToString(v)
        // DATE → "YYYY-MM-DD"; LocalDate.toString() is already this exact form.
        is LocalDate -> v.toString()
        // TIME → "HH:MM:SS[.fff]" (whole seconds via fixed formatter so 14:30 renders
        // "14:30:00", not java.time's elided "14:30"); millisecond fractional suffix
        // appended when sub-second is non-zero (SP-A).
        is LocalTime -> v.format(timeFmt) + fractionalSuffix(v.nano)
        is Time -> v.toLocalTime().let { it.format(timeFmt) + fractionalSuffix(it.nano) }
        // TIMESTAMPTZ → UTC instant + "Z" suffix. The runner surfaces tz-aware columns as
        // OffsetDateTime (NOT collapsed to LocalDateTime), so the zone discriminator survives:
        // re-anchor to UTC and append "Z". A plain TIMESTAMP arrives as Timestamp/LocalDateTime
        // and renders with NO Z (the branches below). This mirrors the Java reference runner.
        // The millisecond fractional suffix (SP-A) is inserted before the "Z".
        is OffsetDateTime -> {
            val utc = v.withOffsetSameInstant(ZoneOffset.UTC)
            utc.toLocalDateTime().format(timestampFmt) + fractionalSuffix(utc.nano) + "Z"
        }
        // TIMESTAMPTZ surfaced as a java.time.Instant (the metaobjects-generated
        // `instantWithTimeZone` Column<Instant> path). An Instant is already a UTC point in
        // time, so render it at UTC and append "Z" — byte-identical to the OffsetDateTime
        // branch above (which the hand-written reference / OffsetDateTime columns still hit).
        is java.time.Instant -> {
            val ldt = LocalDateTime.ofInstant(v, ZoneOffset.UTC)
            ldt.format(timestampFmt) + fractionalSuffix(ldt.nano) + "Z"
        }
        is Timestamp -> { val ldt = v.toLocalDateTime(); ldt.format(timestampFmt) + fractionalSuffix(ldt.nano) }
        is LocalDateTime -> v.format(timestampFmt) + fractionalSuffix(v.nano)
        is java.sql.Date -> v.toLocalDate().toString()
        is CharSequence -> v.toString()
        is Map<*, *> -> TreeMap<String, Any?>().apply {
            for ((k, value) in v) put(k.toString(), normalizeValue(value))
        }
        is List<*> -> v.map { normalizeValue(it) }
        else -> v.toString()
    }

    /**
     * NUMERIC/DECIMAL → canonical string: strip trailing zeros + the decimal point if
     * integral. `stripTrailingZeros().toPlainString()` handles the four corpus values
     * byte-exactly (12.5000→"12.5", -3.2500→"-3.25", 100.0000→"100", 0.0001→"0.0001").
     * The one JDK pitfall is a value of zero: `BigDecimal("0.0000").stripTrailingZeros()`
     * yields `0E-4`, whose `toPlainString()` is the un-stripped "0.0000" — so short-circuit
     * a zero magnitude to "0". Mirrors the Java reference runner (SP-A Unit 4).
     */
    private fun canonicalDecimal(d: BigDecimal): String {
        val stripped = d.stripTrailingZeros()
        if (stripped.signum() == 0) return "0"
        return stripped.toPlainString()
    }

    /**
     * Canonical millisecond fractional-seconds suffix for a temporal value's nanosecond
     * field, per `fixtures/persistence-conformance/normalization.md`: millisecond
     * resolution, no trailing zeros, and the `.` plus the entire fractional component
     * OMITTED when the sub-second value is zero (so whole-second rows stay byte-identical).
     * Examples: .120 → ".12", .123 → ".123", .000 → "". Mirrors the Java reference runner.
     */
    private fun fractionalSuffix(nanos: Int): String {
        val millis = nanos / 1_000_000
        if (millis == 0) return ""
        val s = "%03d".format(millis).trimEnd('0')
        return ".$s"
    }

    /** REAL → canonical plain-decimal string, from the single (no widening tail). */
    private fun canonicalFloat(f: Float): String = canonicalFloatStr(f.toString(), f)
    /** DOUBLE → canonical plain-decimal string. */
    private fun canonicalFloat(d: Double): String = canonicalFloatStr(d.toString(), d)
    private fun canonicalFloatStr(s: String, v: Any): String {
        require(!s.contains('E') && !s.contains('e')) {
            "canonicalFloat: $v is outside the plain-decimal band (exponential notation); " +
                "REAL/DOUBLE fixture values must be in-band dyadic rationals — " +
                "see fixtures/persistence-conformance/normalization.md"
        }
        if (!s.contains('.')) return s
        var out = s.trimEnd('0')
        if (out.endsWith(".")) out = out.dropLast(1)
        return out
    }

    fun canonicalRowsJson(rows: List<Map<String, Any?>>): String {
        val normalized = rows.map { normalizeRow(it) }
        return String(mapper.writeValueAsBytes(normalized), StandardCharsets.UTF_8)
    }
}
