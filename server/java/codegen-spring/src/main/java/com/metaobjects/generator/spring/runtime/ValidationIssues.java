package com.metaobjects.generator.spring.runtime;

import jakarta.validation.ConstraintViolation;
import jakarta.validation.Path;

import java.lang.annotation.Annotation;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The cross-port validation answer: {@code 400 {"error": "validation", "issues": [...]}}, where each
 * issue is {@code {"code", "path", "message"}}. {@code code} uses Zod's names ({@code invalid_type},
 * {@code too_small}, {@code too_big}, {@code invalid_format}, {@code invalid_value}, {@code custom}),
 * {@code path} is the field's wire name (nested members and array indexes as further elements, empty
 * when the body as a whole cannot be read) and {@code message} is this port's own wording.
 *
 * <p>A generated controller collects EVERY issue into one of these before answering, so a caller
 * sees all the problems with a body at once. Depends on the JDK and the jakarta validation API only
 * ({@code mvn metaobjects:eject} hands it over as plain source).</p>
 */
public final class ValidationIssues {

    /** Zod's {@code invalid_type}: missing, null on a required field, wrong JSON type, unparseable. */
    public static final String INVALID_TYPE = "invalid_type";
    /** Zod's {@code too_small}: below a minimum length or value. */
    public static final String TOO_SMALL = "too_small";
    /** Zod's {@code too_big}: over a maximum length or value, or a decimal over its precision/scale. */
    public static final String TOO_BIG = "too_big";
    /** Zod's {@code invalid_format}: a pattern or format (a malformed date, uuid, e-mail...). */
    public static final String INVALID_FORMAT = "invalid_format";
    /** Zod's {@code invalid_value}: an enum value that is not a member. */
    public static final String INVALID_VALUE = "invalid_value";
    /** Zod's {@code custom}: anything else. */
    public static final String CUSTOM = "custom";

    private final List<Map<String, Object>> issues = new ArrayList<>();

    /** Whether no issue has been collected. */
    public boolean isEmpty() {
        return issues.isEmpty();
    }

    /** Add one issue. */
    public ValidationIssues add(String code, List<?> path, String message) {
        Map<String, Object> issue = new LinkedHashMap<>();
        issue.put("code", code);
        issue.put("path", new ArrayList<Object>(path));
        issue.put("message", message == null ? code : message);
        issues.add(issue);
        return this;
    }

    /** Add one issue about the field {@code field}. */
    public ValidationIssues addField(String code, String field, String message) {
        return add(code, List.of(field), message);
    }

    /**
     * Add every violation of a whole-bean {@code validate}, its path read from the violation
     * (nested value-object members and array indexes included) after {@code prefix}.
     */
    public ValidationIssues addViolations(Collection<? extends ConstraintViolation<?>> violations, Object... prefix) {
        return addViolationsExcept(violations, Set.of(), prefix);
    }

    /** As {@link #addViolations}, skipping a violation whose top-level property is in {@code ignored}. */
    public ValidationIssues addViolationsExcept(
            Collection<? extends ConstraintViolation<?>> violations, Set<String> ignored, Object... prefix) {
        for (ConstraintViolation<?> v : violations) {
            if (ignored.contains(v.getPropertyPath().toString())) continue;
            List<Object> path = new ArrayList<>(Arrays.asList(prefix));
            path.addAll(pathOf(v.getPropertyPath()));
            add(codeOf(v), path, v.getMessage());
        }
        return this;
    }

    /**
     * Add every violation of a single-property {@code validateValue} at exactly {@code path} (the
     * caller knows the wire name; the violation's own path names the escaped record component).
     */
    public ValidationIssues addAt(Collection<? extends ConstraintViolation<?>> violations, Object... path) {
        for (ConstraintViolation<?> v : violations) {
            add(codeOf(v), Arrays.asList(path), v.getMessage());
        }
        return this;
    }

    /** Add everything a patch body failed on. */
    public ValidationIssues addPatchFailure(PatchValidationException failure) {
        for (PatchValidationException.Problem p : failure.problems()) {
            add(p.code(), p.field() == null ? List.of() : List.of(p.field()), p.message());
        }
        return this;
    }

    /** The response body: {@code {"error": "validation", "issues": [...]}}. */
    public Map<String, Object> body() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("error", "validation");
        out.put("issues", issues);
        return out;
    }

    /** The response body with one extra key (the JVM {@code field} key). */
    public Map<String, Object> body(String key, Object value) {
        Map<String, Object> out = body();
        out.put(key, value);
        return out;
    }

    /** A path as wire elements: property names (record-component escape undone) and indexes/keys. */
    static List<Object> pathOf(Path path) {
        List<Object> out = new ArrayList<>();
        for (Path.Node node : path) {
            if (node.isInIterable()) {
                if (node.getIndex() != null) out.add(node.getIndex());
                else if (node.getKey() != null) out.add(String.valueOf(node.getKey()));
            }
            String name = node.getName();
            if (name != null) out.add(RecordComponentNames.unescape(name));
        }
        return out;
    }

    /** The Zod-style code for a Bean Validation violation, from the constraint's annotation. */
    public static String codeOf(ConstraintViolation<?> v) {
        Annotation a = v.getConstraintDescriptor().getAnnotation();
        String name = a.annotationType().getSimpleName();
        Object value = v.getInvalidValue();
        Map<String, Object> attrs = v.getConstraintDescriptor().getAttributes();
        switch (name) {
            case "NotNull":
                return INVALID_TYPE;
            case "NotBlank":
            case "NotEmpty":
                return value == null ? INVALID_TYPE : TOO_SMALL;
            case "Size":
            case "Length": {
                Object max = attrs.get("max");
                Long length = sizeOf(value);
                if (max instanceof Number m && length != null && length > m.longValue()) return TOO_BIG;
                return TOO_SMALL;
            }
            case "Max":
            case "DecimalMax":
            case "Digits":
            case "Negative":
            case "NegativeOrZero":
                return TOO_BIG;
            case "Min":
            case "DecimalMin":
            case "Positive":
            case "PositiveOrZero":
                return TOO_SMALL;
            case "Range": {
                Object max = attrs.get("max");
                if (value instanceof Number n && max instanceof Number m
                        && new BigDecimal(n.toString()).compareTo(new BigDecimal(m.toString())) > 0) return TOO_BIG;
                return TOO_SMALL;
            }
            case "Pattern":
            case "Email":
            case "URL":
                return INVALID_FORMAT;
            default:
                return CUSTOM;
        }
    }

    private static Long sizeOf(Object value) {
        if (value instanceof CharSequence s) return (long) s.length();
        if (value instanceof Collection<?> c) return (long) c.size();
        if (value instanceof Map<?, ?> m) return (long) m.size();
        if (value != null && value.getClass().isArray()) return (long) java.lang.reflect.Array.getLength(value);
        return null;
    }
}
