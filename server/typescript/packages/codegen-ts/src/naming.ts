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

/** Codegen control over how an entity name lowers to its collection (table)
 *  variable name. Both knobs are project-level codegen config (ADR-0001 —
 *  naming is a per-port codegen concern, NOT a metadata attribute), so they
 *  carry no cross-port conformance cost. */
export interface CollectionNameOptions {
  /** Auto-pluralize the camelCase entity name. Default `true` (e.g.
   *  `AgentConfig` → `agentConfigs`). Set `false` to keep it singular
   *  (`agentConfig`). */
  pluralize?: boolean;
  /** Per-entity exact var-name overrides, keyed by the bare entity name. Wins
   *  over `pluralize` — the escape hatch for the handful of tables a global
   *  rule gets wrong (e.g. `{ AuditLog: "auditLog", LlmTierConfig: "llmTierConfig" }`). */
  overrides?: Record<string, string>;
}

/** PascalCase entity → camelCase Drizzle table variable. Auto-pluralizes by
 *  default; `opts` lets a project turn pluralization off globally and/or pin
 *  exact names per entity. With no `opts` the behavior is the historical
 *  always-pluralize (callers like the relation-resolver that only need the
 *  cosmetic query-API member name pass nothing). */
export function variableNameFromEntity(entityName: string, opts?: CollectionNameOptions): string {
  const override = opts?.overrides?.[entityName];
  if (override !== undefined && override.length > 0) return override;
  const camel = toCamelCase(entityName.charAt(0).toLowerCase() + entityName.slice(1));
  return opts?.pluralize === false ? camel : pluralize(camel);
}

// ---------------------------------------------------------------------------
// Generated CRUD-helper symbol names (single source of truth).
//
// The queries generator (templates/queries.ts) emits one exported async function
// per CRUD verb whose NAME is derived purely from the entity name. These helpers
// are the canonical spelling of those names so anything that needs to REFER to a
// generated symbol (e.g. the api-docs ApiModel builder) derives the exact same
// string the generator emits — no drift, no invented names. The queries template
// itself uses these so the two can never disagree.
// ---------------------------------------------------------------------------

/** Generated read-by-PK helper name: `find<Entity>ById`. */
export function findByIdFnName(entityName: string): string {
  return `find${entityName}ById`;
}

/** Generated list helper name: `list<Plural>` (PascalCase plural). */
export function listFnName(entityName: string): string {
  return `list${pluralize(entityName)}`;
}

/** Generated create helper name: `create<Entity>`. */
export function createFnName(entityName: string): string {
  return `create${entityName}`;
}

/** Generated insert-preserving helper name: `insertPreserving<Entity>` (#203 —
 *  the import/restore/replication escape hatch that writes @autoSet columns
 *  verbatim). Emitted only for entities that declare @autoSet fields. */
export function insertPreservingFnName(entityName: string): string {
  return `insertPreserving${entityName}`;
}

/** Generated update helper name: `update<Entity>`. */
export function updateFnName(entityName: string): string {
  return `update${entityName}`;
}

/** Generated delete-by-PK helper name: `delete<Entity>ById`. */
export function deleteByIdFnName(entityName: string): string {
  return `delete${entityName}ById`;
}

// ---------------------------------------------------------------------------
// ADR-0038 — reverse-relationship navigation as explicit FK finders.
//
// For each FK relationship (entity `E` references entity `T` via an
// `identity.reference` FK field), `E`'s query surface gains a finder returning
// the `E` rows matching a given `T` id. Two variants: a single-value finder and
// a batched (anti-N+1) `…In` finder.
//
// CANONICAL NAMING CONVENTION (the cross-port contract — every port replicates
// this spelling exactly):
//
//   find<EPlural>By<FkField>(value)      → SELECT … FROM E WHERE <fkColumn> = ?
//   find<EPlural>By<FkField>In(values)   → SELECT … FROM E WHERE <fkColumn> IN (…)
//
// where:
//   - <EPlural>  is the source entity name pluralized, PascalCase
//     (`GameSession` → `GameSessions`) — the same spelling `list<Plural>` uses.
//   - <FkField>  is the FK FIELD name (NOT the relationship/navigation name and
//     NOT the raw column), PascalCased, with a single trailing `Id` dropped if
//     present. The FK field name is unique within an entity, so the finder name
//     is unique by construction — this is what dissolves the same-pair collision
//     and removes any need for a naming attribute.
//
// SAME-PAIR EXAMPLE (GameSession has THREE FKs to Scene):
//   FK field `currentSceneId`           → findGameSessionsByCurrentScene
//   FK field `lastOpeningNarrativeSceneId` → findGameSessionsByLastOpeningNarrativeScene
//   FK field `transitioningFromSceneId` → findGameSessionsByTransitioningFromScene
// Three distinct finders — no collision.
// ---------------------------------------------------------------------------

/**
 * Lower an FK field name to the `<FkField>` segment of a reverse finder name:
 * PascalCase the field, then drop a single trailing `Id` if present.
 * E.g. `currentSceneId` → `CurrentScene`, `authorId` → `Author`, `scene` → `Scene`.
 */
export function reverseFinderFkSegment(fkFieldName: string): string {
  const pascal = toPascalCase(toCamelCase(fkFieldName));
  // Drop a single trailing "Id" (but not a bare "Id" — that would yield "").
  return pascal.length > 2 && pascal.endsWith("Id") ? pascal.slice(0, -2) : pascal;
}

/** Generated reverse single-value finder name: `find<EPlural>By<FkField>`. */
export function reverseFinderFnName(sourceEntityName: string, fkFieldName: string): string {
  return `find${pluralize(sourceEntityName)}By${reverseFinderFkSegment(fkFieldName)}`;
}

/** Generated reverse batched finder name: `find<EPlural>By<FkField>In`. */
export function reverseFinderInFnName(sourceEntityName: string, fkFieldName: string): string {
  return `${reverseFinderFnName(sourceEntityName, fkFieldName)}In`;
}

/**
 * Generated Fastify route-registrar name: camelCase `<entity>Routes`. The routes
 * generator (templates/routes-file.ts) emits a single exported
 * `export async function <entity>Routes(fastify)` that mounts the entity's CRUD
 * verb set — this is the symbol an adopter imports to wire the endpoints. Kept
 * here as the single source of truth so the routes template and the api-docs
 * ApiModel builder derive the exact same spelling (no drift).
 */
export function routesHandlerName(entityName: string): string {
  return `${entityName.charAt(0).toLowerCase()}${entityName.slice(1)}Routes`;
}

// Re-exported here for callers that import from codegen-ts's naming module.
export { toKebabCase };
