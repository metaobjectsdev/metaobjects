package com.metaobjects.render.extract;

import java.util.Objects;

/** Typed result of a generated extractLenient(...): best-effort record (null components where lost/malformed) + report. */
public record ExtractionResult<T>(T data, ExtractionReport report) {
    public ExtractionResult {
        Objects.requireNonNull(report, "report");
    }

    /**
     * Strict opt-in gate (Phase B). Returns {@link #data()} when the extract lost no
     * required field; otherwise throws a {@link ExtractException} naming the lost paths.
     *
     * <p>Extract itself never throws — this is the explicit "treat a lost required field as
     * an error" escape hatch for callers who want it.</p>
     *
     * @return {@link #data()} (may itself be {@code null}/partial for non-required losses)
     * @throws ExtractException iff {@code report().hasLostRequired()}
     */
    public T orThrow() {
        if (report.hasLostRequired()) {
            throw new ExtractException(report.lostRequired());
        }
        return data;
    }
}
