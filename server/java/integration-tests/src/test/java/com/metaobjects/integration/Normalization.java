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
        if (v instanceof LocalDate d)  return d.toString();
        if (v instanceof LocalTime t)  return t.toString();
        if (v instanceof Time t)       return t.toLocalTime().toString();
        if (v instanceof Timestamp ts) return ts.toLocalDateTime().format(TIMESTAMP_FMT);
        if (v instanceof LocalDateTime ts) return ts.format(TIMESTAMP_FMT);
        if (v instanceof java.sql.Date sd)  return sd.toLocalDate().toString();
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

    /** NUMERIC/DECIMAL → canonical string: strip trailing zeros + the decimal point if integral. */
    private static String canonicalDecimal(BigDecimal d) {
        String s = d.stripTrailingZeros().toPlainString();
        return s.contains(".") || !s.contains("E") ? s : new BigDecimal(s).toPlainString();
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
}
