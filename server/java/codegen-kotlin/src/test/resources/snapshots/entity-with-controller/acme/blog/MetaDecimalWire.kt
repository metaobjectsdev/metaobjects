package acme.blog

import com.fasterxml.jackson.core.JsonGenerator
import com.fasterxml.jackson.core.JsonParser
import com.fasterxml.jackson.core.JsonToken
import com.fasterxml.jackson.databind.DeserializationContext
import com.fasterxml.jackson.databind.JsonMappingException
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.SerializerProvider
import com.fasterxml.jackson.databind.deser.std.StdDeserializer
import com.fasterxml.jackson.databind.ser.std.StdSerializer
import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode

/**
 * GENERATED (ADR-0019 Amendment 1) — do not hand-edit. The decimal wire rule: a decimal is
 * written as a canonical string (plain notation, no trailing fraction zeros, zero as "0"),
 * and read from a string or number in the JSON-number grammar, exactly, never through a
 * binary float. Dependency-free (Jackson only).
 */
internal object MetaDecimalWire {
    private val JSON_NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")
    private const val MAX_INTEGER_DIGITS = 131072
    private const val MAX_FRACTION_DIGITS = 16383
    private const val SQLITE_SIGNIFICANT_DIGITS = 15

    /** The canonical string of a decimal: plain notation, no trailing fraction zeros, zero as "0". */
    fun format(value: BigDecimal?): String? {
        if (value == null) return null
        if (value.signum() == 0) return "0"
        return value.stripTrailingZeros().toPlainString()
    }

    /** Strict read of a decimal string (the JSON-number grammar; an exponent is allowed). */
    fun parse(text: String?): BigDecimal {
        require(text != null && JSON_NUMBER.matches(text)) { "not a decimal: " + text }
        val value = try {
            BigDecimal(text)
        } catch (e: NumberFormatException) {
            throw IllegalArgumentException("decimal out of range: " + text)
        }
        return checkRange(value, text)
    }

    /** A filter operand: parsed exactly, the same grammar as a body value. */
    fun parseFilterOperand(text: String): BigDecimal = parse(text)

    /** A JSON number token already parsed as a decimal (never a double). */
    fun fromJsonNumber(value: BigDecimal): BigDecimal = checkRange(value, value.toString())

    /** A decimal from a JSON node: a string or a number, anything else is rejected. */
    fun fromNode(node: JsonNode): BigDecimal {
        if (node.isTextual) return parse(node.asText())
        if (node.isNumber) return fromJsonNumber(node.decimalValue())
        throw IllegalArgumentException("not a decimal: " + node)
    }

    /** SQLite keeps a REAL: a stored double reads at 15 significant digits, so 0.1 + 0.2 reads 0.3. */
    fun fromDouble15(value: Double): BigDecimal {
        require(!value.isNaN() && !value.isInfinite()) { "not a finite decimal: " + value }
        if (value == 0.0) return BigDecimal.ZERO
        val rounded = BigDecimal(value).round(MathContext(SQLITE_SIGNIFICANT_DIGITS, RoundingMode.HALF_EVEN))
        return if (rounded.signum() == 0) BigDecimal.ZERO else rounded.stripTrailingZeros()
    }

    /** True when [value] fits decimal(precision, scale): at most scale fraction digits and precision - scale integer digits. */
    fun fits(value: BigDecimal?, precision: Int, scale: Int): Boolean {
        if (value == null || value.signum() == 0) return true
        val stripped = value.stripTrailingZeros()
        val integerDigits = maxOf(0L, stripped.precision().toLong() - stripped.scale())
        val fractionDigits = maxOf(0, stripped.scale())
        return fractionDigits <= scale && integerDigits <= precision.toLong() - scale
    }

    private fun checkRange(value: BigDecimal, shown: String): BigDecimal {
        if (value.signum() == 0) return BigDecimal.ZERO
        val stripped = value.stripTrailingZeros()
        val integerDigits = stripped.precision().toLong() - stripped.scale()
        require(integerDigits <= MAX_INTEGER_DIGITS && stripped.scale() <= MAX_FRACTION_DIGITS) {
            "decimal out of range: " + shown
        }
        return value
    }

    /** The validation envelope for a request body Jackson could not read: names the field when it knows it. */
    fun unreadableBody(failure: Throwable): Map<String, Any> {
        val out = LinkedHashMap<String, Any>()
        out["error"] = "validation"
        var t: Throwable? = failure
        while (t != null) {
            if (t is JsonMappingException && t.path.isNotEmpty()) {
                val name = t.path[t.path.size - 1].fieldName
                if (name != null) { out["field"] = name; break }
            }
            t = if (t.cause === t) null else t.cause
        }
        return out
    }

    /** Writes a decimal as its canonical string. */
    class Serializer : StdSerializer<BigDecimal>(BigDecimal::class.java) {
        override fun serialize(value: BigDecimal, gen: JsonGenerator, provider: SerializerProvider) {
            gen.writeString(format(value))
        }
    }

    /** Reads a decimal from a string or a number, exactly; anything else is a 400-shaped mapping error. */
    class Deserializer : StdDeserializer<BigDecimal>(BigDecimal::class.java) {
        override fun deserialize(p: JsonParser, ctxt: DeserializationContext): BigDecimal? {
            val token = p.currentToken()
            try {
                if (token == JsonToken.VALUE_STRING) return parse(p.text)
                if (token == JsonToken.VALUE_NUMBER_INT || token == JsonToken.VALUE_NUMBER_FLOAT) {
                    return fromJsonNumber(p.decimalValue)
                }
            } catch (e: IllegalArgumentException) {
                return ctxt.handleWeirdStringValue(BigDecimal::class.java, p.text, "%s", e.message) as BigDecimal?
            }
            return ctxt.handleUnexpectedToken(BigDecimal::class.java, p) as BigDecimal?
        }
    }
}

