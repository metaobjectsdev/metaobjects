package com.metaobjects.generator.spring.runtime;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.regex.Pattern;

/**
 * The decimal wire rule (ADR-0019 Amendment 1, W1 to W4) for the generated Spring REST surface.
 * Plain Java with no framework types, so the Kotlin port and an owned (ejected) copy can use it
 * unchanged.
 *
 * <ul>
 *   <li><b>W1, emit.</b> {@link #format(BigDecimal)}: a decimal is written as a JSON string in
 *       canonical plain notation, with no exponent and no trailing fractional zeros, and zero in
 *       any spelling is {@code "0"}.</li>
 *   <li><b>W2, accept.</b> {@link #parse(String)} takes the JSON-number grammar (an exponent is
 *       allowed on input only) and refuses everything else; {@link #parseFilterOperand(String)}
 *       is the same grammar for a query-string operand. Both are exact: nothing goes through a
 *       double.</li>
 *   <li><b>W3, range.</b> A value outside {@link #MAX_INTEGER_DIGITS} integer digits or
 *       {@link #MAX_FRACTION_DIGITS} fraction digits (PostgreSQL's {@code numeric} limits) is an
 *       error, never silently rounded or expanded.</li>
 *   <li><b>W4, SQLite.</b> {@link #fromDouble15(double)} renders a stored double with 15
 *       significant digits, the precision SQLite keeps.</li>
 * </ul>
 */
public final class CanonicalDecimal {

    /** W2: the JSON-number grammar, and nothing else. */
    private static final Pattern JSON_NUMBER =
        Pattern.compile("-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?");

    /** W3: most digits before the decimal point a value may have. */
    public static final int MAX_INTEGER_DIGITS = 131072;
    /** W3: most digits after the decimal point a value may have. */
    public static final int MAX_FRACTION_DIGITS = 16383;
    /** W4: the significant digits SQLite keeps. */
    public static final int SQLITE_SIGNIFICANT_DIGITS = 15;

    private CanonicalDecimal() { /* no instances */ }

    /** Thrown for input that is not a decimal under W2 or is out of range under W3. */
    public static final class InvalidDecimalException extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;

        public InvalidDecimalException(String message) {
            super(message);
        }
    }

    /** W1: the canonical wire string for {@code value}; {@code null} for {@code null}. */
    public static String format(BigDecimal value) {
        if (value == null) return null;
        if (value.signum() == 0) return "0";
        return value.stripTrailingZeros().toPlainString();
    }

    /**
     * W2: parse a JSON string value or a filter operand exactly.
     *
     * @throws InvalidDecimalException when {@code text} is null, not in the JSON-number grammar
     *         (empty, padded with whitespace, {@code NaN}, {@code +1}, {@code 01}, {@code 1.},
     *         {@code .5}, {@code 0x10}), or out of range (W3)
     */
    public static BigDecimal parse(String text) {
        if (text == null || !JSON_NUMBER.matcher(text).matches()) {
            throw new InvalidDecimalException("not a decimal: " + (text == null ? "null" : "\"" + text + "\""));
        }
        BigDecimal value;
        try {
            value = new BigDecimal(text);
        } catch (NumberFormatException e) {
            // an exponent beyond int range
            throw new InvalidDecimalException("decimal out of range: " + text);
        }
        return checkRange(value, text);
    }

    /** W2 for a query-string operand: the same grammar as {@link #parse(String)}, compared exactly. */
    public static BigDecimal parseFilterOperand(String text) {
        return parse(text);
    }

    /**
     * W2 for a JSON number token the caller has already read exactly (Jackson's
     * {@code getDecimalValue()}): only the W3 range check applies.
     */
    public static BigDecimal fromJsonNumber(BigDecimal value) {
        return checkRange(value, value.toString());
    }

    /**
     * W4: a double read from SQLite, rendered with 15 significant digits and canonicalized.
     * {@code 0.30000000000000004} gives {@code 0.3}.
     *
     * @throws InvalidDecimalException for NaN or an infinity
     */
    public static BigDecimal fromDouble15(double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            throw new InvalidDecimalException("not a finite decimal: " + value);
        }
        if (value == 0d) return BigDecimal.ZERO;
        BigDecimal rounded = new BigDecimal(value)
            .round(new MathContext(SQLITE_SIGNIFICANT_DIGITS, RoundingMode.HALF_EVEN));
        return rounded.signum() == 0 ? BigDecimal.ZERO : rounded.stripTrailingZeros();
    }

    /** W4 as the wire string: {@code format(fromDouble15(value))}. */
    public static String formatDouble15(double value) {
        return format(fromDouble15(value));
    }

    /**
     * W3 against a declared column: the value must fit {@code precision} total digits with
     * {@code scale} after the point. Trailing zeros do not count, and nothing is rounded.
     *
     * @return {@code value}, unchanged
     * @throws InvalidDecimalException when it has more fraction digits than {@code scale} or more
     *         integer digits than {@code precision - scale}
     */
    public static BigDecimal checkDeclared(BigDecimal value, int precision, int scale) {
        if (value == null || value.signum() == 0) return value;
        BigDecimal stripped = value.stripTrailingZeros();
        long integerDigits = Math.max(0L, (long) stripped.precision() - stripped.scale());
        long fractionDigits = Math.max(0, stripped.scale());
        if (fractionDigits > scale || integerDigits > (long) precision - scale) {
            throw new InvalidDecimalException("decimal does not fit decimal(" + precision + "," + scale + "): "
                + format(value));
        }
        return value;
    }

    private static BigDecimal checkRange(BigDecimal value, String shown) {
        if (value.signum() == 0) return BigDecimal.ZERO;
        BigDecimal stripped = value.stripTrailingZeros();
        long integerDigits = (long) stripped.precision() - stripped.scale();
        if (integerDigits > MAX_INTEGER_DIGITS || stripped.scale() > MAX_FRACTION_DIGITS) {
            throw new InvalidDecimalException("decimal out of range: " + shown);
        }
        return value;
    }
}
