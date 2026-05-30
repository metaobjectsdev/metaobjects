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
    private val timestampFmt: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")

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
        is LocalDate -> v.toString()
        is LocalTime -> v.toString()
        is Time -> v.toLocalTime().toString()
        is Timestamp -> v.toLocalDateTime().format(timestampFmt)
        is LocalDateTime -> v.format(timestampFmt)
        is java.sql.Date -> v.toLocalDate().toString()
        is CharSequence -> v.toString()
        is Map<*, *> -> TreeMap<String, Any?>().apply {
            for ((k, value) in v) put(k.toString(), normalizeValue(value))
        }
        is List<*> -> v.map { normalizeValue(it) }
        else -> v.toString()
    }

    /** NUMERIC/DECIMAL → canonical string: strip trailing zeros + the decimal point if integral. */
    private fun canonicalDecimal(d: BigDecimal): String {
        val s = d.stripTrailingZeros().toPlainString()
        return if (s.contains(".") || !s.contains("E")) s else BigDecimal(s).toPlainString()
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
