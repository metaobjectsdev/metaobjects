// Pure function: NEVER throws. ObjectManager wraps a non-ok result in a ValidationError on writes;
// om.validate() returns the result directly.

import { isMetaObject, isMetaRoot, type MetaData } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD, TYPE_VALIDATOR,
  VALIDATOR_SUBTYPE_REQUIRED, VALIDATOR_SUBTYPE_LENGTH, VALIDATOR_SUBTYPE_REGEX,
  FIELD_SUBTYPE_STRING, FIELD_SUBTYPE_INT, FIELD_SUBTYPE_LONG,
  FIELD_SUBTYPE_DOUBLE, FIELD_SUBTYPE_FLOAT, FIELD_SUBTYPE_CURRENCY,
  FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_UUID, FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_REQUIRED, FIELD_ATTR_MAX_LENGTH, FIELD_ATTR_DEFAULT,
  FIELD_ATTR_DB_COLUMN_TYPE, DB_COLUMN_TYPE_JSONB, FIELD_ATTR_OBJECT_REF,
  PACKAGE_SEPARATOR, OBJECT_SUBTYPE_VALUE,
  VALIDATOR_ATTR_MIN, VALIDATOR_ATTR_MAX, VALIDATOR_ATTR_PATTERN,
  VALIDATOR_SUBTYPE_NUMERIC, VALIDATOR_SUBTYPE_ARRAY,
  FIELD_SUBTYPE_URI, FIELD_SUBTYPE_INET, FIELD_ATTR_LENIENT,
  IDENTITY_ATTR_FIELDS, IDENTITY_ATTR_GENERATION, GENERATION_INCREMENT, GENERATION_UUID,
} from "@metaobjectsdev/metadata";
import type { ValidationFailure } from "./errors.js";
import { isAbsoluteUri, isInetLiteral } from "./net-format.js";

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
  /**
   * Fields the store fills on insert — a driver-generated primary key. Exempt from
   * required-on-insert when ABSENT, exactly like a `@default` column: `@required` on a
   * server-generated key is a true statement about the ROW, not a demand on the caller.
   * A present null is still a required failure.
   */
  storeFilled?: readonly string[];
}

export function runValidators(
  entity: MetaData,
  data: Record<string, unknown>,
  opts: RunValidatorsOpts = {},
): ValidationResult {
  const errors: ValidationFailure[] = [];
  const assignedPk = assignedPkFieldNames(entity);

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
    // An ASSIGNED primary key must be supplied whatever @required says: nothing else can
    // produce the value. That is presence only — the non-empty-string floor below stays
    // tied to a DECLARED required, as in the generated InsertSchema.
    const mustBePresent = required || assignedPk.has(field.name);
    if (mustBePresent && (value === undefined || value === null)) {
      if (opts.partial && !present) continue;
      // A @default exempts a required field only when it is ABSENT (the DB fills
      // it on insert / an omitted patch key is untouched). It does NOT rescue an
      // EXPLICIT present null — nulling a required field is a deliberate clear the
      // default cannot cover (FR-035 PATCH-2: present-null on @required → error).
      if (hasDefault && !present) continue;
      if (!present && opts.storeFilled?.includes(field.name)) continue;
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

    // Value-object column (`field.object @objectRef`): recurse into the VO's
    // member constraints. A present VO is validated in FULL (never partial) —
    // the generated Zod UpdateSchema embeds the VO InsertSchema, so required
    // members must be present + valid even inside a partial parent update. Both
    // single and @isArray VO columns; each array element is a VO. Keeps the
    // runtime OM byte-identical with the generated validator on nested VO.
    if (field.subType === FIELD_SUBTYPE_OBJECT) {
      const vo = resolveVoRef(field);
      if (vo !== undefined) {
        if (field.resolvedIsArray() && !Array.isArray(value)) {
          errors.push({
            field: field.name, rule: "type",
            message: `'${field.name}' must be an array of ${vo.name}`,
            expected: "array", received: typeof value,
          });
          continue;
        }
        const elements: unknown[] = field.resolvedIsArray() ? (value as unknown[]) : [value];
        if (field.resolvedIsArray()) errors.push(...arraySizeErrors(field, elements.length));
        elements.forEach((el, i) => {
          if (typeof el !== "object" || el === null || Array.isArray(el)) {
            errors.push({
              field: field.name, rule: "type",
              message: `'${field.name}' must be a ${vo.name} object`,
              expected: vo.name, received: el === null ? "null" : typeof el,
            });
            return;
          }
          const sub = runValidators(vo, el as Record<string, unknown>);
          if (!sub.ok) {
            for (const e of sub.errors) {
              errors.push({
                ...e,
                field: field.resolvedIsArray() ? `${field.name}[${i}].${e.field}` : `${field.name}.${e.field}`,
              });
            }
          }
        });
      }
      continue;
    }

    // A scalar array (`field.string isArray`, …) — stored as a native array or a JSON array.
    // Each element is checked against the element rules; an element error names its index,
    // as the value-object branch above does. ADR-0039: resolving `isArray`.
    if (field.resolvedIsArray()) {
      if (!Array.isArray(value)) {
        errors.push({
          field: field.name, rule: "type",
          message: `'${field.name}' must be an array`,
          expected: "array", received: typeof value,
        });
        continue;
      }
      errors.push(...arraySizeErrors(field, value.length));
      value.forEach((el, i) => {
        if (el === null || el === undefined) return;
        errors.push(...scalarErrors(field, el, false, `${field.name}[${i}]`));
      });
      continue;
    }

    errors.push(...scalarErrors(field, value, required, field.name));
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/** Resolve a `field.object`'s `@objectRef` to its value-object MetaData by walking
 *  to the tree root. The ref may be a bare name or a `pkg::Name` FQN. Mirrors the
 *  extract-object resolver. Returns undefined when unresolvable OR when the target
 *  is not an `object.value` (→ no VO recursion). Cross-port parity: C#/Java/Kotlin
 *  gate the recursion on the ref being a value object, so a `field.object @objectRef`
 *  pointing at a non-value object validates identically (skipped) on every port.
 *  ADR-0039: resolving — @objectRef may be inherited via extends. */
function resolveVoRef(field: MetaData): MetaData | undefined {
  const ref = field.attr(FIELD_ATTR_OBJECT_REF);
  if (typeof ref !== "string" || ref.length === 0) return undefined;
  const root = field.root();
  // isMetaRoot, not `instanceof`: under a split @metaobjectsdev/metadata tree the
  // class check fails for a real root and every VO reference silently stops
  // resolving, skipping nested value-object validation with no error.
  if (!isMetaRoot(root)) return undefined;
  let target = root.findObject(ref);
  if (target === undefined) {
    const sep = ref.lastIndexOf(PACKAGE_SEPARATOR);
    if (sep >= 0) target = root.findObject(ref.slice(sep + PACKAGE_SEPARATOR.length));
  }
  return target?.subType === OBJECT_SUBTYPE_VALUE ? target : undefined;
}

function isRequired(field: MetaData): boolean {
  // ADR-0039: effective — @required and a required-validator may be inherited via extends.
  if (field.attr(FIELD_ATTR_REQUIRED) === true) return true;
  for (const child of field.children()) {
    if (child.type === TYPE_VALIDATOR && child.subType === VALIDATOR_SUBTYPE_REQUIRED) return true;
  }
  return false;
}

/** Primary-identity field names the CALLER must supply: the identity carries no
 *  store-side `@generation` (increment / uuid). A `@default` on the field still lets the
 *  caller omit it — the `hasDefault` exemption at the call site covers that. */
function assignedPkFieldNames(entity: MetaData): Set<string> {
  // isMetaObject, not `instanceof` — see resolveVoRef.
  const primary = isMetaObject(entity) ? entity.primaryIdentity() : undefined;
  if (primary === undefined) return new Set();
  // ADR-0039: effective — an identity may be inherited via extends.
  const generation = primary.attr(IDENTITY_ATTR_GENERATION);
  if (generation === GENERATION_INCREMENT || generation === GENERATION_UUID) return new Set();
  const fields = primary.attr(IDENTITY_ATTR_FIELDS);
  if (Array.isArray(fields)) return new Set(fields.map(String));
  return typeof fields === "string" ? new Set([fields]) : new Set();
}

interface Bounds { min?: number; max?: number }

/** The `@min` / `@max` of the field's validators of one subtype (last authored wins). */
function validatorBounds(field: MetaData, validatorSubType: string): Bounds {
  const bounds: Bounds = {};
  // ADR-0039: effective — a validator and its bounds may be inherited via extends.
  for (const child of field.children()) {
    if (child.type !== TYPE_VALIDATOR || child.subType !== validatorSubType) continue;
    const min = child.attr(VALIDATOR_ATTR_MIN);
    const max = child.attr(VALIDATOR_ATTR_MAX);
    if (typeof min === "number") bounds.min = min;
    if (typeof max === "number") bounds.max = max;
  }
  return bounds;
}

/** String length bounds. Max is strictest-wins across `@maxLength` and every
 *  `validator.length @max` (FR-036 A3). Min is the authored `validator.length @min`,
 *  undefined when none was authored. */
function lengthBounds(field: MetaData): Bounds {
  const bounds: Bounds = {};
  // ADR-0039: effective — @maxLength and a length-validator may be inherited via extends.
  const attr = field.attr(FIELD_ATTR_MAX_LENGTH);
  if (typeof attr === "number") bounds.max = attr;
  for (const child of field.children()) {
    if (child.type !== TYPE_VALIDATOR || child.subType !== VALIDATOR_SUBTYPE_LENGTH) continue;
    const min = child.attr(VALIDATOR_ATTR_MIN);
    const max = child.attr(VALIDATOR_ATTR_MAX);
    if (typeof min === "number") bounds.min = min;
    if (typeof max === "number") bounds.max = bounds.max === undefined ? max : Math.min(bounds.max, max);
  }
  return bounds;
}

/** `validator.array @min/@max` — element-count bounds on an array field of any element type. */
function arraySizeErrors(field: MetaData, size: number): ValidationFailure[] {
  const { min, max } = validatorBounds(field, VALIDATOR_SUBTYPE_ARRAY);
  const errors: ValidationFailure[] = [];
  if (min !== undefined && size < min) {
    errors.push({
      field: field.name, rule: "array",
      message: `'${field.name}' must have at least ${min} items (got ${size})`,
      expected: { min }, received: size,
    });
  }
  if (max !== undefined && size > max) {
    errors.push({
      field: field.name, rule: "array",
      message: `'${field.name}' must have at most ${max} items (got ${size})`,
      expected: { max }, received: size,
    });
  }
  return errors;
}

/** The comparable numeric value of a type-checked numeric field value. An int64 arrives
 *  as a number, a bigint or a base-10 integer string; the string compares as an integer. */
function comparable(value: unknown): number | bigint | undefined {
  if (typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "string" && INT64_STRING_RE.test(value)) return BigInt(value);
  return undefined;
}

function checkType(subType: string, value: unknown): string | null {
  if (subType === FIELD_SUBTYPE_STRING || subType === FIELD_SUBTYPE_UUID
      || subType === FIELD_SUBTYPE_URI || subType === FIELD_SUBTYPE_INET) {
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

/**
 * The type, length and regex errors for one scalar value of `field` — the whole field
 * value, or one element of a scalar array (then `required` is false: element presence is not
 * the field's `@required`, and `label` is `name[i]`).
 */
function scalarErrors(field: MetaData, value: unknown, required: boolean, label: string): ValidationFailure[] {
  const errors: ValidationFailure[] = [];
  const typeError = checkType(field.subType, value);
  if (typeError !== null) {
    errors.push({
      field: label,
      rule: "type",
      message: typeError,
      expected: field.subType,
      received: typeof value,
    });
    return errors;
  }

  const { min: minLen, max: maxLen } = lengthBounds(field);
  if (typeof value === "string") {
    if (maxLen !== undefined && value.length > maxLen) {
      errors.push({
        field: label,
        rule: "length",
        message: `'${label}' must be at most ${maxLen} chars (got ${value.length})`,
        expected: { max: maxLen },
        received: value.length,
      });
    }
    // FR-036 Pin 1: a @required string is non-empty by default (an implicit floor of 1),
    // but an explicitly authored `validator.length @min` is ALWAYS authoritative over that
    // floor (#224 / ADR-0044): `@min: 0` opts back to presence-only. Same rule as the
    // generated Zod InsertSchema, so the two enforcement surfaces stay in lockstep.
    const effectiveMin = minLen !== undefined ? minLen : required ? 1 : 0;
    if (effectiveMin > 0 && value.length < effectiveMin) {
      errors.push({
        field: label,
        rule: "length",
        message: `'${label}' must be at least ${effectiveMin} chars (got ${value.length})`,
        expected: { min: effectiveMin },
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
        field: label,
        rule: "regex",
        message: `'${label}' has an invalid validator pattern: ${pattern}`,
        expected: pattern,
      });
      continue;
    }
    if (!regex.test(value)) {
      errors.push({
        field: label,
        rule: "regex",
        message: `'${label}' does not match required pattern`,
        expected: pattern,
        received: value,
      });
    }
  }

  // validator.numeric @min/@max — inclusive value bounds on a numeric field.
  if (NUMERIC_FIELD_SUBTYPES.has(field.subType) || INT64_FIELD_SUBTYPES.has(field.subType)) {
    const num = comparable(value);
    const { min, max } = validatorBounds(field, VALIDATOR_SUBTYPE_NUMERIC);
    if (num !== undefined && min !== undefined && num < min) {
      errors.push({
        field: label, rule: "numeric",
        message: `'${label}' must be at least ${min} (got ${value})`,
        expected: { min }, received: value,
      });
    }
    if (num !== undefined && max !== undefined && num > max) {
      errors.push({
        field: label, rule: "numeric",
        message: `'${label}' must be at most ${max} (got ${value})`,
        expected: { max }, received: value,
      });
    }
  }

  // field.uri / field.inet — the strict format contract, unless @lenient opts out.
  // ADR-0039: effective — @lenient may be inherited via extends.
  if (typeof value === "string" && field.attr(FIELD_ATTR_LENIENT) !== true) {
    if (field.subType === FIELD_SUBTYPE_URI && !isAbsoluteUri(value)) {
      errors.push({
        field: label, rule: "format",
        message: `'${label}' must be an absolute URI`,
        expected: "uri", received: value,
      });
    }
    if (field.subType === FIELD_SUBTYPE_INET && !isInetLiteral(value)) {
      errors.push({
        field: label, rule: "format",
        message: `'${label}' must be an IPv4 or IPv6 address`,
        expected: "inet", received: value,
      });
    }
  }
  return errors;
}
