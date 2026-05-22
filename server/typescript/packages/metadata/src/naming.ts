import type { MetaData } from "./meta/meta-data.js";
import { TYPE_FIELD, TYPE_SOURCE } from "./shared/base-types.js";
import { PACKAGE_SEPARATOR } from "./shared/structural.js";
import { FIELD_ATTR_DB_COLUMN } from "./persistence/db/db-constants.js";
import {
  SOURCE_SUBTYPE_DB_TABLE,
  SOURCE_SUBTYPE_DB_VIEW,
  SOURCE_DB_TABLE_ATTR_NAME,
  SOURCE_ATTR_SCHEMA,
} from "./persistence/source/source-constants.js";

/**
 * Strip the package prefix from a metadata-qualified name
 * (e.g. "pkg::Name" → "Name"). Returns the input unchanged if no
 * package separator is present. Single canonical helper consumed by
 * both find-reference (cross-entity lookup) and codegen-ts (FQN
 * normalization in generated code).
 */
export function stripPackage(name: string | undefined): string {
  if (!name) return "";
  const idx = name.lastIndexOf(PACKAGE_SEPARATOR);
  return idx === -1 ? name : name.slice(idx + PACKAGE_SEPARATOR.length);
}

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

export function resolveTableName(entity: MetaData): string {
  const source = entity.ownChildren().find(
    (c) => c.type === TYPE_SOURCE && c.subType === SOURCE_SUBTYPE_DB_TABLE,
  );
  const name = source?.ownAttr(SOURCE_DB_TABLE_ATTR_NAME);
  if (typeof name === "string" && name !== "") return name;
  return pluralize(toSnakeCase(entity.name));
}

export function resolveColumnName(field: MetaData): string {
  const attr = field.ownAttr(FIELD_ATTR_DB_COLUMN);
  if (typeof attr === "string") return attr;
  return toSnakeCase(field.name);
}

/**
 * Returns the DB schema declared on an entity's source[dbTable] or source[dbView] child,
 * or undefined if no @schema attr is set or no source child exists. Callers decide what
 * "undefined" means for their dialect — Postgres treats it as the default public schema,
 * SQLite treats it as the only allowed value (no schema concept).
 */
export function resolveTableSchema(entity: MetaData): string | undefined {
  const source = entity.ownChildren().find(
    (c) => c.type === TYPE_SOURCE
        && (c.subType === SOURCE_SUBTYPE_DB_TABLE || c.subType === SOURCE_SUBTYPE_DB_VIEW),
  );
  if (!source) return undefined;
  const schema = source.ownAttr(SOURCE_ATTR_SCHEMA);
  if (typeof schema === "string" && schema !== "") return schema;
  return undefined;
}

/** Per-entity {jsName ↔ dbColumn} map. Built once per entity to avoid re-walking children on every row. */
export interface EntityNameMap {
  jsToDb: Map<string, string>;
  dbToJs: Map<string, string>;
}

export function buildNameMap(entity: MetaData): EntityNameMap {
  const jsToDb = new Map<string, string>();
  const dbToJs = new Map<string, string>();
  for (const child of entity.ownChildren()) {
    if (child.type !== TYPE_FIELD) continue;
    const dbCol = resolveColumnName(child);
    jsToDb.set(child.name, dbCol);
    dbToJs.set(dbCol, child.name);
  }
  return { jsToDb, dbToJs };
}
