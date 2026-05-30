// template.* subtype vocabulary + reserved attribute names (FR-004, R1; ADR-0011).
//
// `template` is the fourth-pillar base type — a typed payload bound to either
// a rendered text artifact (prompt/output) or to a tool-call envelope.
// Three subtypes:
//   - prompt: LLM-targeted renderable text. Carries the prompt-overlay attrs.
//             Renderable body required via @textRef.
//   - output: every other rendered artifact (email, export, docs, config).
//             Renderable body required via @textRef.
//   - toolcall: LLM tool-call envelope (no renderable body — the body IS the
//               structured output schema resolved via @payloadRef). Per ADR-0011.
//
// Format is the @format ATTRIBUTE (closed set below), never a subtype — the
// render engine keys its escaper off @format, so a new format costs one escaper
// + one enum value, not a new subtype + cross-language port.

import { SUBTYPE_BASE } from "../shared/base-types.js";

export const TEMPLATE_SUBTYPE_PROMPT = "prompt";
export const TEMPLATE_SUBTYPE_OUTPUT = "output";
export const TEMPLATE_SUBTYPE_TOOLCALL = "toolcall";

export const TEMPLATE_SUBTYPES = [
  SUBTYPE_BASE,
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_SUBTYPE_TOOLCALL,
] as const;
export type TemplateSubType = (typeof TEMPLATE_SUBTYPES)[number];

// Generic reserved attrs (prompt + output). The "@" is applied at wire time.
// NOT inherited by toolcall — toolcall has no renderable body.
export const TEMPLATE_ATTR_PAYLOAD_REF = "payloadRef";
export const TEMPLATE_ATTR_TEXT_REF = "textRef";
export const TEMPLATE_ATTR_FORMAT = "format";
export const TEMPLATE_ATTR_MAX_CHARS = "maxChars";
export const TEMPLATE_ATTR_OWNER = "owner";
export const TEMPLATE_ATTR_SINCE = "since";
// Output tags the rendered text must contain (drives the verify output-tag check).
// Generic — not prompt-only: any rendered artifact (email, export, prompt) can
// carry a tag contract a downstream parser depends on.
export const TEMPLATE_ATTR_REQUIRED_TAGS = "requiredTags";

// Prompt-overlay attrs (template.prompt only).
export const TEMPLATE_ATTR_MAX_TOKENS = "maxTokens";
export const TEMPLATE_ATTR_REQUIRED_SLOTS = "requiredSlots";
export const TEMPLATE_ATTR_MODEL = "model";

// Toolcall-specific attrs (template.toolcall only). Vendor-agnostic; vendor
// wire details (retry semantics, fallback shapes, etc.) are added by consumer
// providers via registry.extend per ADR-0011.
//
// @description is intentionally NOT a toolcall-specific constant — every type
// gets @description via the documentation common-attrs provider. Tool
// descriptions surfaced to the LLM use the same @description common attr
// doc-gen uses.
export const TEMPLATE_ATTR_TOOL_NAME = "toolName";

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

// FR-010 artifact-1 prompt presentation style (template.output only). Closed enum;
// guidance is NEVER carried in comments. Default "guide". Set project-wide via an
// abstract template base + extends, with a render-time override on top.
export const TEMPLATE_ATTR_PROMPT_STYLE = "promptStyle";
export const PROMPT_STYLE_GUIDE = "guide";
export const PROMPT_STYLE_INLINE = "inline";
export const PROMPT_STYLE_EXAMPLE_ONLY = "exampleOnly";
export const PROMPT_STYLE_DEFAULT = PROMPT_STYLE_GUIDE;

export const PROMPT_STYLES = [
  PROMPT_STYLE_GUIDE,
  PROMPT_STYLE_INLINE,
  PROMPT_STYLE_EXAMPLE_ONLY,
] as const;
export type PromptStyle = (typeof PROMPT_STYLES)[number];
