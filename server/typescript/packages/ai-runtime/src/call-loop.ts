import {
  recordLlmCall,
  type LlmRecorder,
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
  /** The typed request VO (logged as llmRequest unless completion.request is set). */
  payload: unknown;
  /** What we send to the client (already-rendered prompt + model + params). */
  request: LlmRequest;
  /** Existing trace to attach to; a new trace id is generated when absent. */
  traceId?: string;
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
    // Hand-built error row — key set must match recordLlmCall's row exactly
    // (14 keys: spanId/traceId/callType/requestModel/inputTokens/outputTokens/
    //  costMinor/latencyMs/finishReason/status/errorDetail/startedAt/llmRequest/voResponse).
    const row = {
      spanId,
      traceId,
      callType: input.callType,
      requestModel: input.request.model,
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

  return recordLlmCall(
    {
      spanId,
      traceId,
      callType: input.callType,
      startedAt,
      llmRequest: completion.request ?? input.request,
      llmResponseText: completion.body,
      requestModel: input.request.model,
      inputTokens: completion.usage?.inputTokens,
      outputTokens: completion.usage?.outputTokens,
      costMinor: cost(completion.model ?? input.request.model, completion.usage) ?? undefined,
      latencyMs: clock.now() - t0,
      finishReason: completion.finishReason,
    },
    { recorder: deps.recorder, responseMo: deps.responseMo, format: deps.format },
  );
}
