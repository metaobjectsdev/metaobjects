package com.metaobjects.manager.db.ai;

import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;

/**
 * Convenience entry point for the AI-trace recorder (runtime write path).
 *
 * <p>Java port of the TypeScript {@code recordLlmCall} helper. Builds the base
 * trace row (the 18 {@code LlmCallBase} fields, raw {@code llmRequest}/
 * {@code llmResponse}) and persists it through the supplied {@link LlmCallRecorder}.
 * Generic by design: extraction into a typed {@code voResponse} is the
 * typed/codegen layer (a later slice) — the caller sets {@code voResponse} on the
 * returned row before recording when it has one.</p>
 */
public final class LlmTrace {

    private LlmTrace() {}

    /**
     * Build a base trace row and persist it via {@code recorder}.
     *
     * <p>The returned row is the persisted instance, so a caller that wants to
     * additionally persist a typed {@code voResponse} can set it on the row and
     * record again (or set it before calling, if known up front).</p>
     *
     * @param input    the call fields
     * @param recorder the write-side seam (never-throwing)
     * @param traceMo  the trace entity MetaObject (extends LlmCallBase)
     * @return the built (and recorded) base row
     */
    public static ValueObject recordLlmCall(LlmCallInput input, LlmCallRecorder recorder,
                                            MetaObject traceMo) {
        ValueObject row = LlmTraceRowBuilder.buildLlmCallRow(traceMo, input);
        recorder.record(row);
        return row;
    }
}
