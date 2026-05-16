// Naming helpers — case conversion + pluralization for codegen output.
// All functions are pure.

import type { ColumnNamingStrategy } from "./metaobjects-config.js";

/**
 * Convert PascalCase or camelCase to snake_case.
 * Treats consecutive capitals (e.g., "APIKey") as a single word: "api_key".
 */
export function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/** Convert PascalCase or camelCase to kebab-case. */
function toKebabCase(s: string): string {
  return toSnakeCase(s).replace(/_/g, "-");
}

/** Apply a ColumnNamingStrategy to a name. */
function applyStrategy(name: string, strategy: ColumnNamingStrategy): string {
  switch (strategy) {
    case "snake_case": return toSnakeCase(name);
    case "literal":    return name;
    case "kebab-case": return toKebabCase(name);
  }
}

/**
 * Convert snake_case to camelCase. Preserves already-camelCase input.
 */
export function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Simple English pluralization. Documented imperfection per design §13 #1:
 * irregular plurals (Person → Persons, not People) are not handled.
 * Users override via source[dbTable]@name in metadata.
 */
export function pluralize(s: string): string {
  if (/(s|x|z|ch|sh)$/i.test(s)) return s + "es";
  if (/[^aeiou]y$/i.test(s)) return s.slice(0, -1) + "ies";
  return s + "s";
}

/** PascalCase entity → strategy-applied plural for DB table name. */
export function tableNameFromEntity(
  entityName: string,
  strategy: ColumnNamingStrategy = "snake_case",
): string {
  return applyStrategy(pluralize(entityName), strategy);
}

/** camelCase or PascalCase field → strategy-applied DB column name. */
export function columnNameFromField(
  fieldName: string,
  strategy: ColumnNamingStrategy = "snake_case",
): string {
  return applyStrategy(fieldName, strategy);
}

/**
 * PascalCase projection name → "v_" prefix + strategy applied (not pluralized).
 * E.g. "ProgramSummary" + snake_case → "v_program_summary".
 * With kebab-case the separator prefix is "v-" to stay consistent.
 */
export function viewNameFromProjection(
  projectionName: string,
  strategy: ColumnNamingStrategy,
): string {
  switch (strategy) {
    case "snake_case": return "v_" + toSnakeCase(projectionName);
    case "literal":    return "v_" + projectionName;
    case "kebab-case": return "v-" + toKebabCase(projectionName);
  }
}

/** PascalCase entity → camelCase plural for the Drizzle table variable. */
export function variableNameFromEntity(entityName: string): string {
  return pluralize(toCamelCase(entityName.charAt(0).toLowerCase() + entityName.slice(1)));
}

/**
 * Strip the package prefix from a metadata-qualified name (e.g.
 * "trainerWebsite::Program" → "Program"). Returns the input unchanged if no
 * package separator is present. Used when consuming @objectRef values that
 * carry the full FQN.
 */
export function stripPackage(name: string): string {
  const idx = name.lastIndexOf("::");
  return idx >= 0 ? name.substring(idx + 2) : name;
}
