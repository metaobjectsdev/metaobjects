/*
 * Copyright 2004 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.field;

import java.time.Duration;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * The {@code field.duration} wire rule (shared vectors: {@code fixtures/duration-wire/}).
 *
 * <ul>
 *   <li><b>Accepted</b> on read: {@link #ACCEPTED} — an optional sign, {@code P}, an optional day
 *       count ({@code D} = exactly 24 hours), an optional {@code T} followed by hours, minutes and
 *       seconds (up to 9 fractional digits). Years, months and weeks are refused. Validated
 *       BEFORE any parse: {@link Duration#parse} accepts more (fractional hours, per-component
 *       signs, lowercase).</li>
 *   <li><b>Canonical</b> on write ({@link #format}): {@code [-]PT[<h>H][<m>M][<s>[.<f>]S]} —
 *       hours never folded into days, zero components omitted, zero is {@code PT0S}, at most six
 *       fractional digits (truncated toward zero), one leading {@code -} for a negative span.
 *       {@link Duration#toString()} differs for negatives and nanoseconds, so it is never the
 *       wire form.</li>
 *   <li><b>Postgres</b>: an {@code interval} reads back (IntervalStyle {@code postgres}) as
 *       {@code [-]N days [-+]HH:MM:SS[.f]} — {@link #parsePostgres}; one with a year or month part
 *       is refused. Postgres refuses a signed ISO-8601 duration as input, so a TEXT bind uses
 *       {@link #formatPostgres} ({@code [-]HH:MM:SS[.f]}).</li>
 * </ul>
 *
 * <p>Every value is held at microsecond precision (a Postgres interval's precision).</p>
 */
public final class DurationWire {

    private DurationWire() {}

    /** The accepted ISO-8601 duration form. */
    public static final String ACCEPTED_REGEX =
        "^[-+]?P(?!$)(\\d+D)?(T(?=\\d)(\\d+H)?(\\d+M)?(\\d+(\\.\\d{1,9})?S)?)?$";

    /** {@link #ACCEPTED_REGEX}, compiled. */
    public static final Pattern ACCEPTED = Pattern.compile(ACCEPTED_REGEX);

    /** Capturing form of {@link #ACCEPTED}: sign, days, hours, minutes, seconds, fraction. */
    private static final Pattern PARTS = Pattern.compile(
        "^([-+])?P(?!$)(?:(\\d+)D)?(?:T(?=\\d)(?:(\\d+)H)?(?:(\\d+)M)?(?:(\\d+)(?:\\.(\\d{1,9}))?S)?)?$");

    /** A Postgres interval under IntervalStyle {@code postgres}, with no year or month part. */
    private static final Pattern POSTGRES = Pattern.compile(
        "^(?:([-+]?\\d+) days?(?: |$))?(?:([-+])?(\\d+):(\\d{2}):(\\d{2})(?:\\.(\\d{1,6}))?)?$");

    private static final Pattern POSTGRES_CALENDAR = Pattern.compile("\\b(years?|mons?)\\b");

    /**
     * The largest magnitude a duration may have: 256204778 hours (about 29,000 years), the largest
     * whole hour a .NET {@code TimeSpan} holds, so every port can read what any port wrote. One
     * microsecond more is refused, on parse and on read.
     */
    public static final long MAX_HOURS = 256_204_778L;

    /** {@link #MAX_HOURS} as a {@link Duration}. */
    public static final Duration MAX = Duration.ofHours(MAX_HOURS);

    /**
     * {@code d} when its magnitude is within {@link #MAX}.
     *
     * @throws IllegalArgumentException when it is not ({@code shown} names the input)
     */
    public static Duration checkBound(Duration d, String shown) {
        if (d.abs().compareTo(MAX) > 0) {
            throw new IllegalArgumentException("field.duration: out of range (at most " + MAX_HOURS
                + " hours either way): " + quote(shown));
        }
        return d;
    }

    /** What a refused value is told it should be. */
    public static final String EXPECTED =
        "an ISO-8601 duration such as PT1H30M (no years, months or weeks)";

    /** True iff {@code s} is in the accepted ISO-8601 form and within {@link #MAX_HOURS} hours. */
    public static boolean isDuration(String s) {
        if (s == null || !ACCEPTED.matcher(s).matches()) return false;
        try {
            parse(s);
            return true;
        } catch (IllegalArgumentException outOfRange) {
            return false;
        }
    }

    /**
     * Parse an accepted ISO-8601 duration, truncating below a microsecond toward zero.
     *
     * @throws IllegalArgumentException when {@code s} is not in the accepted form, or overflows
     */
    public static Duration parse(String s) {
        if (s == null) throw new IllegalArgumentException("field.duration: null is not a duration");
        Matcher m = PARTS.matcher(s);
        if (!m.matches()) {
            throw new IllegalArgumentException("field.duration: not " + EXPECTED + ": " + quote(s));
        }
        try {
            long seconds = Math.addExact(
                Math.addExact(Math.multiplyExact(num(m.group(2)), 86_400L),
                              Math.multiplyExact(num(m.group(3)), 3_600L)),
                Math.addExact(Math.multiplyExact(num(m.group(4)), 60L), num(m.group(5))));
            Duration d = Duration.ofSeconds(seconds, micros(m.group(6)) * 1_000L);
            return checkBound("-".equals(m.group(1)) ? d.negated() : d, s);
        } catch (ArithmeticException e) {
            throw new IllegalArgumentException("field.duration: out of range: " + quote(s), e);
        }
    }

    /** {@link #parse} then {@link #format}: the canonical spelling of an accepted duration. */
    public static String canonicalize(String s) {
        return format(parse(s));
    }

    /** The canonical wire form of {@code d} (sub-microsecond precision truncated toward zero). */
    public static String format(Duration d) {
        if (d == null) throw new IllegalArgumentException("field.duration: null is not a duration");
        checkBound(d, d.toString());
        boolean negative = d.isNegative();
        Duration mag = negative ? d.negated() : d;
        long total = mag.getSeconds();
        long micros = mag.getNano() / 1_000L;
        if (total == 0 && micros == 0) return "PT0S";
        long h = total / 3_600L;
        long mi = (total % 3_600L) / 60L;
        long s = total % 60L;
        StringBuilder b = new StringBuilder(negative ? "-PT" : "PT");
        if (h > 0) b.append(h).append('H');
        if (mi > 0) b.append(mi).append('M');
        if (s > 0 || micros > 0) {
            b.append(s);
            appendFraction(b, micros);
            b.append('S');
        }
        return b.toString();
    }

    /** The Postgres interval input spelling of {@code d}: {@code [-]HH:MM:SS[.f]}, no day part. */
    public static String formatPostgres(Duration d) {
        if (d == null) throw new IllegalArgumentException("field.duration: null is not a duration");
        checkBound(d, d.toString());
        boolean negative = d.isNegative();
        Duration mag = negative ? d.negated() : d;
        long total = mag.getSeconds();
        long micros = mag.getNano() / 1_000L;
        if (total == 0 && micros == 0) negative = false;
        StringBuilder b = new StringBuilder(negative ? "-" : "");
        long h = total / 3_600L;
        if (h < 10) b.append('0');
        b.append(h).append(':');
        two(b, (total % 3_600L) / 60L);
        b.append(':');
        two(b, total % 60L);
        appendFraction(b, micros);
        return b.toString();
    }

    /**
     * Read the text a Postgres {@code interval} column returns (IntervalStyle {@code postgres}).
     *
     * @throws IllegalArgumentException for an interval with a year or month part (a calendar span
     *         is not a duration — never a guess at the length of a month) or unreadable text
     */
    public static Duration parsePostgres(String s) {
        if (s == null) throw new IllegalArgumentException("field.duration: null is not an interval");
        if (POSTGRES_CALENDAR.matcher(s).find()) {
            throw new IllegalArgumentException(
                "field.duration: the interval " + quote(s) + " has a year or month part; a calendar span is not a duration");
        }
        Matcher m = POSTGRES.matcher(s);
        if (s.isEmpty() || !m.matches() || (m.group(1) == null && m.group(3) == null)) {
            throw new IllegalArgumentException("field.duration: not a Postgres interval: " + quote(s));
        }
        try {
            Duration days = Duration.ofSeconds(Math.multiplyExact(m.group(1) == null ? 0L : Long.parseLong(m.group(1)), 86_400L));
            if (m.group(3) == null) return checkBound(days, s);
            long secs = Math.addExact(Math.multiplyExact(Long.parseLong(m.group(3)), 3_600L),
                Long.parseLong(m.group(4)) * 60L + Long.parseLong(m.group(5)));
            Duration time = Duration.ofSeconds(secs, micros(m.group(6)) * 1_000L);
            return checkBound(days.plus("-".equals(m.group(2)) ? time.negated() : time), s);
        } catch (ArithmeticException | NumberFormatException e) {
            throw new IllegalArgumentException("field.duration: interval out of range: " + quote(s), e);
        }
    }

    /**
     * A stored duration: the canonical (or any accepted) ISO-8601 string a text column holds, or
     * the text a Postgres interval column returns.
     */
    public static Duration fromStored(String s) {
        return s != null && ACCEPTED.matcher(s).matches() ? parse(s) : parsePostgres(s);
    }

    /** {@link #fromStored} then {@link #format}: the canonical wire string of a stored value. */
    public static String canonicalizeStored(String s) {
        return format(fromStored(s));
    }

    // ── helpers ──

    private static long num(String digits) {
        return digits == null ? 0L : Long.parseLong(digits);
    }

    /** Up to 9 fractional digits → whole microseconds, truncated toward zero. */
    private static long micros(String frac) {
        if (frac == null || frac.isEmpty()) return 0L;
        String six = frac.length() >= 6 ? frac.substring(0, 6) : (frac + "000000").substring(0, 6);
        return Long.parseLong(six);
    }

    private static void appendFraction(StringBuilder b, long micros) {
        if (micros == 0) return;
        String f = pad6(micros);
        int end = f.length();
        while (end > 0 && f.charAt(end - 1) == '0') end--;
        b.append('.').append(f, 0, end);
    }

    private static void two(StringBuilder b, long v) {
        if (v < 10) b.append('0');
        b.append(v);
    }

    /** {@code v} as six ASCII digits, zero-padded (never the default locale's digits). */
    private static String pad6(long v) {
        String digits = Long.toString(v);
        return "000000".substring(digits.length()) + digits;
    }

        private static String quote(String s) {
        return "\"" + s + "\"";
    }
}
