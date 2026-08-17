// Read/write value coercion at the persistence boundary.
//
//  - SQLite has no native boolean: booleans are stored as 0/1 ints, so we map
//    boolean↔int on the way in/out for that dialect only.
//  - JSONB-backed object/map fields: the driver (node-postgres) does NOT
//    serialize a plain JS object to a jsonb column — it must arrive as a JSON
//    string, or the write fails / writes "[object Object]". A `field.object`
//    (default + `@storage: jsonb`) and any field carrying `@dbColumnType: jsonb`
//    whose value is an object are JSON.stringify'd on write. (Read-back parsing
//    is handled by node-pg's jsonb parser, which returns a parsed object.)
//
// Date/timestamp coercion (ISO string ↔ Date) is deferred: pg accepts ISO
// strings for temporal columns directly, and the temporal read parsers pin the
// wire form.

import type { MetaData } from "@metaobjectsdev/metadata";
import {
  TYPE_FIELD,
  FIELD_SUBTYPE_BOOLEAN,
  FIELD_SUBTYPE_ENUM,
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_STORAGE,
  FIELD_ATTR_DB_COLUMN_TYPE,
  FIELD_ATTR_INT_VALUE_MAP,
  STORAGE_JSONB,
  STORAGE_FLATTENED,
  DB_COLUMN_TYPE_JSONB,
} from "@metaobjectsdev/metadata";
import type { Dialect, Row } from "./persistence-driver.js";

export function coerceRowOnRead(entity: MetaData, row: Row, dialect: Dialect): Row {
  const hydrated = deserializeJsonbObjectFields(entity, row);
  const decoded = decodeIntBackedEnums(entity, hydrated);
  if (dialect !== "sqlite") return decoded;
  return mapBooleansFromInt(entity, decoded);
}

/**
 * The effective `@intValueMap` (member symbol → integer) for an int-backed
 * `field.enum`, or undefined when the enum is string-backed. Its PRESENCE is the
 * whole trigger for integer persistence (design D5) — there is no separate flag.
 *
 * ADR-0039: RESOLVING (`attr`, not `ownAttr`), and load-bearing rather than
 * incidental. Post-#246 an own `@intValueMap` against a shared (root-level
 * abstract) enum is `ERR_ENUM_EXTENDS_VALUES_CONFLICT`, so the map lives on the
 * SHARED DECLARATION and every consuming field INHERITS it — an own-only read
 * would see undefined on exactly the shape adopters are steered toward and bind
 * the symbol straight into an integer column.
 *
 * Mirrors `codegen-ts`'s `intValueMapOf`; duplicated rather than shared because
 * `runtime-ts` must not depend on a codegen package (the two are disjoint trees,
 * and only one of them ships to a server at runtime).
 */
export function intValueMapOf(field: MetaData): Record<string, number> | undefined {
  if (field.subType !== FIELD_SUBTYPE_ENUM) return undefined;
  const raw = field.attr(FIELD_ATTR_INT_VALUE_MAP);
  if (raw === undefined || raw === null || typeof raw !== "object") return undefined;
  return raw as Record<string, number>;
}

/**
 * Encode a member SYMBOL to its declared integer for an int-backed `field.enum`.
 *
 * An UNMAPPED symbol is passed through untouched rather than rejected here: the
 * column's `CHECK` is what enforces membership, and inventing a value would hide
 * the drift. Matching Python's write codec exactly — every port leaves the write
 * side to the database.
 */
function encodeIntBackedEnum(intMap: Record<string, number>, value: unknown): unknown {
  if (typeof value !== "string") return value;
  const stored = intMap[value];
  return typeof stored === "number" ? stored : value;
}

/**
 * Decode the stored integer back to its member symbol, so the runtime's return
 * value is the symbol in both backing modes — int-backing is a persistence-layer
 * concern and must be invisible above this codec (ADR-0019).
 *
 * An int with no member THROWS. The row holds data the model says is impossible
 * (a hand-written INSERT, or a member removed without a migration); surfacing the
 * raw integer would hand the caller a "member" that is not one, and returning
 * null would hide the corruption behind a nullable column. Every port throws
 * here — the generated Drizzle `customType`'s `fromDriver` included.
 */
function decodeIntBackedEnums(entity: MetaData, row: Row): Row {
  let out: Row | null = null;
  // ADR-0039: resolving — an int-backed enum may be inherited from a base via extends.
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    const intMap = intValueMapOf(child);
    if (intMap === undefined) continue;
    if (!(child.name in row)) continue;
    const raw = row[child.name];
    if (raw === null || raw === undefined) continue;
    // A driver may hand back a BIGINT-ish string; Number() covers both shapes.
    const stored = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isInteger(stored)) continue;
    const member = Object.keys(intMap).find((k) => intMap[k] === stored);
    if (member === undefined) {
      throw new Error(
        `field.enum '${child.name}' read stored value ${stored} with no member in ` +
          `@intValueMap (declared: ${JSON.stringify(intMap)}) — the database holds a ` +
          `value the model does not describe.`,
      );
    }
    out ??= { ...row };
    out[child.name] = member;
  }
  return out ?? row;
}

function encodeIntBackedEnums(entity: MetaData, row: Row): Row {
  let out: Row | null = null;
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    const intMap = intValueMapOf(child);
    if (intMap === undefined) continue;
    if (!(child.name in row)) continue;
    const raw = row[child.name];
    if (raw === null || raw === undefined) continue;
    const encoded = encodeIntBackedEnum(intMap, raw);
    if (encoded === raw) continue;
    out ??= { ...row };
    out[child.name] = encoded;
  }
  return out ?? row;
}

export function coerceRowOnWrite(entity: MetaData, row: Row, dialect: Dialect): Row {
  const jsonbColumned = serializeJsonbColumns(entity, row);
  // Dialect-independent: an int-backed enum's column is INTEGER on every dialect
  // (SQLite has one integer storage class), so the symbol→int encode is not gated
  // on the dialect the way the boolean mapping below is.
  const encoded = encodeIntBackedEnums(entity, jsonbColumned);
  if (dialect !== "sqlite") return encoded;
  return mapBooleansToInt(entity, encoded);
}

/**
 * A `field.object` lands in a single JSONB column unless its `@storage` is
 * `flattened` (then it expands to prefixed columns and has no column of its own).
 * Default (no `@storage`) and `@storage: jsonb` both store one jsonb column.
 */
function isJsonbObjectField(child: MetaData): boolean {
  if (child.subType !== FIELD_SUBTYPE_OBJECT) return false;
  // ADR-0039: resolving — @storage may be inherited via extends.
  return child.attr(FIELD_ATTR_STORAGE) !== STORAGE_FLATTENED;
}

/** A field explicitly pinned to a JSONB physical column via `@dbColumnType`.
 *  ADR-0039: @dbColumnType is the ONE deliberately own-only attr (physical
 *  column-type override is never inherited). Keep ownAttr. */
function isJsonbColumnTypeField(child: MetaData): boolean {
  return child.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE) === DB_COLUMN_TYPE_JSONB;
}

function serializeJsonbColumns(entity: MetaData, row: Row): Row {
  let out: Row | null = null;
  // ADR-0039: resolving — a jsonb field may be inherited from a base via extends.
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    if (!isJsonbObjectField(child) && !isJsonbColumnTypeField(child)) continue;
    if (!(child.name in row)) continue;
    const v = row[child.name];
    // Only objects/arrays need stringifying; an already-serialized string passes
    // through unchanged (the existing Asset.payload contract), as does null.
    if (v === null || v === undefined || typeof v !== "object") continue;
    out ??= { ...row };
    out[child.name] = JSON.stringify(v);
  }
  return out ?? row;
}

/**
 * Read-side complement of `serializeJsonbColumns`: a `field.object` jsonb column
 * is the structured-VO storage and must round-trip as a native object (ADR-0019),
 * not the serialized string. node-pg's jsonb parser already returns a parsed
 * object for the postgres driver, so this only acts on a still-stringified value
 * (the in-memory test driver, or any driver that does not parse jsonb) — an
 * already-parsed object/array passes through untouched. Only `field.object`
 * columns are hydrated; a `field.string @dbColumnType: jsonb` stays the raw
 * string it is declared to be. A non-JSON string is left as-is.
 */
function deserializeJsonbObjectFields(entity: MetaData, row: Row): Row {
  let out: Row | null = null;
  // ADR-0039: resolving — a jsonb field may be inherited from a base via extends.
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    if (!isJsonbObjectField(child)) continue;
    if (!(child.name in row)) continue;
    const v = row[child.name];
    if (typeof v !== "string") continue;
    try {
      const parsed = JSON.parse(v);
      out ??= { ...row };
      out[child.name] = parsed;
    } catch {
      // Not JSON — leave the raw string in place.
    }
  }
  return out ?? row;
}

function mapBooleansFromInt(entity: MetaData, row: Row): Row {
  const out: Row = { ...row };
  // Effective children so a TPH subtype coerces inherited boolean fields too.
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    if (child.subType !== FIELD_SUBTYPE_BOOLEAN) continue;
    const v = out[child.name];
    if (v === 0) out[child.name] = false;
    else if (v === 1) out[child.name] = true;
  }
  return out;
}

function mapBooleansToInt(entity: MetaData, row: Row): Row {
  const out: Row = { ...row };
  // Effective children so a TPH subtype coerces inherited boolean fields too.
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    if (child.subType !== FIELD_SUBTYPE_BOOLEAN) continue;
    const v = out[child.name];
    if (v === true) out[child.name] = 1;
    else if (v === false) out[child.name] = 0;
  }
  return out;
}
