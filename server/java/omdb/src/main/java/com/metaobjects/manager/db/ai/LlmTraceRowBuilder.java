package com.metaobjects.manager.db.ai;

import com.metaobjects.field.MetaField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.value.ValueObject;

import com.google.gson.Gson;

/**
 * Builds the base trace row for an LLM call, mirroring the TypeScript
 * {@code buildLlmCallRow} (server/typescript/packages/runtime-ts/src/llm-recorder.ts).
 *
 * <p>Given the {@link MetaObject} for a trace entity (one that extends
 * {@code metaobjects::ai::LlmCallBase}) and an {@link LlmCallInput}, returns a
 * {@link ValueObject} with exactly the 18 base {@code LlmCallBase} fields set:
 * {@code traceId, spanId, parentSpanId, sessionId, callType, system,
 * requestModel, responseModel, inputTokens, outputTokens, costMinor, latencyMs,
 * finishReason, status, errorDetail, startedAt, llmRequest, llmResponse}.</p>
 *
 * <p>The raw {@code llmRequest} object is JSON-stringified (the column is generic
 * jsonb); {@code llmResponseText} is stored verbatim into {@code llmResponse}.
 * The typed {@code voResponse} layer is intentionally NOT set here — the caller
 * sets it on the returned row, matching the TS contract.</p>
 *
 * <p>The row is populated through the metadata field SPI
 * ({@code mo.getMetaField(name).set...(row, value)}) so each value is coerced by
 * its declared field subtype.</p>
 */
public final class LlmTraceRowBuilder {

    // Base field names — the LlmCallBase contract (cross-port identical).
    static final String F_TRACE_ID       = "traceId";
    static final String F_SPAN_ID        = "spanId";
    static final String F_PARENT_SPAN_ID = "parentSpanId";
    static final String F_SESSION_ID     = "sessionId";
    static final String F_CALL_TYPE      = "callType";
    static final String F_SYSTEM         = "system";
    static final String F_REQUEST_MODEL  = "requestModel";
    static final String F_RESPONSE_MODEL = "responseModel";
    static final String F_INPUT_TOKENS   = "inputTokens";
    static final String F_OUTPUT_TOKENS  = "outputTokens";
    static final String F_COST_MINOR     = "costMinor";
    static final String F_LATENCY_MS     = "latencyMs";
    static final String F_FINISH_REASON  = "finishReason";
    static final String F_STATUS         = "status";
    static final String F_ERROR_DETAIL   = "errorDetail";
    static final String F_STARTED_AT     = "startedAt";
    static final String F_LLM_REQUEST    = "llmRequest";
    static final String F_LLM_RESPONSE   = "llmResponse";

    /** Shared Gson for stringifying the raw request payload (no metadata adapters needed). */
    private static final Gson GSON = new Gson();

    private LlmTraceRowBuilder() {}

    /**
     * Build a base trace row for {@code input} as an instance of {@code traceMo}.
     *
     * @param traceMo the trace entity MetaObject (extends LlmCallBase)
     * @param input   the call fields
     * @return a populated {@link ValueObject} with the 18 base fields set
     */
    public static ValueObject buildLlmCallRow(MetaObject traceMo, LlmCallInput input) {
        ValueObject row = (ValueObject) traceMo.newInstance();

        setString(traceMo, row, F_TRACE_ID,       input.traceId());
        setString(traceMo, row, F_SPAN_ID,        input.spanId());
        setString(traceMo, row, F_PARENT_SPAN_ID, input.parentSpanId());
        setString(traceMo, row, F_SESSION_ID,     input.sessionId());
        setString(traceMo, row, F_CALL_TYPE,      input.callType());
        setString(traceMo, row, F_SYSTEM,         input.system());
        setString(traceMo, row, F_REQUEST_MODEL,  input.requestModel());
        setString(traceMo, row, F_RESPONSE_MODEL, input.responseModel());
        setInt(traceMo,    row, F_INPUT_TOKENS,   input.inputTokens());
        setInt(traceMo,    row, F_OUTPUT_TOKENS,  input.outputTokens());
        setLong(traceMo,   row, F_COST_MINOR,     input.costMinor());
        setInt(traceMo,    row, F_LATENCY_MS,     input.latencyMs());
        setString(traceMo, row, F_FINISH_REASON,  input.finishReason());
        setString(traceMo, row, F_STATUS,         input.status());
        setString(traceMo, row, F_ERROR_DETAIL,   input.errorDetail());

        // Temporal: set the native Date through the field SPI (coerced by subtype).
        traceMo.getMetaField(F_STARTED_AT).setObject(row, input.startedAt());

        // Raw payloads → generic-jsonb string columns. The request is an arbitrary
        // object (JSON-stringified); the response is stored verbatim.
        setString(traceMo, row, F_LLM_REQUEST,  stringifyRequest(input.llmRequest()));
        setString(traceMo, row, F_LLM_RESPONSE, input.llmResponseText());

        return row;
    }

    /** JSON-stringify an arbitrary request payload; a String passes through unchanged. */
    private static String stringifyRequest(Object request) {
        if (request == null) return null;
        if (request instanceof String s) return s;
        return GSON.toJson(request);
    }

    private static void setString(MetaObject mo, ValueObject row, String field, String value) {
        MetaField mf = mo.getMetaField(field);
        mf.setString(row, value);
    }

    private static void setInt(MetaObject mo, ValueObject row, String field, Integer value) {
        MetaField mf = mo.getMetaField(field);
        mf.setInt(row, value);
    }

    private static void setLong(MetaObject mo, ValueObject row, String field, Long value) {
        MetaField mf = mo.getMetaField(field);
        mf.setLong(row, value);
    }
}
