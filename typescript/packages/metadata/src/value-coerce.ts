// value-based attribute type inference (per Java's BaseMetaDataParser)
//
// Design decisions:
//   - Boolean matching is CASE-SENSITIVE ("true"/"false" only; "True"/"FALSE" → string).
//     Java's Boolean.parseBoolean is case-insensitive, but strict matching avoids surprises
//     during round-trip. If relaxed in the future, document the change and update tests.
//   - Integer strings with leading `+` (e.g., "+42") are NOT recognized as numeric — they
//     fall through to string fallback. JSON producers never emit explicit-plus form, so
//     accepting it would only invite ambiguity. Reject intentionally.
//   - Integer range: "int" if |value| <= 2^31 - 1 (Java int range); "long" otherwise.
//   - Long overflow: if the value exceeds Number.MAX_SAFE_INTEGER, store as string verbatim.
//     AttrValue allows string, and bigint is explicitly out of scope.
//   - Arrays: value stored as string[] (not comma-joined string). isArray: true signals the
//     parser/serializer to handle comma-joining for serialization output.
//   - null → throws. Metadata files should never have explicit null attr values.
//   - undefined → throws. Should never arrive from JSON.parse.
//   - Object/plain-object → throws. Not a valid attr value type.

import type { AttrValue } from "./meta/meta-data.js";

export type InferredType = "string" | "int" | "long" | "double" | "boolean";

export interface CoercedValue {
  value: AttrValue;
  inferredType: InferredType;
  isArray: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INT_MAX = 2 ** 31 - 1; // 2147483647
const INT_MIN = -(2 ** 31); // -2147483648

// Regex: integer-shaped string (no decimal point, optional leading minus)
const INT_PATTERN = /^-?\d+$/;

// Regex: decimal-shaped string (must have a decimal point; optional scientific notation)
// Accepts: "3.14", "-2.5", "1.0e10", ".5", "1."
const DOUBLE_PATTERN = /^-?(\d+\.\d*|\d*\.\d+)([eE][+-]?\d+)?$|^-?\d+[eE][+-]?\d+$/;

// ---------------------------------------------------------------------------
// Core function
// ---------------------------------------------------------------------------

export function coerceAttrValue(raw: unknown): CoercedValue {
  // --- Reject invalid input types ---
  if (raw === null) {
    throw new Error("coerceAttrValue: null is not a valid attr value");
  }
  if (raw === undefined) {
    throw new Error("coerceAttrValue: undefined is not a valid attr value");
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    throw new Error(
      `coerceAttrValue: plain object is not a valid attr value (got ${JSON.stringify(raw)})`
    );
  }

  // --- Array ---
  if (Array.isArray(raw)) {
    return coerceArray(raw);
  }

  // --- Native boolean ---
  if (typeof raw === "boolean") {
    return { value: raw, inferredType: "boolean", isArray: false };
  }

  // --- Native number ---
  if (typeof raw === "number") {
    return coerceNativeNumber(raw);
  }

  // --- String: try boolean, then int, then double, else string fallback ---
  if (typeof raw === "string") {
    return coerceString(raw);
  }

  // Anything else (bigint, symbol, function) — treat as unsupported
  throw new Error(`coerceAttrValue: unsupported value type: ${typeof raw}`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function coerceString(s: string): CoercedValue {
  // Boolean (case-sensitive — see module-level design note)
  if (s === "true") return { value: true, inferredType: "boolean", isArray: false };
  if (s === "false") return { value: false, inferredType: "boolean", isArray: false };

  // Integer-shaped
  if (INT_PATTERN.test(s)) {
    return coerceIntString(s);
  }

  // Double-shaped
  if (DOUBLE_PATTERN.test(s)) {
    const parsed = Number(s);
    // Guard against strings that match the pattern but parse to NaN/Infinity (shouldn't happen)
    if (Number.isFinite(parsed)) {
      return { value: parsed, inferredType: "double", isArray: false };
    }
  }

  // String fallback
  return { value: s, inferredType: "string", isArray: false };
}

function coerceIntString(s: string): CoercedValue {
  const parsed = Number(s);

  if (!Number.isSafeInteger(parsed)) {
    // The string exceeds MAX_SAFE_INTEGER — preserve verbatim as string
    return { value: s, inferredType: "long", isArray: false };
  }

  if (parsed >= INT_MIN && parsed <= INT_MAX) {
    return { value: parsed, inferredType: "int", isArray: false };
  }

  // Fits in safe integer but outside Java int range → long, store as number
  return { value: parsed, inferredType: "long", isArray: false };
}

function coerceNativeNumber(n: number): CoercedValue {
  if (!Number.isFinite(n)) {
    throw new Error(`coerceAttrValue: non-finite number is not a valid attr value: ${n}`);
  }

  // Integer-shaped native number
  if (Number.isInteger(n)) {
    if (!Number.isSafeInteger(n)) {
      // Extremely large integer — convert to string to preserve precision
      return { value: String(n), inferredType: "long", isArray: false };
    }
    if (n >= INT_MIN && n <= INT_MAX) {
      return { value: n, inferredType: "int", isArray: false };
    }
    // Safe integer but outside Java int range → long
    return { value: n, inferredType: "long", isArray: false };
  }

  // Non-integer double
  return { value: n, inferredType: "double", isArray: false };
}

function coerceArray(arr: unknown[]): CoercedValue {
  if (arr.length === 0) {
    return { value: [], inferredType: "string", isArray: true };
  }

  // Coerce each element (1-level deep — nested arrays not supported in v0.1)
  const elements = arr.map((el, i) => {
    if (Array.isArray(el)) {
      throw new Error("coerceAttrValue: nested arrays are not supported in v0.1");
    }
    try {
      return coerceAttrValue(el);
    } catch (err) {
      throw new Error(
        `coerceAttrValue: invalid array element at index ${i}: ${(err as Error).message}`
      );
    }
  });

  // Determine element type: homogeneous → use it; mixed → fall back to "string"
  // elements is non-empty here (empty array returned early above)
  const firstType = elements[0]!.inferredType;
  const homogeneous = elements.every((e) => e.inferredType === firstType);
  const inferredType: InferredType = homogeneous ? firstType : "string";

  // Store value as string[] — each element converted to its string representation
  // so that downstream serialization can comma-join as needed.
  const stringValues: string[] = elements.map((e) => String(e.value));

  return { value: stringValues, inferredType, isArray: true };
}
