package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.databind.JsonMappingException;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The wire answer for a request body Jackson could not bind (ADR-0019 Amendment 1, W2/W3): a
 * malformed decimal, an out-of-range one, a wrong JSON type. The generated controller's
 * {@code @ExceptionHandler} for {@code HttpMessageNotReadableException} returns
 * {@code 400 {"error": "validation", "field": "<name>"}}, the cross-port validation envelope,
 * instead of Spring's default body. {@code field} is the property Jackson was binding when it
 * failed, and is left out when the failure is not about one property (invalid JSON text).
 * Only the property name is read, never the offending value.
 */
public final class UnreadableBody {

    private UnreadableBody() { /* no instances */ }

    /** The body for {@code failure}: {@code {"error":"validation"}} plus {@code field} when known. */
    public static Map<String, Object> envelope(Throwable failure) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", "validation");
        String field = fieldOf(failure);
        if (field != null) out.put("field", field);
        return out;
    }

    private static String fieldOf(Throwable failure) {
        for (Throwable t = failure; t != null; t = t.getCause() == t ? null : t.getCause()) {
            if (t instanceof JsonMappingException mapping && !mapping.getPath().isEmpty()) {
                String name = mapping.getPath().get(mapping.getPath().size() - 1).getFieldName();
                if (name != null) return name;
            }
        }
        return null;
    }
}
