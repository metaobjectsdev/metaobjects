package com.metaobjects.generator.spring.runtime;

/**
 * Thrown by a generated {@code <Entity>Patch.fromJson(...)} when a PATCH body fails
 * FR-035 validation — specifically an explicit {@code null} on a {@code @required}
 * field. The generated controller catches it and maps it to the cross-port HTTP 400
 * {@code {"error":"validation"}} envelope.
 */
public final class PatchValidationException extends RuntimeException {

    private final String field;

    public PatchValidationException(String field) {
        super("field '" + field + "' cannot be null");
        this.field = field;
    }

    /** The offending field name. */
    public String field() {
        return field;
    }
}
