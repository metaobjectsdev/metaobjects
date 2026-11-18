package com.metaobjects.generator.spring.runtime;

import com.fasterxml.jackson.databind.exc.InvalidFormatException;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Thrown by a generated {@code <Entity>Patch.fromJson(...)} when a PATCH body fails
 * FR-035 validation: an explicit {@code null} on a {@code @required} field, a value that
 * cannot be bound, or a body that is not an object. The generated controller catches it and
 * maps it to the cross-port HTTP 400 {@code {"error":"validation","issues":[...]}} envelope.
 *
 * <p>It carries EVERY problem {@code fromJson} found (not just the first), each with its
 * Zod-style code, plus the values that did bind, so the controller can go on and validate
 * those too and answer one complete list.</p>
 */
public final class PatchValidationException extends RuntimeException {

    /** The field name of a failure that is about the body as a whole (its path is empty). */
    public static final String BODY = "(request body)";

    /** One failure: the field ({@code null} for the body as a whole), its code and message. */
    public record Problem(String field, String code, String message) { }

    private final List<Problem> problems;
    private final Map<String, Object> assigned;

    /** An invalid-type failure of {@code field} ({@link #BODY} for the body as a whole). */
    public PatchValidationException(String field) {
        this(field, "invalid_type", "field '" + field + "' cannot be null");
    }

    /** A failure of {@code field} whose binding raised {@code cause}. */
    public PatchValidationException(String field, Throwable cause) {
        this(field, codeOf(cause), "field '" + field + "' is not a valid value");
    }

    private PatchValidationException(String field, String code, String message) {
        super(message);
        this.problems = List.of(new Problem(BODY.equals(field) ? null : field, code, message));
        this.assigned = Map.of();
    }

    /** Every problem found while binding, and the values that did bind. */
    public PatchValidationException(List<Problem> problems, Map<String, Object> assigned) {
        super("patch body is not valid: " + problems.size() + " problem(s)");
        this.problems = List.copyOf(problems);
        this.assigned = new LinkedHashMap<>(assigned);
    }

    /** Run {@code bind}, adding what it fails on to {@code problems} instead of throwing. */
    public static void collect(List<Problem> problems, Runnable bind) {
        try {
            bind.run();
        } catch (PatchValidationException e) {
            problems.addAll(e.problems);
        }
    }

    /** A new, empty list for {@link #collect}. */
    public static List<Problem> newProblems() {
        return new ArrayList<>();
    }

    /** The first offending field name, or {@code null} when the body as a whole. */
    public String field() {
        return problems.get(0).field();
    }

    /** Every problem. */
    public List<Problem> problems() {
        return problems;
    }

    /** The values that did bind (the failing fields are absent). */
    public Map<String, Object> assignedValues() {
        return assigned;
    }

    /**
     * The Zod-style code for a binding failure: a decimal over its precision/scale or range is
     * {@code too_big}, an unknown enum member {@code invalid_value}, a malformed date/time/uuid/uri
     * {@code invalid_format}, anything else (wrong JSON type, unparseable) {@code invalid_type}.
     */
    public static String codeOf(Throwable failure) {
        for (Throwable t = failure; t != null; t = t.getCause() == t ? null : t.getCause()) {
            if (t instanceof CanonicalDecimal.InvalidDecimalException d) return d.code();
            if (t instanceof InvalidFormatException f) {
                Class<?> target = f.getTargetType();
                if (target != null) {
                    if (target.isEnum()) return "invalid_value";
                    String n = target.getName();
                    if (n.startsWith("java.time.") || n.equals("java.util.UUID") || n.equals("java.net.URI")
                            || n.equals("java.net.URL") || n.equals("java.util.Date")) {
                        return "invalid_format";
                    }
                }
                String m = f.getMessage();
                if (m != null && (m.contains("decimal does not fit decimal(") || m.contains(": decimal out of range: "))) {
                    return "too_big";
                }
            }
        }
        return "invalid_type";
    }
}
