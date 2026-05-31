package com.metaobjects.render.recover;

import java.util.List;

/**
 * Thrown by {@link RecoveryResult#orThrow()} when a tolerant recover lost one or more
 * fields the schema marked {@code required} (i.e. {@link RecoveryReport#hasLostRequired()}).
 *
 * <p>Recover itself NEVER throws — lost/malformed fields are classified in the
 * {@link RecoveryReport}. {@code orThrow()} is the opt-in strict gate for callers who want a
 * lost required field to be a hard error rather than a best-effort null.</p>
 */
public class RecoverException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    private final transient List<String> lostRequired;

    public RecoverException(List<String> lostRequired) {
        super("recover lost required field(s): " + lostRequired);
        this.lostRequired = lostRequired == null ? List.of() : List.copyOf(lostRequired);
    }

    /** The dotted paths of the required fields that were lost. */
    public List<String> lostRequired() {
        return lostRequired;
    }
}
