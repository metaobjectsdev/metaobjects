// Pure function: NEVER throws. ObjectManager wraps a non-ok result in a ValidationError on writes;
// om.validate() returns the result directly.

import type { MetaData } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD, TYPE_VALIDATOR,
  VALIDATOR_SUBTYPE_REQUIRED, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_UUID,
  FIELD_ATTR_REQUIRED, FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_DEFAULT,
  FIELD_ATTR_DB_COLUMN_TYPE, DB_COLUMN_TYPE_JSONB,
  VALIDATOR_ATTR_MIN, VALIDATOR_ATTR_MAX, VALIDATOR_ATTR_PATTERN,
} from "@metaobjectsdev/metadata";
import type { ValidationFailure } from "./errors.js";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: ValidationFailure[] };

// JS-safe numeric fields: must arrive as a JS `number` (they fit in 2^53).
const NUMERIC_FIELD_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_INT,
  FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT,
]);

// 64-bit integer fields (BIGINT on the wire). A full int64 (> 2^53) cannot
// survive a JS `number`, so the write contract additionally accepts a numeric
// `string` or a `bigint` for these — the runtime passes them through unchanged
// so the BIGINT round-trips exactly (read-back is BIGINT→string per
// normalization.md / ADR-0019). `field.currency` is integer minor units → BIGINT.
const INT64_FIELD_SUBTYPES = new Set<string>([
  FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_CURRENCY,
]);

// A base-10 signed integer literal with no fractional/exponent part — the only
// string shape accepted for an int64 field (a "1.5" or "1e3" is rejected).
const INT64_STRING_RE = /^-?\d+$/;

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
    // ADR-0039: effective attr — @default may be inherited via extends.
    const hasDefault = field.attr(FIELD_ATTR_DEFAULT) !== undefined;
    if (required && (value === undefined || value === null)) {
      if (opts.partial && !present) continue;
      // A @default exempts a required field only when it is ABSENT (the DB fills
      // it on insert / an omitted patch key is untouched). It does NOT rescue an
      // EXPLICIT present null — nulling a required field is a deliberate clear the
      // default cannot cover (FR-035 PATCH-2: present-null on @required → error).
      if (hasDefault && !present) continue;
      errors.push({
        field: field.name,
        rule: "required",
        message: `'${field.name}' is required`,
      });
      continue;
    }

    if (value === undefined || value === null) continue;

    // Open-bag jsonb column (`field.string @dbColumnType: jsonb`) holds ANY JSON
    // value, not a string. The write-side coercer (`serializeJsonbColumns`)
    // already expects an object/array here and JSON.stringifies it, so the
    // string type-check + length checks must NOT fire — they would reject the
    // very value the column is declared to hold. Required-ness (above) still
    // applies; everything else is unconstrained for the open bag.
    // ADR-0039: @dbColumnType is the ONE deliberately own-only attr (physical, never inherited).
    if (field.subType === FIELD_SUBTYPE_STRING && field.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE) === DB_COLUMN_TYPE_JSONB) {
      continue;
    }

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

    // ADR-0039: effective children — a validator may be inherited via extends.
    for (const child of field.children()) {
      if (child.type !== TYPE_VALIDATOR) continue;
      if (child.subType !== VALIDATOR_SUBTYPE_REGEX) continue;
      // ADR-0039: effective attr — @pattern may be inherited.
      const pattern = child.attr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern !== "string") continue;
      if (typeof value !== "string") continue;
      let regex: RegExp;
      try {
        // FR-036 Pin 2: validator.regex @pattern is FULL-MATCH — anchor as ^(?:…)$
        // so the runtime OM matches the generated Zod schema's full-match semantic.
        regex = new RegExp(`^(?:${pattern})$`);
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
  // ADR-0039: effective — @required and a required-validator may be inherited via extends.
  if (field.attr(FIELD_ATTR_REQUIRED) === true) return true;
  for (const child of field.children()) {
    if (child.type === TYPE_VALIDATOR && child.subType === VALIDATOR_SUBTYPE_REQUIRED) return true;
  }
  return false;
}

function resolveMaxLength(field: MetaData): number | undefined {
  // ADR-0039: effective — @maxLength and a length-validator may be inherited via extends.
  const attr = field.attr(FIELD_ATTR_MAX_LENGTH);
  if (typeof attr === "number") return attr;
  for (const child of field.children()) {
    if (child.type !== TYPE_VALIDATOR) continue;
    if (child.subType !== VALIDATOR_SUBTYPE_LENGTH) continue;
    const max = child.attr(VALIDATOR_ATTR_MAX);
    if (typeof max === "number") return max;
  }
  return undefined;
}

function resolveMinLength(field: MetaData): number | undefined {
  // ADR-0039: effective — a length-validator may be inherited via extends.
  for (const child of field.children()) {
    if (child.type !== TYPE_VALIDATOR) continue;
    if (child.subType !== VALIDATOR_SUBTYPE_LENGTH) continue;
    const min = child.attr(VALIDATOR_ATTR_MIN);
    if (typeof min === "number") return min;
  }
  return undefined;
}

function checkType(subType: string, value: unknown): string | null {
  if (subType === FIELD_SUBTYPE_STRING || subType === FIELD_SUBTYPE_UUID) {
    if (typeof value !== "string") return `expected string`;
  } else if (NUMERIC_FIELD_SUBTYPES.has(subType)) {
    if (typeof value !== "number") return `expected number`;
  } else if (INT64_FIELD_SUBTYPES.has(subType)) {
    // number (in-band) | bigint | base-10 integer string (full int64 fidelity).
    if (typeof value === "number" || typeof value === "bigint") return null;
    if (typeof value === "string" && INT64_STRING_RE.test(value)) return null;
    return `expected a 64-bit integer (number, bigint, or numeric string)`;
  } else if (subType === FIELD_SUBTYPE_BOOLEAN) {
    if (typeof value !== "boolean") return `expected boolean`;
  }
  return null;
}
