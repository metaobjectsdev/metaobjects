package com.metaobjects.integration.kotlin.tables

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode

/**
 * The decimal wire rule (ADR-0019 Amendment 1) as the hand-written reference tables and the runner
 * need it: the canonical string, the strict reader, the 15-digit SQLite read. The generated code has
 * its own copy (`MetaDecimalWire`, written beside it); this is the test harness's, so the harness
 * depends on no MetaObjects runtime either.
 */
object ReferenceDecimal {
    private val JSON_NUMBER = Regex("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")

    fun format(value: BigDecimal): String = if (value.signum() == 0) "0" else value.stripTrailingZeros().toPlainString()

    fun parse(text: String): BigDecimal {
        require(JSON_NUMBER.matches(text)) { "not a decimal: $text" }
        return BigDecimal(text)
    }

    fun fromDouble15(value: Double): BigDecimal {
        if (value == 0.0) return BigDecimal.ZERO
        val rounded = BigDecimal(value).round(MathContext(15, RoundingMode.HALF_EVEN))
        return if (rounded.signum() == 0) BigDecimal.ZERO else rounded.stripTrailingZeros()
    }
}
