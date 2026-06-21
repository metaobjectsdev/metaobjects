package com.metaobjects.validation;

import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;

import java.util.Collections;
import java.util.List;

/**
 * Thrown when a load surfaces MORE THAN ONE validation finding from the registry-derived
 * reference pass — it carries every {@link ValidationError} so a consumer can report all
 * drift at once (a model with several dangling references reports them all, not just the
 * first). For back-compat it IS-A {@link MetaDataException}: its message/code/envelope are
 * the FIRST error's (so existing catch-and-inspect callers keying on the primary error are
 * unaffected), and the message appends the remaining findings.
 *
 * <p>A single-error load still throws a plain {@link MetaDataException} (unchanged), so the
 * single-finding conformance fixtures are byte-identical.</p>
 */
public final class MetaDataValidationException extends MetaDataException {

    private final transient List<ValidationError> errors;

    public MetaDataValidationException(List<ValidationError> errors) {
        super(joinMessages(errors), codeOf(errors), errors.get(0).source());
        this.errors = List.copyOf(errors);
    }

    /** Every collected finding, in discovery order (first == the back-compat primary). */
    public List<ValidationError> getValidationErrors() {
        return errors != null ? errors : Collections.emptyList();
    }

    private static String joinMessages(List<ValidationError> errors) {
        StringBuilder sb = new StringBuilder();
        sb.append(errors.size()).append(" validation errors:");
        for (ValidationError e : errors) {
            sb.append("\n  - ").append(e.message());
        }
        return sb.toString();
    }

    /** First error's code mapped to the enum; downstream/non-enum codes map to none. */
    private static ErrorCode codeOf(List<ValidationError> errors) {
        try {
            return ErrorCode.valueOf(errors.get(0).code());
        } catch (IllegalArgumentException | NullPointerException ex) {
            return null;
        }
    }
}
