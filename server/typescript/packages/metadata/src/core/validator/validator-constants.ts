// Validator concern constants — subtypes and attr keys for the validator.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Validator subtypes (10)
// ---------------------------------------------------------------------------

export const VALIDATOR_SUBTYPE_REQUIRED = "required";
export const VALIDATOR_SUBTYPE_LENGTH = "length";
export const VALIDATOR_SUBTYPE_REGEX = "regex";
export const VALIDATOR_SUBTYPE_NUMERIC = "numeric";
export const VALIDATOR_SUBTYPE_ARRAY = "array";
// Cross-field validators — entity-scoped, reference sibling fields by name.
export const VALIDATOR_SUBTYPE_COMPARISON = "comparison";
export const VALIDATOR_SUBTYPE_REQUIRED_WHEN = "requiredWhen";
export const VALIDATOR_SUBTYPE_PRESENT_IFF = "presentIff";
export const VALIDATOR_SUBTYPE_AT_LEAST_ONE = "atLeastOne";

export const VALIDATOR_SUBTYPES = [
  SUBTYPE_BASE,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
  VALIDATOR_SUBTYPE_COMPARISON,
  VALIDATOR_SUBTYPE_REQUIRED_WHEN,
  VALIDATOR_SUBTYPE_PRESENT_IFF,
  VALIDATOR_SUBTYPE_AT_LEAST_ONE,
] as const;
export type ValidatorSubType = (typeof VALIDATOR_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Validator attr keys (used by codegen-ts when reading validator children)
// ---------------------------------------------------------------------------

export const VALIDATOR_ATTR_PATTERN = "pattern";
export const VALIDATOR_ATTR_MIN = "min";
export const VALIDATOR_ATTR_MAX = "max";
// Cross-field validator attrs (field references by name + operator/value).
export const VALIDATOR_ATTR_LEFT = "left";
export const VALIDATOR_ATTR_OP = "op";
export const VALIDATOR_ATTR_RIGHT = "right";
export const VALIDATOR_ATTR_FIELD = "field";
export const VALIDATOR_ATTR_WHEN = "when";
export const VALIDATOR_ATTR_EQUALS = "equals";
export const VALIDATOR_ATTR_FIELDS = "fields";

// Comparison operators (@op allowed values) → relational operator.
export const VALIDATOR_COMPARISON_OPS = ["gt", "gte", "lt", "lte", "ne", "eq"] as const;
export type ComparisonOp = (typeof VALIDATOR_COMPARISON_OPS)[number];
