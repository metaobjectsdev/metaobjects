// Data converter — convert a raw parsed value to a *known* DataType.
//
// The TypeScript counterpart of Java's DataConverter.toTypeSafe: directional
// (toward a type already known from the registered schema), never inferential.
// Replaces the deleted value-coerce.ts. See
// docs/superpowers/specs/2026-05-17-data-converter-design.md.

import type { AttrValue } from "./shared/meta-data.js";
import {
  type DataType,
  DATA_TYPE_BOOLEAN,
  DATA_TYPE_INT,
  DATA_TYPE_LONG,
  DATA_TYPE_DOUBLE,
  DATA_TYPE_OBJECT,
} from "./data-type.js";

/**
 * Convert a raw parsed value to a valid AttrValue for a *known* DataType.
 * Throws for input that cannot be a valid attr value (null / undefined /
 * nested array). A plain object reaching a scalar branch is stringified by
 * `String()` — callers that must reject objects use `toAttrValue`.
 */
export function convertToDataType(dataType: DataType, raw: unknown): AttrValue {
  rejectNullish(raw, "convertToDataType");

  // An array value → string[] regardless of the scalar DataType — the only
  // array shape AttrValue admits (e.g. a stringArray attr).
  if (Array.isArray(raw)) return toStringArray(raw);

  switch (dataType) {
    case DATA_TYPE_BOOLEAN:
      return toBoolean(raw);
    case DATA_TYPE_INT:
    case DATA_TYPE_LONG:
      return toInteger(raw);
    case DATA_TYPE_DOUBLE:
      return toDouble(raw);
    case DATA_TYPE_OBJECT:
      // Object-typed attrs (filter / properties) store the object verbatim.
      // A non-object (e.g. a legacy JSON string) is returned as-is so the
      // attr-schema pass can reject it with ERR_BAD_ATTR_VALUE.
      return (typeof raw === "object" && raw !== null)
        ? (raw as AttrValue)
        : String(raw);
    // string, date (unreachable for attrs) — string form
    default:
      return String(raw);
  }
}

/**
 * Make a raw value a valid AttrValue with NO known type — for an undeclared
 * `@`-attr. No type-directed conversion and no inference: scalars are stored
 * as-is (a numeric-looking string stays a string), arrays become string[],
 * objects/null/undefined are rejected.
 */
export function toAttrValue(raw: unknown): AttrValue {
  rejectNullish(raw, "toAttrValue");
  if (Array.isArray(raw)) return toStringArray(raw);
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return raw;
  }
  throw new Error(`toAttrValue: ${typeof raw} is not a valid attr value`);
}

// --- helpers ---------------------------------------------------------------

function rejectNullish(raw: unknown, fn: string): void {
  if (raw === null) throw new Error(`${fn}: null is not a valid attr value`);
  if (raw === undefined) throw new Error(`${fn}: undefined is not a valid attr value`);
}

function toBoolean(raw: unknown): AttrValue {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Not boolean-shaped — best-effort: leave it for attr-schema validation.
  return raw as AttrValue;
}

function toInteger(raw: unknown): AttrValue {
  if (typeof raw === "number") {
    if (Number.isInteger(raw) && !Number.isSafeInteger(raw)) return String(raw);
    return raw;
  }
  if (typeof raw === "string") {
    // Strict integer string (e.g. "42", "-7").
    if (/^-?\d+$/.test(raw)) {
      const parsed = Number(raw);
      // Beyond MAX_SAFE_INTEGER → keep verbatim to preserve precision.
      return Number.isSafeInteger(parsed) ? parsed : raw;
    }
    // Float-format strings that represent a whole number (e.g. "3.0", "12.0").
    // Metadata files sometimes store int attr values in float notation; convert
    // to the integer value to preserve byte-identical behavior with the old
    // coerceAttrValue, which parsed these via the double pattern.
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && Number.isInteger(parsed) && Number.isSafeInteger(parsed)) {
      return parsed;
    }
  }
  return raw as AttrValue;
}

function toDouble(raw: unknown): AttrValue {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw);
    if (raw.trim() !== "" && Number.isFinite(parsed)) return parsed;
  }
  return raw as AttrValue;
}

function toStringArray(arr: unknown[]): string[] {
  return arr.map((el, i) => {
    if (Array.isArray(el)) {
      throw new Error(`array element at index ${i} is a nested array — not supported`);
    }
    if (el === null || el === undefined) {
      throw new Error(`array element at index ${i} is null/undefined`);
    }
    return String(el);
  });
}
