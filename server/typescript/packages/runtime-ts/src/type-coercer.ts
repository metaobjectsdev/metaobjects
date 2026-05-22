// v0.1 only handles SQLite's int↔boolean. Date/timestamp coercion (ISO string ↔ Date) is deferred.

import type { MetaData } from "@metaobjectsdev/metadata";
import { TYPE_FIELD, FIELD_SUBTYPE_BOOLEAN } from "@metaobjectsdev/metadata";
import type { Dialect, Row } from "./persistence-driver.js";

export function coerceRowOnRead(entity: MetaData, row: Row, dialect: Dialect): Row {
  if (dialect !== "sqlite") return row;
  return mapBooleansFromInt(entity, row);
}

export function coerceRowOnWrite(entity: MetaData, row: Row, dialect: Dialect): Row {
  if (dialect !== "sqlite") return row;
  return mapBooleansToInt(entity, row);
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
