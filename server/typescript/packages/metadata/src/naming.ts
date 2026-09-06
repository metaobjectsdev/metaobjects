import type { MetaData } from "./shared/meta-data.js";
import { TYPE_FIELD } from "./shared/base-types.js";
import { PACKAGE_SEPARATOR } from "./shared/structural.js";
import { FIELD_ATTR_COLUMN } from "./persistence/db/db-constants.js";
import {
  SOURCE_ATTR_SCHEMA,
  SOURCE_ROLE_PRIMARY,
} from "./persistence/source/source-constants.js";
import type { MetaSource } from "./persistence/source/meta-source.js";
// isMetaSource, not `instanceof`: unlike the loader-internal validators, the source
// lookups below are EXPORTED helpers that run on a caller-supplied node — migrate-ts
// calls them on nodes the CLI's loader built. Under a split @metaobjectsdev/metadata
// tree the class check would be false for a real primary source, and resolveTableName
// would silently fall through to the entity-name fallback: a DIFFERENT table name,
// which migrate then emits as a rename against a live database. (The same split would
// also make the divergence refusal see no primaries at all, and say nothing.)
import { isMetaSource } from "./shared/node-guards.js";
import { MetaModelError } from "./errors.js";

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

/**
 * THE `@role: primary` source lookup for this package — and the one place the
 * primary-source DIVERGENCE refusal lives, so that every caller inherits it.
 *
 * Effective children (own + inherited via the super chain) so a TPH SUBTYPE —
 * which declares no source of its own and inherits the discriminator base's
 * single table (FR-017) — resolves to that base source rather than to nothing.
 * For an entity declaring its own source, own shadows inherited, so the result
 * is unchanged. Returns `undefined` when `entity` declares no primary source at
 * all: #248, participation in persistence derives from a declared source, never
 * from the object subtype, so an `object.value` and a sourceless
 * `object.projection` both land here rather than being special-cased.
 *
 * `isMetaSource`, not `instanceof`: under two physical copies of this package a
 * class check is false for a real primary source, and the failure is SILENT —
 * the object reads as "not backed by any store".
 *
 * ## The refusal
 *
 * An object whose `@role: primary` sources resolve to MORE THAN ONE physical
 * name has no single answer to give, so this throws rather than picking one.
 * The shape loads with ZERO errors: `validateSourceRoles` enforces "exactly one
 * primary" over `ownChildren()` only, and `_effectiveChildren` shadows an own
 * child over a super child only on a (type, name) match — so two `source.rdb`
 * nodes with DIFFERENT explicit names at two levels of an `extends` chain never
 * collide, and both land on the child's effective `children()`.
 *
 * It lives HERE rather than in any one consumer because every consumer binds
 * ONE name unconditionally. It used to live only in codegen-ts's
 * `resolveObjectNames`, which runs only when the `names` generator is in the
 * run — so with `namesFile()` unwired `meta migrate` emitted DDL against the
 * PARENT's table (via `resolveTableName` → `buildExpectedSchema`) and
 * `ObjectManager` read and wrote it, silently, on every run. A refusal that
 * depends on which consumer asked is not a refusal. Mirrors Python's
 * `source_resolution.primary_rdb_source`, whose codegen, api-docs and runtime
 * callers all inherit it for free.
 *
 * DIRECTION-BLIND: it compares every primary against every other, so it does
 * not matter which of them is writable nor which was declared first. Comparing
 * against the first primary WRITABLE source can only see a divergence when one
 * of the two is read-only — and, since `children()` places inherited entries
 * first, only when the read-only one is the inherited one.
 *
 * Two primaries AGREEING on a name is not a divergence and stays legal: the
 * invariant is that an object has ONE physical name, not that it declares one
 * source. A read-only primary beside a non-primary REPLICA does not reach it
 * either — a replica is not `role === "primary"`.
 */
export function primaryRdbSource(entity: MetaData): MetaSource | undefined {
  const primaries = entity.children().filter(
    (c): c is MetaSource => isMetaSource(c) && c.role === SOURCE_ROLE_PRIMARY,
  );
  if (primaries.length === 0) return undefined;
  const distinct = [...new Set(primaries.map((s) => s.physicalName))].sort();
  if (distinct.length > 1) {
    // Sorted, so the message is identical in every port regardless of children() order.
    const joined = distinct.map((n) => `"${n}"`).join(", ");
    throw new MetaModelError(
      `${entity.name}: role=primary sources disagree on the object's physical name — ` +
      `${joined}. Every consumer binds ONE name. Give them matching physical names, ` +
      `or drop the extra role=primary declaration.`,
    );
  }
  return primaries[0];
}

export function resolveTableName(entity: MetaData): string {
  // FR-016: primary source's `physicalName` implements the four-step rule
  // (kind-matching alias → legacy @table → source.name → entity-name fallback),
  // so this helper now just delegates. Writability (table vs view/storedProc/
  // tableFunction) only affects write-routing — for SELECT-side name resolution,
  // a read-only primary source is the right answer.
  const source = primaryRdbSource(entity);
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
 * An index's DATABASE name — for an `identity.secondary` (a unique alternate key) or an
 * `index.lookup` (a non-unique retrieval index).
 *
 * These nodes carry no `@column`-style physical spelling: the database name IS the
 * metamodel `name`. That is precisely why the answer must live in a function rather than
 * at each call site. It was spelled independently in three places — the Drizzle emitter,
 * migrate's expected-schema (twice) and the Kotlin Exposed emitter — and agreed only by
 * coincidence; `fdb4118f1` is what that coincidence lapsing looks like, with codegen
 * declaring `idx_<table>_<col>` while the index in the database was `identity.name`.
 *
 * Two rules the single door now owns, neither of which any call site had:
 *
 * - **Package qualifier stripped — and the reason first given for this was WRONG.** It was
 *   justified here as compensating for the JVM loader package-qualifying a nested index
 *   name (`acme::demo::by_name`), which `KotlinExposedTableGenerator` mirrored with
 *   `shortName ?: name`. Measured against the real JVM loader, that does not happen: a
 *   nested `identity.secondary` or `index.lookup` is named flat, including when inherited
 *   across packages via `extends`. Only a ROOT-level node takes the file's package, and an
 *   unnamed `view` child gets a synthesised FQN — the likeliest source of the belief. The
 *   JVM's local strip had been a no-op for its whole life while reading as the site that
 *   owned the rule. Pinned now on that side by `IndexNamingTest`.
 *
 *   The strip stays, on the honest reason rather than the invented one: it is a no-op on
 *   every name either loader produces, which is what a rule that holds without a per-port
 *   branch looks like, and it costs one `lastIndexOf`. A normalisation nobody has to
 *   remember is worth more than a claim nobody checked.
 * - **An empty name is REFUSED**, and the gap it closes is exactly one node type wide.
 *   An `identity.secondary` with an empty name is already refused by the LOADER in strict
 *   and lax mode alike (identity nodes carry an FR-024 name check so a dotted `extends`
 *   ref can address them). An `index.lookup` is not addressable that way and carries no
 *   such check, so `{"index.lookup": {"name": ""}}` loads with zero errors in both modes
 *   and reaches the emitters, which produce `index("")`: SQL no engine accepts, from a
 *   model that passed every gate. Refusing at the shared door closes it for codegen and
 *   migrate at once, without touching the byte-gated registry `rules` prose a loader-side
 *   fix would need. Measured, not assumed — `resolve-index-name.test.ts` asserts both
 *   arms, because "the loader already handles it" is the belief that would delete this.
 */
export function resolveIndexName(
  // The narrow structural shape rather than `MetaData`: this reads three properties, and
  // every caller that has a real node satisfies it, while the Drizzle emitter's local
  // duck-typed index node does not need a cast to pass one. A cast here would be the
  // usual way a `never` slips past the compiler into a runtime property read.
  node: { readonly name: string; readonly type: string; readonly subType: string },
): string {
  const short = stripPackage(node.name);
  if (short === "") {
    throw new MetaModelError(
      `${node.type}.${node.subType} declares an empty name; an index's database name IS ` +
      `its metamodel name, so there is nothing to emit. Give it a name.`,
    );
  }
  return short;
}

/**
 * Returns the DB schema declared on an entity's primary source child, or undefined
 * when no @schema attr is set or no source child exists. @schema is paradigm-agnostic
 * (works for writable tables and read-only views/projections alike). Callers decide what
 * "undefined" means for their dialect — Postgres treats it as the default public schema,
 * SQLite treats it as the only allowed value (no schema concept).
 */
export function resolveTableSchema(entity: MetaData): string | undefined {
  // ADR-0039: resolving — a concrete entity may inherit its source.rdb via extends.
  // primaryRdbSource, not a second hand-rolled scan: a lookup written twice is a
  // lookup that can disagree with itself, and only one of the two copies would
  // carry the divergence refusal.
  const source = primaryRdbSource(entity);
  if (!source) return undefined;
  // ADR-0039: resolving — an inherited source's @schema lives on the super node.
  const schema = source.attr(SOURCE_ATTR_SCHEMA);
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
