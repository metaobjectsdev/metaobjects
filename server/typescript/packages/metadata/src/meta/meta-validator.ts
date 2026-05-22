// MetaValidator — concrete node class for type=validator nodes.
// Subtype classes (Required, Length, Regex, Numeric, Array) are co-located.
//
// Extends MetaData directly: no model wrapper, no metaOf() indirection.

import { MetaData } from "./meta-data.js";
import {
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_ATTR_PATTERN,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
} from "../core/validator/validator-constants.js";

export class MetaValidator extends MetaData {
  /**
   * Numeric range — shared by length, numeric, and array validators.
   * (Pattern moves to MetaRegexValidator; required validators have no extra attrs.)
   */
  get min(): number | undefined {
    const v = this.ownAttr(VALIDATOR_ATTR_MIN);
    return typeof v === "number" ? v : undefined;
  }

  get max(): number | undefined {
    const v = this.ownAttr(VALIDATOR_ATTR_MAX);
    return typeof v === "number" ? v : undefined;
  }

  isRequired(): boolean {
    return this.subType === VALIDATOR_SUBTYPE_REQUIRED;
  }

  isLength(): boolean {
    return this.subType === VALIDATOR_SUBTYPE_LENGTH;
  }

  isRegex(): boolean {
    return this.subType === VALIDATOR_SUBTYPE_REGEX;
  }
}

/** Required validator (no extra attrs; subtype class exists for instanceof narrowing). */
export class MetaRequiredValidator extends MetaValidator {}

/** Length validator: min/max are string/array length bounds. */
export class MetaLengthValidator extends MetaValidator {}

/** Regex validator: carries the pattern. */
export class MetaRegexValidator extends MetaValidator {
  get pattern(): string | undefined {
    const v = this.ownAttr(VALIDATOR_ATTR_PATTERN);
    return typeof v === "string" ? v : undefined;
  }
}

/** Numeric validator: min/max are value bounds. */
export class MetaNumericValidator extends MetaValidator {}

/** Array validator: min/max are element-count bounds. */
export class MetaArrayValidator extends MetaValidator {}
