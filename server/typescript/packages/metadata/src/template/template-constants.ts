// template.* subtype vocabulary + reserved attribute names (FR-004, R1).
//
// `template` is the fourth-pillar base type: a renderable text artifact bound to
// a typed payload. Two subtypes (by audience/structure, NOT by format):
//   - prompt: LLM-targeted; carries the prompt-overlay attrs and is the home for
//     future structured-prompt (role/turn/tool) divergence.
//   - output: every other rendered artifact (email, export, docs, config).
//
// Format is the @format ATTRIBUTE (closed set below), never a subtype — the
// render engine keys its escaper off @format, so a new format costs one escaper
// + one enum value, not a new subtype + cross-language port.

import { SUBTYPE_BASE } from "../shared/base-types.js";

export const TEMPLATE_SUBTYPE_PROMPT = "prompt";
export const TEMPLATE_SUBTYPE_OUTPUT = "output";

export const TEMPLATE_SUBTYPES = [
  SUBTYPE_BASE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_SUBTYPE_OUTPUT,
] as const;
export type TemplateSubType = (typeof TEMPLATE_SUBTYPES)[number];

// Generic reserved attrs (both subtypes). The "@" is applied at wire time.
export const TEMPLATE_ATTR_PAYLOAD_REF = "payloadRef";
export const TEMPLATE_ATTR_TEXT_REF = "textRef";
export const TEMPLATE_ATTR_FORMAT = "format";
export const TEMPLATE_ATTR_MAX_CHARS = "maxChars";
export const TEMPLATE_ATTR_OWNER = "owner";
export const TEMPLATE_ATTR_SINCE = "since";

// Prompt-overlay attrs (template.prompt only).
export const TEMPLATE_ATTR_MAX_TOKENS = "maxTokens";
export const TEMPLATE_ATTR_REQUIRED_SLOTS = "requiredSlots";
export const TEMPLATE_ATTR_MODEL = "model";

// Closed format set — escaping/whitespace behavior is keyed off this in the
// render engine's escaper registry (FR-004 R7).
export const TEMPLATE_FORMATS = [
  "text",
  "html",
  "xml",
  "csv",
  "json",
  "markdown",
  "spreadsheet",
] as const;
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number];
