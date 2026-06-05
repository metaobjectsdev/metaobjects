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
