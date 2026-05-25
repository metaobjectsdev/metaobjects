// Naming helpers — case conversion + pluralization for codegen output.
// All functions are pure. The strategy primitives (toSnakeCase, toKebabCase,
// applyColumnNamingStrategy, pluralize, DEFAULT_COLUMN_NAMING_STRATEGY) are
// re-exported from @metaobjectsdev/metadata so codegen + runtime + migrate
// share a single source of truth for how field/table names lower to columns.

import {
  applyColumnNamingStrategy,
  DEFAULT_COLUMN_NAMING_STRATEGY,
  pluralize,
  toKebabCase,
  toSnakeCase,
  type ColumnNamingStrategy,
} from "@metaobjectsdev/metadata";

export { pluralize, toSnakeCase } from "@metaobjectsdev/metadata";

/**
 * Convert snake_case to camelCase. Preserves already-camelCase input.
 */
export function toCamelCase(s: string): string {
  return s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Capitalize the first character of a string (camelCase → PascalCase).
 */
export function toPascalCase(s: string): string {
  return s.length > 0 ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** PascalCase entity → strategy-applied plural for DB table name. */
export function tableNameFromEntity(
  entityName: string,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): string {
  return applyColumnNamingStrategy(pluralize(entityName), strategy);
}

/** camelCase or PascalCase field → strategy-applied DB column name. */
export function columnNameFromField(
  fieldName: string,
  strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY,
): string {
  return applyColumnNamingStrategy(fieldName, strategy);
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
  const sep = strategy === "kebab-case" ? "-" : "_";
  return "v" + sep + applyColumnNamingStrategy(projectionName, strategy);
}

/** PascalCase entity → camelCase plural for the Drizzle table variable. */
export function variableNameFromEntity(entityName: string): string {
  return pluralize(toCamelCase(entityName.charAt(0).toLowerCase() + entityName.slice(1)));
}

// Re-exported here for callers that import from codegen-ts's naming module.
export { toKebabCase };
