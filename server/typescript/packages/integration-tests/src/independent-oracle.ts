// independent-oracle.ts — what a database and a generated API must contain, derived from
// the metadata by rules written ONCE, here, independently of the code under test.
//
// WHY THIS EXISTS. `meta verify --db` diffs a live database against
// `buildExpectedSchema` — the same function `meta migrate` uses to write the DDL. When
// that function dropped every FK onto a TPH subtype, the migration lacked the FK, the
// database lacked the FK, and verify reported the two in sync: one code path was playing
// both the author and the checker. Every corpus in the repo was green at the time. A
// compile gate cannot see it either: a column without `.references()` compiles.
//
// So the rules below restate the contract from the metadata alone and read the answer
// straight from Postgres's catalog — not through migrate-ts's introspector, not through
// `buildExpectedSchema`, not through codegen's TPH helpers. They are deliberately the
// NAIVE statement of each rule. If a rule here and the product disagree, one of them is
// wrong, and the disagreement is the point.
//
// What is shared, on purpose: the metadata loader (the input, not the thing under test)
// and the physical NAMING helpers (`resolveTableName` / `resolveColumnName`). Naming is
// its own contract with its own tests; re-deriving snake_case plurals here would test the
// oracle's copy of the naming rule, not the structure.
//
// The rules:
//   1. Storage. An object's rows live in the table of the nearest object, itself or an
//      ancestor, that declares `@discriminator`; with none, in its own. (TPH, FR-017.)
//   2. Tables. A concrete object whose storing object has a writable source has a table.
//   3. Columns. Every non-derived field of every such object is a column of its storing
//      table — including fields declared on a subtype or an abstract level in between.
//   4. Foreign keys. Every enforced `identity.reference` on every such object is an FK on
//      its storing table, onto the table that stores the TARGET's rows, referencing the
//      target's primary-key columns.
//   5. Routes. Every concrete object with a source serves list + get at its path, and
//      every M:N relationship it has serves `<path>/:id/<relation>`. A TPH subtype serves
//      them under its base's path at `/<discriminatorValue lowercased>` (the FR-017
//      contract, and the maintainer's ruling for an M:N declared on a subtype).

import {
  type MetaObject,
  type MetaRoot,
  type ColumnNamingStrategy,
  OBJECT_ATTR_DISCRIMINATOR,
  OBJECT_ATTR_DISCRIMINATOR_VALUE,
  RELATIONSHIP_ATTR_THROUGH,
  DEFAULT_COLUMN_NAMING_STRATEGY,
  isMetaObject,
  isMetaSource,
  isWritableSource,
  resolveColumnName,
  resolveTableName,
  stripPackage,
} from "@metaobjectsdev/metadata";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";

/** One foreign key, reduced to what the contract is about. Columns keep key order. */
export interface Fk {
  table: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
}

/** Canonical, comparable spelling of an FK. */
export function fkKey(fk: Fk): string {
  return `${fk.table}(${fk.columns.join(",")}) -> ${fk.refTable}(${fk.refColumns.join(",")})`;
}

/** Rule 1: the object whose table stores `obj`'s rows. */
export function storingObject(obj: MetaObject): MetaObject {
  let cursor: MetaObject | undefined = obj;
  while (cursor !== undefined) {
    // Own read on purpose: `@discriminator` marks the LEVEL that owns the table, and this
    // walk is the resolution (a subtype inherits the attr but does not own the table).
    if (typeof cursor.ownAttr(OBJECT_ATTR_DISCRIMINATOR) === "string") return cursor;
    const parent: unknown = cursor.superResolved;
    cursor = parent !== undefined && isMetaObject(parent) ? parent : undefined;
  }
  return obj;
}

/** Rule 2: every concrete object with a table, paired with the object storing its rows. */
export function tableBackedObjects(root: MetaRoot): Array<{ obj: MetaObject; storing: MetaObject }> {
  const out: Array<{ obj: MetaObject; storing: MetaObject }> = [];
  for (const obj of root.objects()) {
    if (obj.isAbstract) continue;
    const storing = storingObject(obj);
    if (storing.isAbstract) continue;
    if (!storing.children().some(isWritableSource)) continue;
    out.push({ obj, storing });
  }
  return out;
}

function lookup(root: MetaRoot, name: string): MetaObject {
  const obj = root.findObject(stripPackage(name));
  if (obj === undefined) throw new Error(`oracle: metadata names an object that does not exist: ${name}`);
  return obj;
}

function columnOf(obj: MetaObject, fieldName: string, strategy: ColumnNamingStrategy): string {
  const field = obj.findField(fieldName);
  if (field === undefined) throw new Error(`oracle: ${obj.name} has no field ${fieldName}`);
  return resolveColumnName(field, strategy);
}

/** Rule 3: expected columns per table. */
export function expectedColumns(root: MetaRoot, strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { obj, storing } of tableBackedObjects(root)) {
    const table = resolveTableName(storing);
    const cols = out.get(table) ?? new Set<string>();
    for (const field of obj.fields()) {
      if (field.isDerived()) continue;
      cols.add(resolveColumnName(field, strategy));
    }
    out.set(table, cols);
  }
  return out;
}

/** Rule 4: expected FKs, deduplicated (a base's reference is seen again on each subtype). */
export function expectedForeignKeys(root: MetaRoot, strategy: ColumnNamingStrategy = DEFAULT_COLUMN_NAMING_STRATEGY): Fk[] {
  const byKey = new Map<string, Fk>();
  for (const { obj, storing } of tableBackedObjects(root)) {
    for (const ref of obj.referenceIdentities()) {
      if (!ref.enforce) continue;
      const targetName = ref.targetEntity;
      if (targetName === undefined) continue;
      const target = lookup(root, targetName);
      const pk = target.primaryIdentity();
      if (pk === undefined) throw new Error(`oracle: ${target.name} has no primary identity`);
      const fk: Fk = {
        table: resolveTableName(storing),
        columns: ref.fields.map((f) => columnOf(obj, f, strategy)),
        refTable: resolveTableName(storingObject(target)),
        refColumns: pk.fields.map((f) => columnOf(target, f, strategy)),
      };
      byKey.set(fkKey(fk), fk);
    }
  }
  return [...byKey.values()].sort((a, b) => fkKey(a).localeCompare(fkKey(b)));
}

/** What Postgres itself says the FKs are, straight from pg_catalog. */
export async function actualForeignKeys(connectionUri: string, schema = "public"): Promise<Fk[]> {
  const pool = new pg.Pool({ connectionString: connectionUri });
  try {
    const { rows } = await pool.query<{ table: string; columns: string[]; ref_table: string; ref_columns: string[] }>(
      `SELECT src.relname AS table,
              ARRAY(SELECT a.attname FROM unnest(c.conkey) WITH ORDINALITY k(n, i)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS columns,
              dst.relname AS ref_table,
              ARRAY(SELECT a.attname FROM unnest(c.confkey) WITH ORDINALITY k(n, i)
                    JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n ORDER BY k.i)::text[] AS ref_columns
         FROM pg_constraint c
         JOIN pg_class src ON src.oid = c.conrelid
         JOIN pg_class dst ON dst.oid = c.confrelid
         JOIN pg_namespace ns ON ns.oid = src.relnamespace
        WHERE c.contype = 'f' AND ns.nspname = $1`,
      [schema],
    );
    return rows
      .map((r) => ({ table: r.table, columns: r.columns, refTable: r.ref_table, refColumns: r.ref_columns }))
      .sort((a, b) => fkKey(a).localeCompare(fkKey(b)));
  } finally {
    await pool.end();
  }
}

/** What Postgres itself says the columns are, per table. */
export async function actualColumns(connectionUri: string, schema = "public"): Promise<Map<string, Set<string>>> {
  const pool = new pg.Pool({ connectionString: connectionUri });
  try {
    const { rows } = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
      [schema],
    );
    const out = new Map<string, Set<string>>();
    for (const r of rows) {
      const cols = out.get(r.table_name) ?? new Set<string>();
      cols.add(r.column_name);
      out.set(r.table_name, cols);
    }
    return out;
  } finally {
    await pool.end();
  }
}

/** Every `expected` column missing from `actual`, as `table.column`. */
export function missingColumns(expected: Map<string, Set<string>>, actual: Map<string, Set<string>>): string[] {
  const missing: string[] = [];
  for (const [table, cols] of expected) {
    for (const col of cols) if (!actual.get(table)?.has(col)) missing.push(`${table}.${col}`);
  }
  return missing.sort();
}

/**
 * The FKs a generated Drizzle schema declares, from the table objects its modules export.
 * Read through Drizzle's own `getTableConfig`, so what is compared is what Drizzle — and
 * `drizzle-kit`, and the relational query API — will believe about the database.
 */
export function drizzleForeignKeys(modules: Array<Record<string, unknown>>): Fk[] {
  const byKey = new Map<string, Fk>();
  for (const mod of modules) {
    for (const value of Object.values(mod)) {
      if (!isPgTable(value)) continue;
      const config = getTableConfig(value);
      for (const fk of config.foreignKeys) {
        const ref = fk.reference();
        const out: Fk = {
          table: config.name,
          columns: ref.columns.map((c) => c.name),
          refTable: getTableConfig(ref.foreignTable).name,
          refColumns: ref.foreignColumns.map((c) => c.name),
        };
        byKey.set(fkKey(out), out);
      }
    }
  }
  return [...byKey.values()].sort((a, b) => fkKey(a).localeCompare(fkKey(b)));
}

function isPgTable(value: unknown): value is PgTable {
  return is(value, PgTable);
}

/** Every concrete object with a source (declared or inherited) — the objects an API serves. */
export function servedObjects(root: MetaRoot): MetaObject[] {
  // ADR-0039: resolving — a subtype inherits its base's source.
  return root.objects().filter((obj) => !obj.isAbstract && obj.children().some(isMetaSource));
}

/** One route the generated API must mount. */
export interface ExpectedRoute {
  method: "GET";
  url: string;
  why: string;
}

/**
 * Rule 5. `pathOf` answers an object's generated resource path (`<Entity>.$path`, the
 * generated contract a client is built against); the rest — which objects are served,
 * where a subtype lives, which relationships get a traversal — is restated here.
 */
export function expectedRoutes(root: MetaRoot, pathOf: (obj: MetaObject) => string): ExpectedRoute[] {
  const routes: ExpectedRoute[] = [];
  for (const obj of servedObjects(root)) {
    const storing = storingObject(obj);
    // ADR-0039: resolving — a sub-subtype may inherit its @discriminatorValue.
    const value = obj.attr(OBJECT_ATTR_DISCRIMINATOR_VALUE);
    const base = storing !== obj && typeof value === "string"
      ? `${pathOf(storing)}/${value.toLowerCase()}`
      : pathOf(obj);
    routes.push({ method: "GET", url: base, why: `${obj.name} list` });
    routes.push({ method: "GET", url: `${base}/:id`, why: `${obj.name} get` });
    for (const rel of obj.relationships()) {
      // ADR-0039: resolving — @through may be inherited.
      if (rel.attr(RELATIONSHIP_ATTR_THROUGH) === undefined) continue;
      routes.push({ method: "GET", url: `${base}/:id/${rel.name}`, why: `${obj.name}.${rel.name} M:N traversal` });
    }
  }
  return routes;
}
