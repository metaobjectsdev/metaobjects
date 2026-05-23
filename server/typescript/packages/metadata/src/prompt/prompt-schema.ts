// Reserved-attribute schemas per prompt subtype (FR-004).
//
// The loader's attr-schema pass validates these during load: `required: true`
// attrs missing from a node emit an error; typed attrs coerce/validate by value
// type. References (@payloadRef, @textRef) are plain strings here — resolution
// against a real payload / text source is render-time `verify` scope (Plan #2),
// not load-time validation.

import type { AttrSchema } from "../registry.js";
import {
  ATTR_SUBTYPE_STRING,
  ATTR_SUBTYPE_INT,
  ATTR_SUBTYPE_STRINGARRAY,
} from "../core/attr/attr-constants.js";
import { SUBTYPE_BASE } from "../shared/base-types.js";
import {
  PROMPT_SUBTYPE_TEMPLATE,
  PROMPT_SUBTYPE_FRAGMENT,
  PROMPT_ATTR_PAYLOAD_REF,
  PROMPT_ATTR_TEXT_REF,
  PROMPT_ATTR_OUTPUT_FORMAT,
  PROMPT_ATTR_REQUIRED_SLOTS,
  PROMPT_ATTR_MAX_CHARS,
  PROMPT_ATTR_MAX_TOKENS,
  PROMPT_ATTR_OWNER,
  PROMPT_ATTR_SINCE,
} from "./prompt-constants.js";

const templateAttrs: AttrSchema[] = [
  {
    name: PROMPT_ATTR_PAYLOAD_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description: "Reference to the payload (an object.value projection) this template renders against.",
  },
  {
    name: PROMPT_ATTR_TEXT_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description: "Logical reference (group/source) to the template body text, resolved by a provider at render time.",
  },
  {
    name: PROMPT_ATTR_OUTPUT_FORMAT,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Expected rendered output format, e.g. xml | json | text.",
  },
  {
    name: PROMPT_ATTR_REQUIRED_SLOTS,
    valueType: ATTR_SUBTYPE_STRINGARRAY,
    required: false,
    description: "Slots that must resolve at render time (drives the verify check).",
  },
  {
    name: PROMPT_ATTR_MAX_CHARS,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Size budget for the rendered prompt, in characters.",
  },
  {
    name: PROMPT_ATTR_MAX_TOKENS,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Size budget for the rendered prompt, in tokens.",
  },
  {
    name: PROMPT_ATTR_OWNER,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Governance: the owner of this prompt template.",
  },
  {
    name: PROMPT_ATTR_SINCE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Governance: the version this template was introduced in.",
  },
];

const fragmentAttrs: AttrSchema[] = [
  {
    name: PROMPT_ATTR_TEXT_REF,
    valueType: ATTR_SUBTYPE_STRING,
    required: true,
    description: "Logical reference (group/source) to the fragment body text, resolved by a provider at render time.",
  },
  {
    name: PROMPT_ATTR_OWNER,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Governance: the owner of this fragment.",
  },
  {
    name: PROMPT_ATTR_SINCE,
    valueType: ATTR_SUBTYPE_STRING,
    required: false,
    description: "Governance: the version this fragment was introduced in.",
  },
];

export const PROMPT_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [SUBTYPE_BASE, []],
  [PROMPT_SUBTYPE_TEMPLATE, [...templateAttrs]],
  [PROMPT_SUBTYPE_FRAGMENT, [...fragmentAttrs]],
]);
