// Validator attribute schemas — per-subtype attr inventories for validator types.
// Consumed by registerCoreTypes().

import type { AttrSchema } from "../../registry.js";
import { ATTR_SUBTYPE_INT, ATTR_SUBTYPE_STRING } from "../attr/attr-constants.js";
import { SUBTYPE_BASE } from "../../shared/base-types.js";
import {
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
} from "./validator-constants.js";

/** @min / @max shared by length, numeric, array, and the base validator. */
const minMaxValidatorAttrs: AttrSchema[] = [
  {
    name: VALIDATOR_ATTR_MIN,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Minimum allowed value (length, numeric value, or array element count depending on the validator subtype).",
  },
  {
    name: VALIDATOR_ATTR_MAX,
    valueType: ATTR_SUBTYPE_INT,
    required: false,
    description: "Maximum allowed value (length, numeric value, or array element count depending on the validator subtype).",
  },
];

/** Attrs per validator subtype. Required uses none; regex adds @pattern. */
export const VALIDATOR_ATTRS_MAP = new Map<string, AttrSchema[]>([
  [SUBTYPE_BASE, [...minMaxValidatorAttrs]],
  [VALIDATOR_SUBTYPE_REQUIRED, []],
  [VALIDATOR_SUBTYPE_LENGTH, [...minMaxValidatorAttrs]],
  [VALIDATOR_SUBTYPE_REGEX, [
    ...minMaxValidatorAttrs,
    {
      name: VALIDATOR_ATTR_PATTERN,
      valueType: ATTR_SUBTYPE_STRING,
      required: false,
      description: "Regular expression the value must match.",
    },
  ]],
  [VALIDATOR_SUBTYPE_NUMERIC, [...minMaxValidatorAttrs]],
  [VALIDATOR_SUBTYPE_ARRAY, [...minMaxValidatorAttrs]],
]);
