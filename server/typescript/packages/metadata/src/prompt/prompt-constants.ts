// prompt.* subtype vocabulary + reserved attribute names (FR-004).
//
// `prompt` is the fourth-pillar base type: LLM prompts as governed metadata.
// Subtypes:
//   - template: a renderable unit bound to one payload, addressed by @textRef.
//   - fragment: a reusable text unit included by templates/fragments.
//
// 2-layer addressing decision (FR-004 Plan #1): @textRef / @payloadRef are
// opaque string references resolved at render time by a provider; this metatype
// does not parse or validate their structure (that is render-engine scope).

import { SUBTYPE_BASE } from "../shared/base-types.js";

export const PROMPT_SUBTYPE_TEMPLATE = "template";
export const PROMPT_SUBTYPE_FRAGMENT = "fragment";

export const PROMPT_SUBTYPES = [
  SUBTYPE_BASE,
  PROMPT_SUBTYPE_TEMPLATE,
  PROMPT_SUBTYPE_FRAGMENT,
] as const;
export type PromptSubType = (typeof PROMPT_SUBTYPES)[number];

// Reserved @-attr names (constant holds the bare name; the "@" is applied at
// wire time, matching the convention used by source/origin attrs).
export const PROMPT_ATTR_PAYLOAD_REF = "payloadRef";
export const PROMPT_ATTR_TEXT_REF = "textRef";
export const PROMPT_ATTR_OUTPUT_FORMAT = "outputFormat";
export const PROMPT_ATTR_REQUIRED_SLOTS = "requiredSlots";
export const PROMPT_ATTR_MAX_CHARS = "maxChars";
export const PROMPT_ATTR_MAX_TOKENS = "maxTokens";
export const PROMPT_ATTR_OWNER = "owner";
export const PROMPT_ATTR_SINCE = "since";
