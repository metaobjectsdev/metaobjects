package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.databind.JsonMappingException;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The wire answer for a request body Jackson could not bind (ADR-0019 Amendment 1, W2/W3): a
 * malformed decimal, an out-of-range one, a wrong JSON type. The generated controller's
 * {@code @ExceptionHandler} for {@code HttpMessageNotReadableException} returns
 * {@code 400 {"error": "validation", "issues": [{"code", "path", "message"}], "field": "<name>"}},
 * the cross-port validation envelope, instead of Spring's default body. The one issue's
 * {@code path} is every property Jackson was binding (nested members and array indexes
 * included), empty when the body as a whole cannot be read (invalid JSON text). {@code field}
 * is kept for clients that read it: the last property name, left out when there is none.
 * Only property names are read, never the offending value.
 */
public final class UnreadableBody {

    private UnreadableBody() { /* no instances */ }

    /**
     * The body for {@code failure}: {@code {"error":"validation","issues":[...]}} plus {@code field}
     * when known. The one issue's {@code path} is every property Jackson was binding (nested
     * members and array indexes included) and is empty when the body as a whole cannot be read.
     */
    public static Map<String, Object> envelope(Throwable failure) {
        List<Object> path = pathOf(failure);
        ValidationIssues issues = new ValidationIssues().add(
            PatchValidationException.codeOf(failure), path,
            path.isEmpty() ? "request body is not readable" : "field '" + path.get(path.size() - 1) + "' is not a valid value");
        String field = fieldOf(failure);
        return field == null ? issues.body() : issues.body("field", field);
    }

    private static List<Object> pathOf(Throwable failure) {
        for (Throwable t = failure; t != null; t = t.getCause() == t ? null : t.getCause()) {
            if (t instanceof JsonMappingException mapping && !mapping.getPath().isEmpty()) {
                List<Object> out = new ArrayList<>();
                for (JsonMappingException.Reference ref : mapping.getPath()) {
                    if (ref.getFieldName() != null) out.add(ref.getFieldName());
                    else if (ref.getIndex() >= 0) out.add(ref.getIndex());
                }
                return out;
            }
        }
        return List.of();
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
