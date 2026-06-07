package com.metaobjects.manager.db.ai;

/**
 * Write-side seam for persisting an LLM-call trace row.
 *
 * <p>Java port of the TypeScript {@code LlmRecorder} interface
 * (server/typescript/packages/runtime-ts/src/llm-recorder.ts). A {@code row} is a
 * populated trace object (typically a {@code ValueObject} built by
 * {@link LlmTraceRowBuilder}); the typed {@code voResponse} layer, when present,
 * is already set on it by the caller.</p>
 *
 * <p>Implementations MUST be failure-resilient: tracing is observability, never a
 * blocker on the call path, so {@code record} must not throw — see
 * {@link ObjectManagerDbLlmCallRecorder}, which routes persistence failures to an
 * injectable error handler (mirroring the TS never-throw contract).</p>
 */
public interface LlmCallRecorder {

    /**
     * Persist a single trace row. Implementations must not throw on a
     * persistence failure.
     *
     * @param row the populated trace object to persist
     */
    void record(Object row);
}
