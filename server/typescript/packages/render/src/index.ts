export { render, type RenderOptions } from "./render.js";
export { type Provider, InMemoryProvider } from "./provider.js";
export { ESCAPERS, type RenderFormat } from "./escapers.js";
export {
  verify,
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_REQUIRED_SLOT_UNUSED,
  ERR_OUTPUT_TAG_MISSING,
  type PayloadField,
  type VerifyError,
  type VerifyOptions,
} from "./verify.js";

// FR-010 tolerant extract engine (Tier-2 forgiving parser).
export { extract } from "./extract/extract.js";
export {
  Format,
  FieldKind,
  FieldExtraction,
  Tolerance,
  ExtractionReport,
  scalar,
  enumField,
  enumArray,
  range,
  object,
  extractSchema,
  defaults,
  orThrow,
  ExtractError,
  type FieldSpec,
  type ExtractSchema,
  type ExtractOptions,
  type ExtractionOutcome,
  type ExtractionResult,
  type Coercion,
  type OnField,
} from "./extract/types.js";
export {
  asString,
  asInt,
  asLong,
  asDouble,
  asBool,
  asStringList,
} from "./extract/extract-map.js";

// FR-010 artifact 1 — output-format prompt renderer ("produce your answer like this").
export { renderOutputFormat } from "./prompt/output-format-renderer.js";
export { PromptStyle, promptStyleFrom } from "./prompt/prompt-style.js";
export {
  PROMPT_OVERRIDES_NONE,
  noOverrides,
  type PromptOverrides,
} from "./prompt/prompt-overrides.js";
export type { OutputFormatSpec } from "./prompt/output-format-spec.js";
export type { PromptField } from "./prompt/prompt-field.js";
