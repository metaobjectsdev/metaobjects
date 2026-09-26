package com.metaobjects.render.extract;

import java.util.List;

/**
 * Thrown by {@link ExtractionResult#orThrow()} when a tolerant extract lost, or could not use,
 * one or more fields the schema marked {@code required} (i.e.
 * {@link ExtractionReport#hasLostRequired()} or {@link ExtractionReport#hasMalformedRequired()}).
 *
 * <p>Extract itself NEVER throws — lost/malformed fields are classified in the
 * {@link ExtractionReport}. {@code orThrow()} is the opt-in strict gate for callers who want a
 * lost required field to be a hard error rather than a best-effort null.</p>
 */
public class ExtractException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final transient List<String> lostRequired;
    private final transient List<String> malformedRequired;

    public ExtractException(List<String> lostRequired) {
        this(lostRequired, List.of());
    }

    public ExtractException(List<String> lostRequired, List<String> malformedRequired) {
        super(describe(lostRequired, malformedRequired));
        this.lostRequired = lostRequired == null ? List.of() : List.copyOf(lostRequired);
        this.malformedRequired = malformedRequired == null ? List.of() : List.copyOf(malformedRequired);
    }

    /** A lost-only failure keeps its historical wording; malformed required fields are appended. */
    private static String describe(List<String> lost, List<String> malformed) {
        StringBuilder sb = new StringBuilder();
        if (lost != null && !lost.isEmpty()) sb.append("extract lost required field(s): ").append(lost);
        if (malformed != null && !malformed.isEmpty()) {
            sb.append(sb.length() == 0 ? "extract got malformed required field(s): " : "; malformed required field(s): ")
              .append(malformed);
        }
        return sb.toString();
    }

    /** The dotted paths of the required fields that were lost. */
    public List<String> lostRequired() {
        return lostRequired;
    }

    /** The dotted paths of the required fields present in the reply but unusable (MALFORMED). */
    public List<String> malformedRequired() {
        return malformedRequired;
    }
}
