package com.metaobjects.generator.spring.runtime;

import java.time.Duration;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The {@code field.duration} wire rule for a generated record component
 * ({@code fixtures/duration-wire/}): a {@link Duration} is written in the canonical ISO-8601 form
 * {@code [-]PT[<h>H][<m>M][<s>[.<f>]S]} and read from the accepted form only.
 *
 * <p>{@link Duration#parse} accepts more than the accepted form (fractional hours, per-component
 * signs, lowercase designators) and {@link Duration#toString()} differs from the canonical form
 * for negative spans and nanoseconds, so neither is used on the wire. Values are held at
 * microsecond precision (a Postgres {@code interval}'s), truncated toward zero.</p>
 *
 * <p>Self-contained (no MetaObjects imports) so an ejected runtime copy compiles on its own; the
 * same rule is {@code com.metaobjects.field.DurationWire} in the metadata module.</p>
 */
public final class CanonicalDuration {

    private CanonicalDuration() {}

    /** The accepted ISO-8601 duration form: days, hours, minutes, seconds; no years, months or weeks. */
    public static final Pattern ACCEPTED = Pattern.compile(
        "^([-+])?P(?!$)(?:(\\d+)D)?(?:T(?=\\d)(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)(?:\\.(\\d{1,9}))?S)?)?$");

    /** What a refused value should have been. */
    public static final String EXPECTED = "an ISO-8601 duration such as PT1H30M (no years, months or weeks)";

    /** A value that is not a duration. */
    public static final class InvalidDurationException extends IllegalArgumentException {
        private static final long serialVersionUID = 1L;
        public InvalidDurationException(String message) { super(message); }
    }

    /** True iff {@code s} is in the accepted form and fits a {@link Duration} (refused past it, never wrapped). */
    public static boolean isDuration(String s) {
        if (s == null || !ACCEPTED.matcher(s).matches()) return false;
        try {
            parse(s);
            return true;
        } catch (InvalidDurationException outOfRange) {
            return false;
        }
    }

    /**
     * Parse an accepted ISO-8601 duration (sub-microsecond digits truncated toward zero). A
     * {@link Duration}'s own range is the only limit.
     *
     * @throws InvalidDurationException when {@code s} is not in the accepted form or overflows
     */
    public static Duration parse(String s) {
        Matcher m = s == null ? null : ACCEPTED.matcher(s);
        if (m == null || !m.matches()) {
            throw new InvalidDurationException("field.duration: not " + EXPECTED + ": \"" + s + "\"");
        }
        try {
            long seconds = Math.addExact(
                Math.addExact(Math.multiplyExact(num(m.group(2)), 86_400L), Math.multiplyExact(num(m.group(3)), 3_600L)),
                Math.addExact(Math.multiplyExact(num(m.group(4)), 60L), num(m.group(5))));
            String frac = m.group(6);
            long micros = frac == null ? 0L
                : Long.parseLong(frac.length() >= 6 ? frac.substring(0, 6) : (frac + "000000").substring(0, 6));
            Duration d = Duration.ofSeconds(seconds, micros * 1_000L);
            return "-".equals(m.group(1)) ? d.negated() : d;
        } catch (ArithmeticException | NumberFormatException e) {
            throw new InvalidDurationException("field.duration: out of range: \"" + s + "\"");
        }
    }

    /** The canonical wire form of {@code d} (sub-microsecond precision truncated toward zero). */
    public static String format(Duration d) {
        boolean negative = d.isNegative();
        Duration mag = negative ? d.negated() : d;
        long total = mag.getSeconds();
        long micros = mag.getNano() / 1_000L;
        if (total == 0 && micros == 0) return "PT0S";
        StringBuilder b = new StringBuilder(negative ? "-PT" : "PT");
        long h = total / 3_600L;
        long mi = (total % 3_600L) / 60L;
        long s = total % 60L;
        if (h > 0) b.append(h).append('H');
        if (mi > 0) b.append(mi).append('M');
        if (s > 0 || micros > 0) {
            b.append(s);
            if (micros > 0) {
                String digits = Long.toString(micros);
                String f = "000000".substring(digits.length()) + digits;
                int end = f.length();
                while (f.charAt(end - 1) == '0') end--;
                b.append('.').append(f, 0, end);
            }
            b.append('S');
        }
        return b.toString();
    }

    private static long num(String digits) {
        return digits == null ? 0L : Long.parseLong(digits);
    }
}
