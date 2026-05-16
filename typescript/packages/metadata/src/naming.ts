import type { MetaModel } from "./meta/meta-data.js";
import {
  TYPE_FIELD, TYPE_SOURCE, FIELD_ATTR_DB_COLUMN,
  SOURCE_SUBTYPE_DB_TABLE, SOURCE_DB_TABLE_ATTR_NAME,
} from "./constants.js";

export function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

export function pluralize(s: string): string {
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + "es";
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + "ies";
  return s + "s";
}

export function resolveTableName(entity: MetaModel): string {
  const source = entity.children().find(
    (c) => c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_DB_TABLE,
  );
  const name = source?.attr(SOURCE_DB_TABLE_ATTR_NAME);
  if (typeof name === "string" && name !== "") return name;
  return pluralize(toSnakeCase(entity.name));
}

export function resolveColumnName(field: MetaModel): string {
  const attr = field.attr(FIELD_ATTR_DB_COLUMN);
  if (typeof attr === "string") return attr;
  return toSnakeCase(field.name);
}

/** Per-entity {jsName ↔ dbColumn} map. Built once per entity to avoid re-walking children on every row. */
export interface EntityNameMap {
  jsToDb: Map<string, string>;
  dbToJs: Map<string, string>;
}

export function buildNameMap(entity: MetaModel): EntityNameMap {
  const jsToDb = new Map<string, string>();
  const dbToJs = new Map<string, string>();
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    const dbCol = resolveColumnName(child);
    jsToDb.set(child.name, dbCol);
    dbToJs.set(dbCol, child.name);
  }
  return { jsToDb, dbToJs };
}
