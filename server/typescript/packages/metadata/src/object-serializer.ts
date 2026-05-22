// Metadata-driven object serializer.
//
// objectToJson / jsonToObject convert application-object instances <-> JSON
// driven by a MetaObject's field metadata — no per-entity code. Dispatch is on
// each field's DataType. Plain objects in, plain objects out (the caller does
// JSON.parse / JSON.stringify). Best-effort and total: neither function throws
// for malformed instance data, and there is no validation (settled in the
// spec — Java's object reader does not validate either).

import type { MetaData } from "./shared/meta-data.js";
import type { MetaObject } from "./core/object/meta-object.js";
import type { MetaField } from "./core/field/meta-field.js";
import {
  DATA_TYPE_BOOLEAN,
  DATA_TYPE_INT,
  DATA_TYPE_LONG,
  DATA_TYPE_DOUBLE,
  DATA_TYPE_STRING,
  DATA_TYPE_DATE,
  DATA_TYPE_OBJECT,
} from "./data-type.js";
import { TYPE_OBJECT } from "./shared/base-types.js";

const TYPE_DISCRIMINATOR = "@type";

export interface ObjectSerializeOptions {
  /** Emit the `@type` discriminator property. Default true. */
  emitType?: boolean;
}

/** Serialize an application-object instance to wire JSON, driven by `mo`. */
export function objectToJson(
  mo: MetaObject,
  instance: Record<string, unknown>,
  opts?: ObjectSerializeOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (opts?.emitType ?? true) {
    out[TYPE_DISCRIMINATOR] = mo.name;
  }
  for (const field of mo.fields()) {
    const raw = instance[field.name];
    if (raw === undefined) continue; // absent field → omit
    out[field.name] = field.isArray
      ? mapArray(raw, (el) => toJsonValue(field, el, mo))
      : toJsonValue(field, raw, mo);
  }
  return out;
}

/** Parse wire JSON into an application-object instance, driven by `mo`. */
export function jsonToObject(
  mo: MetaObject,
  json: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of mo.fields()) {
    const raw = json[field.name];
    if (raw === undefined) continue;
    out[field.name] = field.isArray
      ? mapArray(raw, (el) => fromJsonValue(field, el, mo))
      : fromJsonValue(field, raw, mo);
  }
  return out;
}

// --- write-side conversion -------------------------------------------------

function toJsonValue(field: MetaField, raw: unknown, mo: MetaObject): unknown {
  switch (field.dataType) {
    case DATA_TYPE_DATE:
      return toIsoString(raw);
    case DATA_TYPE_OBJECT: {
      const target = resolveObjectRef(field, mo);
      if (target === undefined || !isPlainObject(raw)) return raw;
      // Nested objects always carry their own @type (a generic reader needs
      // it); `emitType: false` suppresses only the top-level discriminator.
      return objectToJson(target, raw);
    }
    case DATA_TYPE_BOOLEAN:
    case DATA_TYPE_INT:
    case DATA_TYPE_LONG:
    case DATA_TYPE_DOUBLE:
    case DATA_TYPE_STRING:
    default:
      return raw; // scalars: already JSON-native, pass through
  }
}

// --- read-side conversion --------------------------------------------------

function fromJsonValue(field: MetaField, raw: unknown, mo: MetaObject): unknown {
  switch (field.dataType) {
    case DATA_TYPE_BOOLEAN:
      return coerceBoolean(raw);
    case DATA_TYPE_INT:
    case DATA_TYPE_LONG:
    case DATA_TYPE_DOUBLE:
      return coerceNumeric(raw);
    case DATA_TYPE_OBJECT: {
      const target = resolveObjectRef(field, mo);
      if (target === undefined || !isPlainObject(raw)) return raw;
      return jsonToObject(target, raw);
    }
    case DATA_TYPE_STRING:
    case DATA_TYPE_DATE: // kept as the ISO string; the UI builds its own Date
    default:
      return raw;
  }
}

// --- helpers ---------------------------------------------------------------

function mapArray(raw: unknown, convert: (el: unknown) => unknown): unknown {
  return Array.isArray(raw) ? raw.map(convert) : raw;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function toIsoString(raw: unknown): unknown {
  if (raw instanceof Date) return raw.toISOString();
  if (typeof raw === "number") return new Date(raw).toISOString();
  return raw; // a string passes through; anything else best-effort
}

function coerceBoolean(raw: unknown): unknown {
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return raw;
}

function coerceNumeric(raw: unknown): unknown {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
    return Number(raw);
  }
  return raw;
}

/** Resolve an object-typed field's `@objectRef` to its target MetaObject by
 *  walking to the tree root and looking up the named object child. Returns
 *  undefined when there is no ref or it does not resolve (caller passes the
 *  raw value through — best-effort). */
function resolveObjectRef(field: MetaField, mo: MetaObject): MetaObject | undefined {
  const ref = field.objectRef;
  if (ref === undefined) return undefined;
  const found: MetaData | undefined = mo.root().ownChildByTypeAndName(TYPE_OBJECT, ref);
  if (found === undefined) return undefined;
  return found as MetaObject;
}
