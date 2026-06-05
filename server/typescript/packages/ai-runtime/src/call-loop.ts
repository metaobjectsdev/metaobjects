import {
  recordLlmCall,
  type LlmRecorder,
  type LlmCallInput,
  type RecordLlmCallOptions,
  type RecordLlmCallResult,
  type Format,
} from "@metaobjectsdev/runtime-ts";
import type { MetaObject } from "@metaobjectsdev/metadata";
import {
  systemClock,
  uuidIds,
  type Clock,
  type IdGen,
  type LlmClient,
  type LlmRequest,
} from "./client.js";
import { builtinCost, type CostFn } from "./cost.js";

export interface CallLlmInput {
  /** Discriminator / call identity; defaults to the generated entity name. */
  callType: string;
  /** The typed request VO, passed through for call-site traceability. (Not
   *  persisted directly — `request` is what gets logged as llmRequest.) */
  payload: unknown;
  /** What we send to the client (already-rendered prompt + model + params). */
  request: LlmRequest;
  /** Existing trace to attach to; a new trace id is generated when absent. */
  traceId?: string;
  /** Parent span id; absent → this is a root span. */
  parentSpanId?: string;
  /** Logical session/conversation id. */
  sessionId?: string;
}

export interface CallLlmDeps {
  client: LlmClient;
  recorder: LlmRecorder;
  /** MetaObject for the response VO (passed to extract, same as recordLlmCall). */
  responseMo: MetaObject;
  format?: Format;
  cost?: CostFn;
  clock?: Clock;
  ids?: IdGen;
}

/**
 * CALL → PARSE → WRITE. The caller supplies the already-rendered prompt in
 * `input.request.prompt`; callLlm performs the CALL, computes latency/cost/ids,
 * then delegates PARSE+WRITE to recordLlmCall. Finally-style: a client throw
 * still writes an error row and never rethrows into the caller.
 */
export async function callLlm(
  input: CallLlmInput,
  deps: CallLlmDeps,
): Promise<RecordLlmCallResult> {
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? uuidIds;
  const cost = deps.cost ?? builtinCost;

  const spanId = ids.next();
  const traceId = input.traceId ?? ids.next();
  const t0 = clock.now();
  const startedAt = new Date(t0).toISOString();

  let completion: Awaited<ReturnType<LlmClient["complete"]>>;
  try {
    completion = await deps.client.complete(input.request);
  } catch (err) {
    const errorDetail = err instanceof Error ? err.message : String(err);
    // Hand-built error row: the client never returned, so there is no response
    // to extract — we cannot route through recordLlmCall. Its column set mirrors
    // recordLlmCall's row (same keys, null-valued where the call produced nothing).
    const row = {
      spanId,
      traceId,
      parentSpanId: input.parentSpanId ?? null,
      sessionId: input.sessionId ?? null,
      callType: input.callType,
      requestModel: input.request.model,
      responseModel: null,
      inputTokens: null,
      outputTokens: null,
      costMinor: null,
      latencyMs: clock.now() - t0,
      finishReason: null,
      status: "error" as const,
      errorDetail,
      startedAt,
      llmRequest: JSON.stringify(input.request),
      voResponse: null,
    };
    await deps.recorder.record(row);
    return { voResponse: null, status: "error", errorDetail };
  }

  // Build the recordLlmCall input with only the optional fields that are
  // actually present — `exactOptionalPropertyTypes` forbids assigning an
  // explicit `undefined` to an optional `T?` property.
  const recInput: LlmCallInput = {
    spanId,
    traceId,
    callType: input.callType,
    startedAt,
    requestModel: input.request.model,
    latencyMs: clock.now() - t0,
    llmRequest: completion.request ?? input.request,
    llmResponseText: completion.body,
  };
  if (input.parentSpanId !== undefined) recInput.parentSpanId = input.parentSpanId;
  if (input.sessionId !== undefined) recInput.sessionId = input.sessionId;
  if (completion.model !== undefined) recInput.responseModel = completion.model;
  if (completion.usage?.inputTokens !== undefined) recInput.inputTokens = completion.usage.inputTokens;
  if (completion.usage?.outputTokens !== undefined) recInput.outputTokens = completion.usage.outputTokens;
  const costMinor = cost(completion.model ?? input.request.model, completion.usage);
  if (costMinor !== null) recInput.costMinor = costMinor;
  if (completion.finishReason !== undefined) recInput.finishReason = completion.finishReason;

  const recOpts: RecordLlmCallOptions = {
    recorder: deps.recorder,
    responseMo: deps.responseMo,
  };
  if (deps.format !== undefined) recOpts.format = deps.format;
  return recordLlmCall(recInput, recOpts);
}
