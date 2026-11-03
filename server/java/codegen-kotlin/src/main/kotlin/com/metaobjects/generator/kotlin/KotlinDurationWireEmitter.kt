package com.metaobjects.generator.kotlin

import com.metaobjects.generator.util.GeneratedFileWriter
import java.nio.file.Path

/**
 * Writes the per-package `MetaDurationWire.kt` support file: the `field.duration` wire rule
 * (`fixtures/duration-wire/`) the generated entity, table and controller share, in generated
 * source, so the generated code imports nothing from MetaObjects at runtime. Mirrors
 * [KotlinDecimalWireEmitter].
 *
 * A `java.time.Duration` is written in the canonical ISO-8601 form `[-]PT[nH][nM][n[.f]S]` and read
 * from the accepted form only; `Duration.parse` takes more (fractional hours, per-component signs,
 * lowercase) and `Duration.toString()` differs from the canonical form for a negative span, so
 * neither is the wire form. A value keeps nanoseconds (a `java.time.Duration`'s precision); the
 * stored forms truncate to microseconds, which is what a Postgres interval and the BIGINT column hold.
 *
 * On Postgres, pgjdbc hands an interval column (scalar or array element) to Exposed as a
 * `PGInterval`, so that object's text is the only interval spelling the helper reads; one with a
 * year or month part is refused, never converted.
 *
 * The content is fixed, so several writers of the same path agree byte for byte.
 */
object KotlinDurationWireEmitter {

    /** File name (sans `.kt`) and the name of the `internal object` it declares. */
    const val FILE_NAME = "MetaDurationWire"

    /** Write `MetaDurationWire.kt` into [pkg] under [outRoot]. */
    fun write(pkg: String, outRoot: Path) {
        val header = if (pkg.isEmpty()) "" else "package $pkg\n\n"
        val outFile = outRoot.resolve(pkg.replace('.', '/')).resolve("$FILE_NAME.kt")
        GeneratedFileWriter.write(outFile, header + BODY + "\n")
    }

    /**
     * The fixed body. `+`-concatenated messages and no Kotlin string templates (every `$` below is
     * a regex anchor followed by `)` or `"`), so this raw string needs no `$` escaping. Depends on
     * Jackson only, which a generated entity already imports.
     */
    val BODY: String = """
        |import com.fasterxml.jackson.core.JsonGenerator
        |import com.fasterxml.jackson.core.JsonParser
        |import com.fasterxml.jackson.core.JsonToken
        |import com.fasterxml.jackson.databind.DeserializationContext
        |import com.fasterxml.jackson.databind.JsonNode
        |import com.fasterxml.jackson.databind.SerializerProvider
        |import com.fasterxml.jackson.databind.deser.std.StdDeserializer
        |import com.fasterxml.jackson.databind.ser.std.StdSerializer
        |import java.time.Duration
        |
        |/**
        | * GENERATED — do not hand-edit. The field.duration wire rule: a duration is written as the
        | * canonical ISO-8601 string [-]PT[nH][nM][n[.f]S] (hours never folded into days, up to nine
        | * fractional digits, zero as PT0S) and read from the accepted form only: an optional sign, P, an
        | * optional week count (W = exactly 7 days), an optional day count (D = exactly 24 hours), T and
        | * hours/minutes/seconds (a fraction of any length, truncated toward zero to the nanosecond).
        | * Years and months are refused: a calendar span has no fixed length. Dependency-free (Jackson only).
        | */
        |internal object MetaDurationWire {
        |    private val ACCEPTED = Regex("^([-+])?P(?!$)(?:(\\d+)W)?(?:(\\d+)D)?(?:T(?=\\d)(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)(?:\\.(\\d+))?S)?)?$")
        |    /** The text of pgjdbc's PGInterval: what a JDBC read of an interval column, or of an interval[] element, hands back. */
        |    private val PG_INTERVAL = Regex("^(-?\\d+) years (-?\\d+) mons (-?\\d+) days (-?\\d+) hours (-?\\d+) mins (-?)(\\d+)(?:\\.(\\d+))? secs$")
        |
        |    /** What a refused value should have been. */
        |    const val EXPECTED = "an ISO-8601 duration such as PT1H30M (no years or months)"
        |
        |    /** True when [text] is in the accepted ISO-8601 form and fits a Duration (refused past it, never wrapped). */
        |    fun isDuration(text: String?): Boolean =
        |        text != null && ACCEPTED.matches(text) && runCatching { parse(text) }.isSuccess
        |
        |    /** Strict read of an accepted ISO-8601 duration (digits past a nanosecond truncated toward zero). */
        |    fun parse(text: String?): Duration {
        |        val m = (if (text == null) null else ACCEPTED.matchEntire(text))
        |            ?: throw IllegalArgumentException("field.duration: not " + EXPECTED + ": " + text)
        |        try {
        |            val g = m.groupValues
        |            val seconds = Math.addExact(
        |                Math.addExact(Math.multiplyExact(num(g[2]), 604_800L), Math.multiplyExact(num(g[3]), 86_400L)),
        |                Math.addExact(Math.multiplyExact(num(g[4]), 3_600L), Math.addExact(Math.multiplyExact(num(g[5]), 60L), num(g[6]))))
        |            val d = Duration.ofSeconds(seconds, nanos(g[7]))
        |            return if (g[1] == "-") d.negated() else d
        |        } catch (e: ArithmeticException) {
        |            throw IllegalArgumentException("field.duration: out of range: " + text)
        |        } catch (e: NumberFormatException) {
        |            throw IllegalArgumentException("field.duration: out of range: " + text)
        |        }
        |    }
        |
        |    /** The canonical wire form of [value], to the nanosecond (trailing zeros dropped). */
        |    fun format(value: Duration): String {
        |        val negative = value.isNegative
        |        val mag = if (negative) value.negated() else value
        |        val total = mag.seconds
        |        val nanos = mag.nano.toLong()
        |        if (total == 0L && nanos == 0L) return "PT0S"
        |        val b = StringBuilder(if (negative) "-PT" else "PT")
        |        if (total / 3_600L > 0) b.append(total / 3_600L).append('H')
        |        if (total % 3_600L / 60L > 0) b.append(total % 3_600L / 60L).append('M')
        |        if (total % 60L > 0 || nanos > 0) {
        |            b.append(total % 60L)
        |            fraction(b, nanos, 9)
        |            b.append('S')
        |        }
        |        return b.toString()
        |    }
        |
        |    /**
        |     * The Postgres interval input spelling `[-]HH:MM:SS[.f]`: Postgres refuses a signed ISO-8601
        |     * duration. An interval holds microseconds, so a sub-microsecond part is truncated toward zero.
        |     */
        |    fun formatPostgres(value: Duration): String {
        |        val mag = if (value.isNegative) value.negated() else value
        |        val total = mag.seconds
        |        val micros = mag.nano / 1_000L
        |        val b = StringBuilder(if (value.isNegative && (total != 0L || micros != 0L)) "-" else "")
        |        val h = total / 3_600L
        |        if (h < 10) b.append('0')
        |        b.append(h).append(':')
        |        if (total % 3_600L / 60L < 10) b.append('0')
        |        b.append(total % 3_600L / 60L).append(':')
        |        if (total % 60L < 10) b.append('0')
        |        b.append(total % 60L)
        |        fraction(b, micros, 6)
        |        return b.toString()
        |    }
        |
        |    /**
        |     * A stored value: the ISO-8601 string a text column holds, or the text of the PGInterval pgjdbc
        |     * reads a Postgres interval as. An interval with a year or month part is refused, never
        |     * guessed at: a calendar span is not a duration.
        |     */
        |    fun fromStored(text: String): Duration {
        |        if (ACCEPTED.matches(text)) return parse(text)
        |        val pg = PG_INTERVAL.matchEntire(text) ?: throw IllegalArgumentException("field.duration: not a stored duration: " + text)
        |        val g = pg.groupValues
        |        require(g[1].toLong() == 0L && g[2].toLong() == 0L) {
        |            "field.duration: the interval " + text + " has a year or month part; a calendar span is not a duration"
        |        }
        |        val secs = Duration.ofSeconds(g[7].toLong(), nanos(g[8]))
        |        return Duration.ofDays(g[3].toLong()).plusHours(g[4].toLong()).plusMinutes(g[5].toLong())
        |            .plus(if (g[6] == "-") secs.negated() else secs)
        |    }
        |
        |    /**
        |     * The 64-bit count of microseconds a SQLite / MySQL column stores (sub-microsecond precision
        |     * truncated toward zero); past the 64-bit range (that column's limit) it is refused.
        |     */
        |    fun toMicros(value: Duration): Long {
        |        try {
        |            val mag = if (value.isNegative) value.negated() else value
        |            val micros = Math.addExact(Math.multiplyExact(mag.seconds, 1_000_000L), mag.nano / 1_000L)
        |            return if (value.isNegative) -micros else micros
        |        } catch (e: ArithmeticException) {
        |            throw IllegalArgumentException("field.duration: " + value + " is past a 64-bit count of microseconds")
        |        }
        |    }
        |
        |    /** A stored count of microseconds as a duration. */
        |    fun fromMicros(micros: Long): Duration =
        |        Duration.ofSeconds(Math.floorDiv(micros, 1_000_000L), Math.floorMod(micros, 1_000_000L) * 1_000L)
        |
        |    /** A duration from a JSON node: an accepted string, anything else is rejected. */
        |    fun fromNode(node: JsonNode): Duration {
        |        if (node.isTextual) return parse(node.asText())
        |        throw IllegalArgumentException("field.duration: not a string: " + node)
        |    }
        |
        |    private fun num(digits: String): Long = if (digits.isEmpty()) 0L else digits.toLong()
        |
        |    /** A fraction of any length as whole nanoseconds, the digits past the ninth truncated toward zero. */
        |    private fun nanos(frac: String): Long =
        |        if (frac.isEmpty()) 0L else (frac + "000000000").substring(0, 9).toLong()
        |
        |    /** [value] as [width] zero-padded ASCII digits after a `.`, trailing zeros dropped. */
        |    private fun fraction(b: StringBuilder, value: Long, width: Int) {
        |        if (value == 0L) return
        |        b.append('.').append(value.toString().padStart(width, '0').trimEnd('0'))
        |    }
        |
        |    /** Writes a duration as its canonical ISO-8601 string, whatever the host ObjectMapper would do. */
        |    class Serializer : StdSerializer<Duration>(Duration::class.java) {
        |        override fun serialize(value: Duration, gen: JsonGenerator, provider: SerializerProvider) {
        |            gen.writeString(format(value))
        |        }
        |    }
        |
        |    /** Reads the accepted form only; a number of seconds, a calendar span or a clock string is a 400. */
        |    class Deserializer : StdDeserializer<Duration>(Duration::class.java) {
        |        override fun deserialize(p: JsonParser, ctxt: DeserializationContext): Duration {
        |            if (p.currentToken() != JsonToken.VALUE_STRING) {
        |                return ctxt.handleUnexpectedToken(Duration::class.java, p) as Duration
        |            }
        |            return try {
        |                parse(p.text)
        |            } catch (e: IllegalArgumentException) {
        |                ctxt.handleWeirdStringValue(Duration::class.java, p.text, "%s", e.message) as Duration
        |            }
        |        }
        |    }
        |}
        """.trimMargin()
}
