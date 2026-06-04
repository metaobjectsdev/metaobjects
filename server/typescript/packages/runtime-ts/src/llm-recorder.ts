// LLM call recorder seam + parse-then-persist helper.
//
// LlmRecorder is a thin write-side interface for persisting LLM call rows.
// LlmCallDbRecorder writes via ObjectManager.create (using an entity declared
// in the caller's own metadata).  NullRecorder is the no-op implementation
// used in unit tests or when tracing is disabled.
//
// recordLlmCall combines the extract step (LLM response text → typed VO via
// the FR-010 extractObject engine) with the persist step in a single
// failure-resilient transaction: a lost-required field still writes a row
// (status="error") so every call is observable.

import type { ObjectManager } from "./object-manager.js";
import { extractSchemaFor } from "./extract-object.js";
import { Format, extract } from "@metaobjectsdev/render";
import type { ExtractOptions } from "@metaobjectsdev/render";
import type { MetaObject } from "@metaobjectsdev/metadata";

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
// recordLlmCall — parse-then-persist
// =============================================================================

export interface LlmCallInput {
  spanId: string;
  traceId: string;
  callType: string;
  /** ISO 8601 timestamp, supplied by the caller before the LLM call was made. */
  startedAt: string;
  llmRequest: unknown;
  llmResponseText: string;
  requestModel?: string;
  inputTokens?: number;
  outputTokens?: number;
  costMinor?: number;
  latencyMs?: number;
  finishReason?: string;
}

export interface RecordLlmCallOptions {
  recorder: LlmRecorder;
  responseMo: MetaObject;
  format?: Format;
  extractOpts?: Partial<ExtractOptions>;
}

export interface RecordLlmCallResult {
  voResponse: Record<string, unknown> | null;
  status: "ok" | "error";
  errorDetail: string | null;
}

/**
 * Parse `input.llmResponseText` into a typed VO, then persist a trace row via
 * `opts.recorder` regardless of whether parsing succeeded.
 *
 * Contract:
 * - A lost-required field → status "error", voResponse null, errorDetail set,
 *   row STILL persisted.
 * - A successful parse → status "ok", voResponse is the plain-object form,
 *   row persisted with voResponse populated.
 * - DB errors propagate (never swallowed).
 */
export async function recordLlmCall(
  input: LlmCallInput,
  opts: RecordLlmCallOptions,
): Promise<RecordLlmCallResult> {
  // Use the lower-level extract() to get a plain Record (no cyclic back-ref).
  // extractSchemaFor builds the field descriptors; extract() runs the engine.
  const schema = extractSchemaFor(opts.responseMo, opts.format ?? Format.JSON);
  const outcome = extract(input.llmResponseText, schema, opts.extractOpts);

  const failed = outcome.report.hasLostRequired();
  const status: "ok" | "error" = failed ? "error" : "ok";
  const errorDetail: string | null = failed
    ? `lost required: ${outcome.report.lostRequired().join(", ")}`
    : null;
  // outcome.data is already a plain Record<string,unknown> — safe to store.
  const voResponse: Record<string, unknown> | null = failed ? null : outcome.data;

  const row: LlmCallRow = {
    spanId: input.spanId,
    traceId: input.traceId,
    callType: input.callType,
    requestModel: input.requestModel ?? null,
    inputTokens: input.inputTokens ?? null,
    outputTokens: input.outputTokens ?? null,
    costMinor: input.costMinor ?? null,
    latencyMs: input.latencyMs ?? null,
    finishReason: input.finishReason ?? null,
    status,
    errorDetail,
    startedAt: input.startedAt,
    llmRequest: JSON.stringify(input.llmRequest),
    voResponse,
  };

  await opts.recorder.record(row);

  return { voResponse, status, errorDetail };
}
