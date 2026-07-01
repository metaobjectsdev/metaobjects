import type { MetaData } from "./shared/meta-data.js";
import { TYPE_FIELD } from "./shared/base-types.js";
import { PACKAGE_SEPARATOR } from "./shared/structural.js";
import { FIELD_ATTR_COLUMN } from "./persistence/db/db-constants.js";
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

export function toKebabCase(s: string): string {
  return toSnakeCase(s).replace(/_/g, "-");
}

/**
 * Column-naming strategy applied by the persistence layer to fields with no
 * explicit `@column` override. Persistence-layer config (set on
 * ObjectManager / buildExpectedSchema / codegen config), not a metadata attr —
 * the same metadata can drive snake_case (PG convention) or literal (EF
 * convention) consumers. TS port defaults to snake_case; C# port defaults to
 * literal.
 */
export type ColumnNamingStrategy = "snake_case" | "literal" | "kebab-case";

/** Single source of truth for the TS-port default. */
export const DEFAULT_COLUMN_NAMING_STRATEGY: ColumnNamingStrategy = "snake_case";

export function applyColumnNamingStrategy(name: string, strategy: ColumnNamingStrategy): string {
  switch (strategy) {
    case "literal":     return name;
    case "kebab-case":  return toKebabCase(name);
    case "snake_case":  return toSnakeCase(name);
  }
}

export function pluralize(s: string): string {
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + "es";
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + "ies";
  return s + "s";
}

export function resolveTableName(entity: MetaData): string {
  // FR-016: primary source's `physicalName` implements the four-step rule
  // (kind-matching alias → legacy @table → source.name → entity-name fallback),
  // so this helper now just delegates. Writability (table vs view/storedProc/
  // tableFunction) only affects write-routing — for SELECT-side name resolution,
  // a read-only primary source is the right answer.
  //
  // Effective children (own + inherited via the super chain) so a TPH SUBTYPE
  // — which declares no source of its own and inherits the discriminator base's
  // single table (FR-017) — resolves to that base table rather than the
  // entity-name fallback. For an entity declaring its own source, own shadows
  // inherited, so the result is unchanged.
  const source = entity.children().find(
    (c): c is MetaSource => c instanceof MetaSource && c.role === SOURCE_ROLE_PRIMARY,
  );
  if (source !== undefined) return source.physicalName;
  return pluralize(toSnakeCase(entity.name));
}

export function resolveColumnName(
  field: MetaData,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): string {
  // ADR-0039: resolving — a concrete field may inherit @column via extends.
  const col = field.attr(FIELD_ATTR_COLUMN);
  if (typeof col === "string" && col) return col;
  return applyColumnNamingStrategy(field.name, strategy);
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

export function buildNameMap(
  entity: MetaData,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): EntityNameMap {
  const jsToDb = new Map<string, string>();
  const dbToJs = new Map<string, string>();
  // Effective children so a TPH subtype's name map covers inherited base
  // fields + its own (FR-017); own shadows inherited on a name conflict.
  for (const child of entity.children()) {
    if (child.type !== TYPE_FIELD) continue;
    const dbCol = resolveColumnName(child, strategy);
    jsToDb.set(child.name, dbCol);
    dbToJs.set(dbCol, child.name);
  }
  return { jsToDb, dbToJs };
}
