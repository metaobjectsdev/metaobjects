package com.metaobjects.render.recover;

import java.util.Objects;

/** Typed result of a generated recover(...): best-effort record (null components where lost/malformed) + report. */
public record RecoveryResult<T>(T data, RecoveryReport report) {
    public RecoveryResult {
        Objects.requireNonNull(report, "report");
    }

    /**
     * Strict opt-in gate (Phase B). Returns {@link #data()} when the recover lost no
     * required field; otherwise throws a {@link RecoverException} naming the lost paths.
     *
     * <p>Recover itself never throws — this is the explicit "treat a lost required field as
     * an error" escape hatch for callers who want it.</p>
     *
     * @return {@link #data()} (may itself be {@code null}/partial for non-required losses)
     * @throws RecoverException iff {@code report().hasLostRequired()}
     */
    public T orThrow() {
        if (report.hasLostRequired()) {
            throw new RecoverException(report.lostRequired());
        }
        return data;
    }
}
