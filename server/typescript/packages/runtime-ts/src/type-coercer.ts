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
  if (dialect !== "sqlite") return row;
  return mapBooleansFromInt(entity, row);
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
  return child.ownAttr(FIELD_ATTR_STORAGE) !== STORAGE_FLATTENED;
}

/** A field explicitly pinned to a JSONB physical column via `@dbColumnType`. */
function isJsonbColumnTypeField(child: MetaData): boolean {
  return child.ownAttr(FIELD_ATTR_DB_COLUMN_TYPE) === DB_COLUMN_TYPE_JSONB;
}

function serializeJsonbColumns(entity: MetaData, row: Row): Row {
  let out: Row | null = null;
  for (const child of entity.ownChildren()) {
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

function mapBooleansFromInt(entity: MetaData, row: Row): Row {
  const out: Row = { ...row };
  for (const child of entity.ownChildren()) {
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
  for (const child of entity.ownChildren()) {
    if (child.type !== TYPE_FIELD) continue;
    if (child.subType !== FIELD_SUBTYPE_BOOLEAN) continue;
    const v = out[child.name];
    if (v === true) out[child.name] = 1;
    else if (v === false) out[child.name] = 0;
  }
  return out;
}
