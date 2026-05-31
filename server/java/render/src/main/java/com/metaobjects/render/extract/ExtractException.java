package com.metaobjects.render.extract;

import java.util.List;

/**
 * Thrown by {@link ExtractionResult#orThrow()} when a tolerant extract lost one or more
 * fields the schema marked {@code required} (i.e. {@link ExtractionReport#hasLostRequired()}).
 *
 * <p>Extract itself NEVER throws — lost/malformed fields are classified in the
 * {@link ExtractionReport}. {@code orThrow()} is the opt-in strict gate for callers who want a
 * lost required field to be a hard error rather than a best-effort null.</p>
 */
public class ExtractException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final transient List<String> lostRequired;

    public ExtractException(List<String> lostRequired) {
        super("extract lost required field(s): " + lostRequired);
        this.lostRequired = lostRequired == null ? List.of() : List.copyOf(lostRequired);
    }

    /** The dotted paths of the required fields that were lost. */
    public List<String> lostRequired() {
        return lostRequired;
    }
}
