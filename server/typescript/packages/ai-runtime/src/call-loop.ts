import {
  buildLlmCallRow,
  persistLlmCallRow,
  type LlmRecorder,
  type LlmCallInput,
  type LlmCallRow,
  type RecordLlmCallResult,
} from "@metaobjectsdev/runtime-ts";
import {
  systemClock,
  uuidIds,
  type Clock,
  type IdGen,
  type LlmClient,
  type LlmRequest,
  type LlmCompletion,
} from "./client.js";
import { builtinCost, type CostFn } from "./cost.js";

export interface RunLlmCallInput {
  /** Discriminator / call identity. */
  callType: string;
  /** Already-rendered request sent to the client. */
  request: LlmRequest;
  /** Existing trace to attach to; a new trace id is generated when absent. */
  traceId?: string;
  parentSpanId?: string;
  sessionId?: string;
}

export interface RunLlmCallDeps {
  client: LlmClient;
  cost?: CostFn;
  clock?: Clock;
  ids?: IdGen;
}

export interface RunLlmCallResult {
  /** Ready-to-persist BASE recorder input (envelope + raw I/O + status). */
  input: LlmCallInput;
  /** Provider completion, or undefined if the client threw. */
  completion?: LlmCompletion;
}

/**
 * Perform the LLM CALL: generate ids, time it, call the client (never-throw),
 * compute cost. Returns a ready base LlmCallInput + the completion. Does NOT
 * persist and does NOT extract — callers do that (callLlm persists the base row;
 * the generated call<Entity> additionally extracts + writes typed voRequest/voResponse).
 */
export async function runLlmCall(
  input: RunLlmCallInput,
  deps: RunLlmCallDeps,
): Promise<RunLlmCallResult> {
  const clock = deps.clock ?? systemClock;
  const ids = deps.ids ?? uuidIds;
  const cost = deps.cost ?? builtinCost;

  const spanId = ids.next();
  const traceId = input.traceId ?? ids.next();
  const t0 = clock.now();
  const startedAt = new Date(t0).toISOString();

  let completion: LlmCompletion | undefined;
  let status: "ok" | "error" = "ok";
  let errorDetail: string | null = null;
  try {
    completion = await deps.client.complete(input.request);
  } catch (err) {
    status = "error";
    errorDetail = err instanceof Error ? err.message : String(err);
  }
  const latencyMs = clock.now() - t0;

  // exactOptionalPropertyTypes: assign optionals only when defined.
  const recInput: LlmCallInput = {
    spanId,
    traceId,
    callType: input.callType,
    startedAt,
    latencyMs,
    requestModel: input.request.model,
    llmRequest: completion?.request ?? input.request,
    llmResponseText: completion?.body ?? "",
    status,
    errorDetail,
  };
  if (input.request.system !== undefined) recInput.system = input.request.system;
  if (input.parentSpanId !== undefined) recInput.parentSpanId = input.parentSpanId;
  if (input.sessionId !== undefined) recInput.sessionId = input.sessionId;
  if (completion?.model !== undefined) recInput.responseModel = completion.model;
  if (completion?.usage?.inputTokens !== undefined) recInput.inputTokens = completion.usage.inputTokens;
  if (completion?.usage?.outputTokens !== undefined) recInput.outputTokens = completion.usage.outputTokens;
  if (completion?.finishReason !== undefined) recInput.finishReason = completion.finishReason;
  if (completion !== undefined) {
    const c = cost(completion.model ?? input.request.model, completion.usage);
    if (c !== null) recInput.costMinor = c;
  }

  return completion !== undefined ? { input: recInput, completion } : { input: recInput };
}

export interface CallLlmDeps extends RunLlmCallDeps {
  recorder: LlmRecorder;
  redact?: (row: LlmCallRow) => LlmCallRow;
}

/**
 * Generic loop: CALL (runLlmCall) → persist the BASE row. No extract, no typed
 * voRequest/voResponse (that's the generated call<Entity>). Finally-style: a
 * client throw still persists an error row and never rethrows.
 */
export async function callLlm(
  input: RunLlmCallInput,
  deps: CallLlmDeps,
): Promise<RecordLlmCallResult> {
  const { input: recInput } = await runLlmCall(input, deps);
  await persistLlmCallRow(
    deps.recorder,
    buildLlmCallRow(recInput),
    deps.redact ? { redact: deps.redact } : undefined,
  );
  return { status: recInput.status, errorDetail: recInput.errorDetail };
}
