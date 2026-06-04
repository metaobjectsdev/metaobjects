// Pure function: NEVER throws. ObjectManager wraps a non-ok result in a ValidationError on writes;
// om.validate() returns the result directly.

import type { MetaData } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD, TYPE_VALIDATOR,
  VALIDATOR_SUBTYPE_REQUIRED, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
  FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_UUID,
  FIELD_ATTR_REQUIRED, FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_DEFAULT,
  VALIDATOR_ATTR_MIN, VALIDATOR_ATTR_MAX, VALIDATOR_ATTR_PATTERN,
} from "@metaobjectsdev/metadata";
import type { ValidationFailure } from "./errors.js";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationFailure[] };

const NUMERIC_FIELD_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
]);

export interface RunValidatorsOpts {
  /** Partial-update mode: required-checks only fire for fields whose key is present in `data`. */
  partial?: boolean;
}

export function runValidators(
  entity: MetaData,
  data: Record<string, unknown>,
  opts: RunValidatorsOpts = {},
): ValidationResult {
  const errors: ValidationFailure[] = [];

  // Effective children so a TPH subtype validates inherited base fields too.
  for (const field of entity.children()) {
    if (field.type !== TYPE_FIELD) continue;
    const present = Object.prototype.hasOwnProperty.call(data, field.name);
    const value = data[field.name];

    // In partial mode (update), absent keys are "untouched" — only validate fields the caller passed.
    // Fields with a `@default` are also exempt from required-on-insert: the
    // DB will fill them in (e.g. timestamps with `@default: CURRENT_TIMESTAMP`,
    // booleans with `@default: false`).
    const required = isRequired(field);
    const hasDefault = field.ownAttr(FIELD_ATTR_DEFAULT) !== undefined;
    if (required && (value === undefined || value === null)) {
      if (opts.partial && !present) continue;
      if (hasDefault) continue;
      errors.push({
        field: field.name,
        rule: "required",
        message: `'${field.name}' is required`,
      });
      continue;
    }

    if (value === undefined || value === null) continue;

    const typeError = checkType(field.subType, value);
    if (typeError !== null) {
      errors.push({
        field: field.name,
        rule: "type",
        message: typeError,
        expected: field.subType,
        received: typeof value,
      });
      continue;
    }

    const maxLen = resolveMaxLength(field);
    const minLen = resolveMinLength(field);
    if (typeof value === "string") {
      if (maxLen !== undefined && value.length > maxLen) {
        errors.push({
          field: field.name,
          rule: "length",
          message: `'${field.name}' must be at most ${maxLen} chars (got ${value.length})`,
          expected: { max: maxLen },
          received: value.length,
        });
      }
      if (minLen !== undefined && value.length < minLen) {
        errors.push({
          field: field.name,
          rule: "length",
          message: `'${field.name}' must be at least ${minLen} chars (got ${value.length})`,
          expected: { min: minLen },
          received: value.length,
        });
      }
    }

    for (const child of field.ownChildren()) {
      if (child.type !== TYPE_VALIDATOR) continue;
      if (child.subType !== VALIDATOR_SUBTYPE_REGEX) continue;
      const pattern = child.ownAttr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern !== "string") continue;
      if (typeof value !== "string") continue;
      let regex: RegExp;
      try {
        regex = new RegExp(pattern);
      } catch {
        errors.push({
          field: field.name,
          rule: "regex",
          message: `'${field.name}' has an invalid validator pattern: ${pattern}`,
          expected: pattern,
        });
        continue;
      }
      if (!regex.test(value)) {
        errors.push({
          field: field.name,
          rule: "regex",
          message: `'${field.name}' does not match required pattern`,
          expected: pattern,
          received: value,
        });
      }
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function isRequired(field: MetaData): boolean {
  if (field.ownAttr(FIELD_ATTR_REQUIRED) === true) return true;
  for (const child of field.ownChildren()) {
    if (child.type === TYPE_VALIDATOR && child.subType === VALIDATOR_SUBTYPE_REQUIRED) return true;
  }
  return false;
}

function resolveMaxLength(field: MetaData): number | undefined {
  const attr = field.ownAttr(FIELD_ATTR_MAX_LENGTH);
  if (typeof attr === "number") return attr;
  for (const child of field.ownChildren()) {
    if (child.type !== TYPE_VALIDATOR) continue;
    if (child.subType !== VALIDATOR_SUBTYPE_LENGTH) continue;
    const max = child.ownAttr(VALIDATOR_ATTR_MAX);
    if (typeof max === "number") return max;
  }
  return undefined;
}

function resolveMinLength(field: MetaData): number | undefined {
  for (const child of field.ownChildren()) {
    if (child.type !== TYPE_VALIDATOR) continue;
    if (child.subType !== VALIDATOR_SUBTYPE_LENGTH) continue;
    const min = child.ownAttr(VALIDATOR_ATTR_MIN);
    if (typeof min === "number") return min;
  }
  return undefined;
}

function checkType(subType: string, value: unknown): string | null {
  if (subType === FIELD_SUBTYPE_STRING || subType === FIELD_SUBTYPE_UUID) {
    if (typeof value !== "string") return `expected string`;
  } else if (NUMERIC_FIELD_SUBTYPES.has(subType)) {
    if (typeof value !== "number") return `expected number`;
  } else if (subType === FIELD_SUBTYPE_BOOLEAN) {
    if (typeof value !== "boolean") return `expected boolean`;
  }
  return null;
}
