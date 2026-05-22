// Validator concern constants — subtypes and attr keys for the validator.* type family.

import { SUBTYPE_BASE } from "../../shared/base-types.js";

// ---------------------------------------------------------------------------
// Validator subtypes (6)
// ---------------------------------------------------------------------------

export const VALIDATOR_SUBTYPE_REQUIRED = "required";
export const VALIDATOR_SUBTYPE_LENGTH = "length";
export const VALIDATOR_SUBTYPE_REGEX = "regex";
export const VALIDATOR_SUBTYPE_NUMERIC = "numeric";
export const VALIDATOR_SUBTYPE_ARRAY = "array";

export const VALIDATOR_SUBTYPES = [
  SUBTYPE_BASE,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_SUBTYPE_NUMERIC,
  VALIDATOR_SUBTYPE_ARRAY,
] as const;
export type ValidatorSubType = (typeof VALIDATOR_SUBTYPES)[number];

// ---------------------------------------------------------------------------
// Validator attr keys (used by codegen-ts when reading validator children)
// ---------------------------------------------------------------------------

export const VALIDATOR_ATTR_PATTERN = "pattern";
export const VALIDATOR_ATTR_MIN = "min";
export const VALIDATOR_ATTR_MAX = "max";
