package com.metaobjects.generator.spring.runtime;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Runtime helper shipped alongside the generated Spring controllers. Parses
 * the cross-port FR-009 filter grammar
 * {@code filter[<field>][<op>]=<value>} (and the {@code filter[<field>]=<value>}
 * sugar form for {@code eq}) against a per-entity allowlist.
 *
 * <p>This class is part of {@code codegen-spring}'s public runtime surface —
 * generated controllers import + call into it directly. It is intentionally
 * substrate-agnostic: the parser returns a list of {@link FilterPredicate}
 * records that the consumer's repository implementation translates to its
 * persistence DSL of choice (JPA Criteria, Spring Data Specification,
 * jOOQ, plain JDBC, etc.).</p>
 *
 * <p>Returned {@link FilterParseResult} is either</p>
 * <ul>
 *   <li>{@code predicates} non-null + {@code error} null — success path;
 *       generated controller passes {@code predicates} into the repository.</li>
 *   <li>{@code error} non-null (one of {@code invalid_filter_field} /
 *       {@code invalid_filter_op} / {@code invalid_filter_value} /
 *       {@code filter.in_too_large}) — generated controller emits
 *       {@code 400 {"error": "<envelope>"}}.</li>
 * </ul>
 *
 * <p>Mirror of the TypeScript reference parser in
 * {@code api-contract-server.ts}.</p>
 */
public final class FilterParser {

    private FilterParser() { /* no instances */ }

    /** Sentinel returned by {@link #coerceScalar} on a parse failure. */
    private static final Object INVALID_VALUE = new Object();

    /**
     * Cross-port cap on the number of elements in an {@code in}-list. A larger
     * list is rejected with the {@code filter.in_too_large} envelope so a
     * caller cannot force an unbounded {@code IN (...)} against the DB. Matches
     * the TypeScript {@code runtime-ts} filter parser's {@code DEFAULT_MAX_IN_LIST}.
     */
    public static final int MAX_IN_LIST = 100;

    /**
     * Parse the {@code filter[...]} parameters from a raw URL query string.
     *
     * @param rawQuery       the raw URL query string (without leading {@code ?});
     *                       may be {@code null} or empty
     * @param allowedFields  the per-entity field allowlist (typically
     *                       {@code <Entity>FilterAllowlist.FIELDS})
     * @param opsByField     per-field operator allowlist (typically
     *                       {@code <Entity>FilterAllowlist.OPS_BY_FIELD})
     * @return parse result — either {@code predicates} on success or
     *         {@code error} (one of the cross-port envelope keys) on failure
     */
    public static FilterParseResult parse(
            String rawQuery,
            Set<String> allowedFields,
            Map<String, Set<String>> opsByField) {

        if (rawQuery == null || rawQuery.isEmpty()) return FilterParseResult.ok(List.of());

        List<FilterPredicate> out = new ArrayList<>();
        for (String pair : rawQuery.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            String rawKey = eq < 0 ? pair : pair.substring(0, eq);
            String rawValue = eq < 0 ? "" : pair.substring(eq + 1);
            String key = URLDecoder.decode(rawKey, StandardCharsets.UTF_8);
            String value = URLDecoder.decode(rawValue, StandardCharsets.UTF_8);
            if (!key.startsWith("filter[")) continue;

            int firstClose = key.indexOf(']', 7);
            if (firstClose < 0) continue;
            String field = key.substring(7, firstClose);
            String op;
            int rest = firstClose + 1;
            if (rest >= key.length()) {
                op = "eq";
            } else if (key.charAt(rest) == '[') {
                int secondClose = key.indexOf(']', rest + 1);
                if (secondClose < 0) continue;
                op = key.substring(rest + 1, secondClose);
            } else {
                continue;
            }

            if (!allowedFields.contains(field)) return FilterParseResult.err("invalid_filter_field");
            Set<String> ops = opsByField.get(field);
            if (ops == null || !ops.contains(op)) return FilterParseResult.err("invalid_filter_op");
            Object coerced = coerceValue(value, op);
            if (coerced == INVALID_VALUE) return FilterParseResult.err("invalid_filter_value");
            if (op.equals("in") && coerced instanceof List<?> list && list.size() > MAX_IN_LIST) {
                return FilterParseResult.err("filter.in_too_large");
            }
            out.add(new FilterPredicate(field, op, coerced));
        }
        return FilterParseResult.ok(out);
    }

    /**
     * Coerce a raw URL-decoded string into a typed value for {@code op}. The
     * concrete substrate type (number vs string vs date) is left for the
     * repository to handle — this parser only normalizes the structural
     * shape: a list for {@code in}, a boolean for {@code isNull}, and a
     * raw string for the scalar comparison ops.
     */
    private static Object coerceValue(String raw, String op) {
        if (op.equals("isNull")) {
            if (raw.equals("true")) return Boolean.TRUE;
            if (raw.equals("false")) return Boolean.FALSE;
            return INVALID_VALUE;
        }
        if (op.equals("in")) {
            String[] parts = raw.split(",");
            List<String> list = new ArrayList<>(parts.length);
            for (String p : parts) list.add(p.trim());
            return list;
        }
        // For eq/ne/gt/gte/lt/lte/like the parser passes through the raw
        // string value; the repository binds it via PreparedStatement (where
        // JDBC handles the coercion to the column type).
        return raw;
    }
}
