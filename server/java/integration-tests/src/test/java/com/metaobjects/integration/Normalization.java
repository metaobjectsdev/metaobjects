package com.metaobjects.integration;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Time;
import java.sql.Timestamp;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

/**
 * Per-type normalization matching {@code fixtures/persistence-conformance/normalization.md}.
 * Identical contract to {@code MetaObjects.IntegrationTests.Runner.Normalization} (C#)
 * and {@code normalization.ts} (TypeScript): the same DB row produces the same JSON
 * on every port, so {@code expect} blocks compare byte-equal after canonical
 * serialization.
 */
public final class Normalization {
    private Normalization() {}

    private static final ObjectMapper MAPPER = new ObjectMapper()
        .configure(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS, true);

    private static final DateTimeFormatter TIMESTAMP_FMT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");
    private static final DateTimeFormatter DATE_FMT =
        DateTimeFormatter.ofPattern("yyyy-MM-dd");
    private static final DateTimeFormatter TIME_FMT =
        DateTimeFormatter.ofPattern("HH:mm:ss");

    public static Map<String, Object> normalizeRow(Map<String, Object> row) {
        TreeMap<String, Object> out = new TreeMap<>();
        for (Map.Entry<String, Object> e : row.entrySet()) out.put(e.getKey(), normalizeValue(e.getValue()));
        return out;
    }

    public static Object normalizeValue(Object v) {
        if (v == null) return null;
        if (v instanceof Boolean b) return b;
        // BIGINT → string (the contract; avoids JS Number 2^53 precision cliff).
        if (v instanceof Long l)   return Long.toString(l);
        if (v instanceof Integer i)return i;
        if (v instanceof Short s)  return (int) s;
        if (v instanceof Byte b)   return (int) b;
        if (v instanceof Float f)  return canonicalFloat(f);
        if (v instanceof Double d) return canonicalFloat(d);
        if (v instanceof BigDecimal bd) return canonicalDecimal(bd);
        if (v instanceof UUID u)   return u.toString().toLowerCase(java.util.Locale.ROOT);
        if (v instanceof byte[] bytes) return Base64.getEncoder().encodeToString(bytes);
        if (v instanceof LocalDate d)  return d.format(DATE_FMT);
        if (v instanceof LocalTime t)  return t.format(TIME_FMT) + fractionalSuffix(t.getNano());
        if (v instanceof Time t)       return t.toLocalTime().format(TIME_FMT) + fractionalSuffix(t.toLocalTime().getNano());
        // TIMESTAMPTZ → UTC instant + "Z" suffix. The runner surfaces tz-aware
        // timestamp columns as OffsetDateTime (normalized to UTC in
        // ObjectManagerDbAdapter) so the zone discriminator survives — a plain
        // TIMESTAMP arrives as Timestamp/LocalDateTime and renders with no Z.
        if (v instanceof OffsetDateTime odt) {
            OffsetDateTime utc = odt.withOffsetSameInstant(ZoneOffset.UTC);
            return utc.toLocalDateTime().format(TIMESTAMP_FMT) + fractionalSuffix(utc.getNano()) + "Z";
        }
        if (v instanceof LocalDateTime ts) return ts.format(TIMESTAMP_FMT) + fractionalSuffix(ts.getNano());
        // java.sql.Date / java.sql.Timestamp BOTH extend java.util.Date, so order
        // matters: the sql.Date (DATE column) → "YYYY-MM-DD"; sql.Timestamp and a
        // plain util.Date carry a wall clock → "YYYY-MM-DDTHH:MM:SS" (no Z; a tz
        // column is handled by the OffsetDateTime branch above). The JVM default
        // zone is pinned to UTC by QueryScenarioTests so the wall clock is the UTC
        // wall clock the cross-port fixtures expect.
        if (v instanceof java.sql.Date sd)  return sd.toLocalDate().format(DATE_FMT);
        if (v instanceof Timestamp ts) {
            LocalDateTime ldt = ts.toLocalDateTime();
            return ldt.format(TIMESTAMP_FMT) + fractionalSuffix(ldt.getNano());
        }
        if (v instanceof java.util.Date d) {
            // OMDB's DateField codec stores a DATE column as a midnight-anchored
            // java.util.Date; render the calendar date (UTC) per the DATE wire rule.
            return DATE_FMT.format(d.toInstant().atZone(ZoneOffset.UTC));
        }
        if (v instanceof CharSequence) return v.toString();
        if (v instanceof Map<?, ?> m) {
            TreeMap<String, Object> sorted = new TreeMap<>();
            for (Map.Entry<?, ?> e : m.entrySet())
                sorted.put(String.valueOf(e.getKey()), normalizeValue(e.getValue()));
            return sorted;
        }
        if (v instanceof List<?> list) {
            List<Object> out = new ArrayList<>(list.size());
            for (Object item : list) out.add(normalizeValue(item));
            return out;
        }
        return v.toString();
    }

    /** REAL → canonical plain-decimal string, formatted from the single (no widening tail). */
    private static String canonicalFloat(float f)  { return canonicalFloatStr(Float.toString(f), f); }
    /** DOUBLE → canonical plain-decimal string. */
    private static String canonicalFloat(double d) { return canonicalFloatStr(Double.toString(d), d); }
    private static String canonicalFloatStr(String s, Object v) {
        if (s.indexOf('E') >= 0 || s.indexOf('e') >= 0) {
            throw new IllegalArgumentException(
                "canonicalFloat: " + v + " is outside the plain-decimal band (exponential notation); "
                + "REAL/DOUBLE fixture values must be in-band dyadic rationals — "
                + "see fixtures/persistence-conformance/normalization.md");
        }
        if (!s.contains(".")) return s;
        s = s.replaceAll("0+$", "");
        if (s.endsWith(".")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /**
     * NUMERIC/DECIMAL → canonical string: strip trailing zeros + the decimal point
     * if integral. {@code stripTrailingZeros().toPlainString()} handles the four
     * corpus values byte-exactly (12.5000→"12.5", -3.2500→"-3.25", 100.0000→"100",
     * 0.0001→"0.0001"). The one JDK pitfall is a value of zero: {@code new
     * BigDecimal("0.0000").stripTrailingZeros()} yields {@code 0E-4}, whose
     * {@code toPlainString()} is the un-stripped {@code "0.0000"} — so short-circuit
     * a zero magnitude to {@code "0"}.
     */
    private static String canonicalDecimal(BigDecimal d) {
        BigDecimal stripped = d.stripTrailingZeros();
        if (stripped.signum() == 0) return "0";
        return stripped.toPlainString();
    }

    /**
     * Canonical millisecond fractional-seconds suffix for a temporal value's
     * nanosecond field, per {@code fixtures/persistence-conformance/normalization.md}:
     * millisecond resolution, no trailing zeros, and the {@code .} and the entire
     * fractional component OMITTED when the sub-second value is zero (so whole-second
     * rows stay byte-identical — the linchpin of the omit-when-zero rule). Examples:
     * {@code .120 → ".12"}, {@code .123 → ".123"}, {@code .000 → ""}.
     */
    private static String fractionalSuffix(int nanos) {
        long millis = nanos / 1_000_000L;
        if (millis == 0) return "";
        String s = String.format("%03d", millis).replaceAll("0+$", "");
        return "." + s;
    }

    /** Canonical JSON for a row list — each row normalized + serialized with sorted keys. */
    public static String canonicalRowsJson(List<Map<String, Object>> rows) {
        List<Object> normalized = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) normalized.add(normalizeRow(row));
        try {
            return new String(MAPPER.writeValueAsBytes(normalized), StandardCharsets.UTF_8);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    /**
     * Canonical JSON for an ORDER-INDEPENDENT row set ({@code op:relate} — M:N
     * navigation). Mirrors the TS runner's {@code canonicalRowSet}: each row is
     * normalized + serialized, then the per-row JSON strings are sorted so the
     * comparison is port-agnostic regardless of the order the resolver returns
     * the related rows. ({@code op:list} keeps its order — the scenario pins it
     * via {@code sort:}.)
     */
    public static String canonicalRowSet(List<Map<String, Object>> rows) {
        List<String> each = new ArrayList<>(rows.size());
        for (Map<String, Object> row : rows) {
            try {
                each.add(new String(MAPPER.writeValueAsBytes(normalizeRow(row)), StandardCharsets.UTF_8));
            } catch (Exception e) {
                throw new RuntimeException(e);
            }
        }
        each.sort(null);
        return "[" + String.join(",", each) + "]";
    }
}
