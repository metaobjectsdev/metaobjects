import type { MetaData } from "./shared/meta-data.js";
import { TYPE_FIELD } from "./shared/base-types.js";
import { PACKAGE_SEPARATOR } from "./shared/structural.js";
import { FIELD_ATTR_COLUMN, FIELD_ATTR_DB_COLUMN } from "./persistence/db/db-constants.js";
import {
  SOURCE_ATTR_SCHEMA,
  SOURCE_ROLE_PRIMARY,
} from "./persistence/source/source-constants.js";
import { MetaSource } from "./persistence/source/meta-source.js";

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
  // Primary writable source carries the physical table name (@table).
  const source = entity.ownChildren().find(
    (c): c is MetaSource =>
      c instanceof MetaSource && c.isWritable() && c.role === SOURCE_ROLE_PRIMARY,
  );
  const name = source?.tableName;
  if (typeof name === "string" && name !== "") return name;
  return pluralize(toSnakeCase(entity.name));
}

export function resolveColumnName(field: MetaData): string {
  const col = field.ownAttr(FIELD_ATTR_COLUMN);
  if (typeof col === "string" && col) return col;
  const dbAttr = field.ownAttr(FIELD_ATTR_DB_COLUMN); // dropped in a later task
  if (typeof dbAttr === "string" && dbAttr) return dbAttr;
  return toSnakeCase(field.name);
}

/**
 * Returns the DB schema declared on an entity's primary source child, or undefined
 * when no @schema attr is set or no source child exists. @schema is paradigm-agnostic
 * (works for writable tables and read-only views/projections alike). Callers decide what
 * "undefined" means for their dialect — Postgres treats it as the default public schema,
 * SQLite treats it as the only allowed value (no schema concept).
 */
export function resolveTableSchema(entity: MetaData): string | undefined {
  const source = entity.ownChildren().find(
    (c): c is MetaSource =>
      c instanceof MetaSource && c.role === SOURCE_ROLE_PRIMARY,
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
