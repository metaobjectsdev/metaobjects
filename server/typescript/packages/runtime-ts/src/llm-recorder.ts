// LLM call recorder seam + base-row factory + shared persist helper.
//
// LlmRecorder is a thin write-side interface for persisting LLM call rows.
// LlmCallDbRecorder writes via ObjectManager.create (using an entity declared
// in the caller's own metadata).  NullRecorder is the no-op implementation
// used in unit tests or when tracing is disabled.
//
// recordLlmCall is the GENERIC trace path: it builds the base trace row (the
// envelope + the raw `llmRequest`/`llmResponse` columns declared on the shipped
// `LlmCallBase`) and persists it.  It does NOT parse the response into a typed
// VO — that extract step + the typed voRequest/voResponse columns live on the
// generated typed helper (a later layer), so this generic path only ever writes
// the base field set.

import type { ObjectManager } from "./object-manager.js";

// =============================================================================
// Public types
// =============================================================================

export type LlmCallRow = Record<string, unknown>;

export interface LlmRecorder {
  record(call: LlmCallRow): Promise<void>;
}

// =============================================================================
// NullRecorder — no-op (testing / disabled tracing)
// =============================================================================

export class NullRecorder implements LlmRecorder {
  async record(_call: LlmCallRow): Promise<void> {
    // deliberate no-op
  }
}

// =============================================================================
// LlmCallDbRecorder — persists via ObjectManager
// =============================================================================

export class LlmCallDbRecorder implements LlmRecorder {
  private readonly om: ObjectManager;
  private readonly entityName: string;

  constructor(om: ObjectManager, entityName: string) {
    this.om = om;
    this.entityName = entityName;
  }

  async record(call: LlmCallRow): Promise<void> {
    await this.om.create(this.entityName, call);
  }
}

// =============================================================================
// recordLlmCall — generic base-row persist
// =============================================================================

export interface LlmCallInput {
  spanId: string;
  traceId: string;
  /** Parent span id; null/absent → this is a root span. */
  parentSpanId?: string;
  /** Logical session/conversation id (gen_ai session grouping). */
  sessionId?: string;
  callType: string;
  /** gen_ai.system — provider name, caller-supplied. */
  system?: string;
  /** ISO 8601 timestamp, supplied by the caller before the LLM call was made. */
  startedAt: string;
  llmRequest: unknown;
  /** Raw response text/body — stored as the raw `llmResponse` column. */
  llmResponseText: string;
  requestModel?: string;
  /** gen_ai.response.model — the model the provider actually used. */
  responseModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMinor?: number;
  latencyMs?: number;
  finishReason?: string;
  /** Call outcome, caller-supplied (provider/parse failure → "error"). */
  status: "ok" | "error";
  /** Failure detail (null on success). */
  errorDetail: string | null;
}

export interface RecordLlmCallOptions {
  recorder: LlmRecorder;
  /** Optional scrub/cap applied immediately before persist (PII/secrets). */
  redact?: (row: LlmCallRow) => LlmCallRow;
}

export interface RecordLlmCallResult {
  status: "ok" | "error";
  errorDetail: string | null;
}

/** Build the base trace row (envelope + raw llmRequest/llmResponse) — key set
 *  is exactly LlmCallBase's fields. Typed voRequest/voResponse are added by the
 *  generated typed helper, never here. */
export function buildLlmCallRow(input: LlmCallInput): LlmCallRow {
  return {
    traceId: input.traceId,
    spanId: input.spanId,
    parentSpanId: input.parentSpanId ?? null,
    sessionId: input.sessionId ?? null,
    callType: input.callType,
    system: input.system ?? null,
    requestModel: input.requestModel ?? null,
    responseModel: input.responseModel ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    costMinor: input.costMinor ?? null,
    latencyMs: input.latencyMs ?? null,
    finishReason: input.finishReason ?? null,
    status: input.status,
    errorDetail: input.errorDetail,
    startedAt: input.startedAt,
    llmRequest: JSON.stringify(input.llmRequest),
    llmResponse: JSON.stringify(input.llmResponseText),
  };
}

/** Shared persist step: redact then record. Used by recordLlmCall AND (later) the
 *  generated typed helper, so redaction applies on both paths. */
export async function persistLlmCallRow(
  recorder: LlmRecorder,
  row: LlmCallRow,
  opts?: { redact?: (row: LlmCallRow) => LlmCallRow },
): Promise<void> {
  await recorder.record(opts?.redact ? opts.redact(row) : row);
}

/** Persist one base trace row (envelope + raw I/O). Generic — does not extract. */
export async function recordLlmCall(
  input: LlmCallInput,
  opts: RecordLlmCallOptions,
): Promise<RecordLlmCallResult> {
  await persistLlmCallRow(
    opts.recorder,
    buildLlmCallRow(input),
    opts.redact ? { redact: opts.redact } : undefined,
  );
  return { status: input.status, errorDetail: input.errorDetail };
}
