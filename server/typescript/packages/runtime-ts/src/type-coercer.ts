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
  FIELD_SUBTYPE_OBJECT,
  FIELD_ATTR_STORAGE,
  FIELD_ATTR_DB_COLUMN_TYPE,
  STORAGE_JSONB,
  STORAGE_FLATTENED,
  DB_COLUMN_TYPE_JSONB,
} from "@metaobjectsdev/metadata";
import type { Dialect, Row } from "./persistence-driver.js";

export function coerceRowOnRead(entity: MetaData, row: Row, dialect: Dialect): Row {
  const hydrated = deserializeJsonbObjectFields(entity, row);
  if (dialect !== "sqlite") return hydrated;
  return mapBooleansFromInt(entity, hydrated);
}

export function coerceRowOnWrite(entity: MetaData, row: Row, dialect: Dialect): Row {
  const jsonbColumned = serializeJsonbColumns(entity, row);
  if (dialect !== "sqlite") return jsonbColumned;
  return mapBooleansToInt(entity, jsonbColumned);
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
