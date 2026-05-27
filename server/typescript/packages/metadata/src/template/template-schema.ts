// Reserved-attribute schemas per template subtype (FR-004, R1).
//
// Both subtypes share the generic attrs; @format is a closed enum (allowedValues)
// that the render engine keys its escaper off. template.prompt additionally
// carries the LLM-overlay attrs. References (@payloadRef, @textRef) are plain
// strings here — resolution against a real payload / text source is render-time
// `verify` scope (Plan #3), not load-time validation.

import type { AttrSchema } from "../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_STRINGARRAY,
} from "../core/attr/attr-constants.js";
import { SUBTYPE_BASE } from "../shared/base-types.js";
import {
  TEMPLATE_SUBTYPE_PROMPT,
  TEMPLATE_SUBTYPE_OUTPUT,
  TEMPLATE_SUBTYPE_TOOLCALL,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_MAX_CHARS,
  TEMPLATE_ATTR_OWNER,
  TEMPLATE_ATTR_SINCE,
  TEMPLATE_ATTR_REQUIRED_TAGS,
  TEMPLATE_ATTR_MAX_TOKENS,
  TEMPLATE_ATTR_REQUIRED_SLOTS,
  TEMPLATE_ATTR_MODEL,
  TEMPLATE_ATTR_TOOL_NAME,
  TEMPLATE_FORMATS,
} from "./template-constants.js";

// Generic attrs shared by template.prompt and template.output.
const genericAttrs: AttrSchema[] = [
  {
    name: TEMPLATE_ATTR_PAYLOAD_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description: "Reference to the payload (a view-object / projection) this template renders against.",
  },
  {
    name: TEMPLATE_ATTR_TEXT_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description: "2-layer logical reference (group/source) to the body text, resolved by a provider at render time.",
  },
  {
    name: TEMPLATE_ATTR_FORMAT,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    default: "text",
    allowedValues: [...TEMPLATE_FORMATS],
    description: "Output format; drives the render engine's escaping/whitespace behavior.",
  },
  {
    name: TEMPLATE_ATTR_MAX_CHARS,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Size budget for the rendered output, in characters.",
  },
  {
    name: TEMPLATE_ATTR_OWNER,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Governance: the owner of this template.",
  },
  {
    name: TEMPLATE_ATTR_SINCE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Governance: the version this template was introduced in.",
  },
  {
    name: TEMPLATE_ATTR_REQUIRED_TAGS,
    valueType: ATTR_SUBTYPE_STRINGARRAY,
    required: false,
    description: "Output tags the rendered text must contain (drives the verify output-tag check).",
  },
];

// LLM-overlay attrs (template.prompt only).
const promptOverlayAttrs: AttrSchema[] = [
  {
    name: TEMPLATE_ATTR_MAX_TOKENS,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Token budget for the rendered prompt (LLM-specific).",
  },
  {
    name: TEMPLATE_ATTR_REQUIRED_SLOTS,
    valueType: ATTR_SUBTYPE_STRINGARRAY,
    required: false,
    description: "Slots that must resolve at render time (drives the verify check).",
  },
  {
    name: TEMPLATE_ATTR_MODEL,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Target model id (LLM-specific).",
  },
];

// Toolcall attrs (template.toolcall only — does NOT inherit genericAttrs).
// Per ADR-0011: vendor-agnostic in core; vendor wire details (retry semantics,
// fallback shapes, parallel invocation, cache hints) added by consumer
// providers via registry.extend(TYPE_TEMPLATE, "toolcall", { attributes: [...] }).
//
// Critical: @textRef is intentionally NOT required here. A tool-call has no
// renderable text body — the body IS the structured output schema resolved
// via @payloadRef. This is the design rationale for toolcall being its own
// subtype rather than template.output + @toolName.
//
// @description is intentionally NOT declared here — it's already a documentation
// common attr added to every type by docProvider. Tool descriptions surfaced to
// the LLM read the same @description common attr that doc-gen uses.
const toolcallAttrs: AttrSchema[] = [
  {
    name: TEMPLATE_ATTR_TOOL_NAME,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description: "Wire tool name surfaced to the LLM (vendor-specific format).",
  },
  {
    name: TEMPLATE_ATTR_PAYLOAD_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description: "Output value-object the tool produces (resolved against the metamodel).",
  },
  {
    name: TEMPLATE_ATTR_OWNER,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Governance: the owner of this toolcall.",
  },
  {
    name: TEMPLATE_ATTR_SINCE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Governance: the version this toolcall was introduced in.",
  },
];

export const TEMPLATE_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [SUBTYPE_BASE, []],
  [TEMPLATE_SUBTYPE_PROMPT, [...genericAttrs, ...promptOverlayAttrs]],
  [TEMPLATE_SUBTYPE_OUTPUT, [...genericAttrs]],
  [TEMPLATE_SUBTYPE_TOOLCALL, [...toolcallAttrs]],
]);
