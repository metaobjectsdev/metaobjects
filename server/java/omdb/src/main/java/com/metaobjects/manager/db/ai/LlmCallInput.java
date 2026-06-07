package com.metaobjects.manager.db.ai;

import java.util.Date;

/**
 * The fields of a single LLM call, as supplied by a caller before persistence.
 *
 * <p>Java port of the TypeScript {@code LlmCallInput} carrier
 * (server/typescript/packages/runtime-ts/src/llm-recorder.ts). Mirrors the
 * envelope contract idiomatically: required fields are non-null, optional fields
 * are nullable boxed types. {@code llmRequest} is an arbitrary object that
 * {@link LlmTraceRowBuilder} JSON-stringifies into the generic-jsonb
 * {@code llmRequest} column; {@code llmResponseText} is the raw model text
 * persisted into {@code llmResponse}.</p>
 *
 * <p>The typed {@code voResponse} (the parsed/extracted layer) is NOT part of
 * this carrier — the caller sets it on the built row separately, exactly as the
 * TS reference keeps the typed layer out of {@code buildLlmCallRow}.</p>
 */
public record LlmCallInput(
        String spanId,
        String traceId,
        String parentSpanId,
        String sessionId,
        String callType,
        String system,
        /** When the call was started, supplied by the caller. */
        Date startedAt,
        /** Arbitrary request payload; JSON-stringified into the {@code llmRequest} jsonb column. */
        Object llmRequest,
        /** Raw model response text; stored into the {@code llmResponse} jsonb column. */
        String llmResponseText,
        String requestModel,
        String responseModel,
        Integer inputTokens,
        Integer outputTokens,
        Long costMinor,
        Integer latencyMs,
        String finishReason,
        /** "ok" | "error". */
        String status,
        String errorDetail) {

    /** Status value for a successful call. */
    public static final String STATUS_OK = "ok";
    /** Status value for a failed call. */
    public static final String STATUS_ERROR = "error";
}
