package com.metaobjects.manager.db.ai;

/**
 * No-op {@link LlmCallRecorder} for unit tests or when tracing is disabled.
 *
 * <p>Java port of the TypeScript {@code NullRecorder}.</p>
 */
public final class NullLlmCallRecorder implements LlmCallRecorder {

    /** Shared singleton — the recorder holds no state. */
    public static final NullLlmCallRecorder INSTANCE = new NullLlmCallRecorder();

    @Override
    public void record(Object row) {
        // deliberate no-op
    }
}
