package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The wire answer for a write body that carries a key the entity does not declare
 * ({@code api.unknownFields: reject}, the default): {@code 400 {"error": "unknown_fields",
 * "fields": [...]}}, the keys in code-point order.
 *
 * <p>The keys are read off the raw {@link JsonNode} BEFORE the body is bound to a DTO, so the
 * answer never depends on whether the host application's {@code ObjectMapper} fails on unknown
 * properties. Depends on Jackson databind and the JDK only ({@code mvn metaobjects:eject} hands
 * it over as plain source).</p>
 */
public final class UnknownBodyKeys {

    /** The {@code error} of the refusal. */
    public static final String ERROR = "unknown_fields";

    private UnknownBodyKeys() { /* no instances */ }

    /**
     * The 400 body for {@code body}'s top-level keys outside {@code known}, or {@code null} when
     * there are none or {@code body} is not a JSON object (a body that is not an object is left to
     * the handler's own reading of it).
     */
    public static Map<String, Object> refusal(JsonNode body, Set<String> known) {
        if (body == null || !body.isObject()) return null;
        TreeSet<String> unknown = new TreeSet<>(UnknownBodyKeys::compareCodePoints);
        body.fieldNames().forEachRemaining(name -> {
            if (!known.contains(name)) unknown.add(name);
        });
        if (unknown.isEmpty()) return null;
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", ERROR);
        out.put("fields", new ArrayList<>(unknown));
        return out;
    }

    /** Ordinal order by Unicode code point (not UTF-16 unit), the order every port answers in. */
    static int compareCodePoints(String a, String b) {
        int i = 0;
        int j = 0;
        while (i < a.length() && j < b.length()) {
            int ca = a.codePointAt(i);
            int cb = b.codePointAt(j);
            if (ca != cb) return Integer.compare(ca, cb);
            i += Character.charCount(ca);
            j += Character.charCount(cb);
        }
        return Integer.compare(a.length() - i, b.length() - j);
    }
}
