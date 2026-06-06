// @metaobjectsdev/ai-runtime — LLM call loop + typed-trace recorder adapters.
export const AI_RUNTIME_PACKAGE = "@metaobjectsdev/ai-runtime";

export {
  systemClock,
  uuidIds,
  type LlmClient,
  type LlmRequest,
  type LlmCompletion,
  type LlmUsage,
  type Clock,
  type IdGen,
} from "./client.js";

export { builtinCost, type CostFn } from "./cost.js";

export {
  callLlm,
  runLlmCall,
  type CallLlmDeps,
  type RunLlmCallInput,
  type RunLlmCallDeps,
  type RunLlmCallResult,
} from "./call-loop.js";

export { CompositeRecorder, type CompositeRecorderOpts } from "./composite.js";
