// query-scenario.ts — execute a QueryScenario end-to-end:
//   1. Provision the schema by executing the committed canonical schema DDL
//      (fixtures/persistence-conformance/canonical/schema.postgres.sql).
//   2. Execute seed-data SQL.
//   3. For each QuerySpec: translate to ObjectManager call, normalize, compare.
//
// TS no longer synthesizes the query-scenario schema from metadata — it is the
// single PRODUCER of one committed DDL artifact (drift-checked by
// schema-artifact.test.ts) that every port executes verbatim. See
// docs/superpowers/specs/2026-05-30-ts-schema-authority-consolidation-design.md.
//
// COMMENT ON / enum CHECK are still C#-only (TS migrate-ts doesn't emit them).
// None of the current query scenarios depend on those, so the artifact omits them.

import { ObjectManager, type Filter } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import {
  type MetaRoot,
  TYPE_OBJECT, TYPE_IDENTITY,
  IDENTITY_SUBTYPE_PRIMARY, IDENTITY_ATTR_FIELDS,
} from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import {
  CANONICAL_COLUMN_NAMING,
  readCanonicalSchemaSql,
} from "./canonical-schema.ts";
import { loadMetadataDir } from "./load-metadata.ts";
import { canonicalJson, normalizeRow } from "./normalization.ts";
import { executeSql } from "./postgres-sql.ts";
import type { QueryScenario, QuerySpec } from "./scenario.ts";
import { registerTemporalParsers } from "./temporal-parsers.ts";

// node-postgres type parsers are process-global; register the canonical
// temporal parsers once at module load so every pg-backed read (Kysely
// included) returns the wire forms pinned in normalization.md.
registerTemporalParsers();

export async function runQueryScenario(
  scenario: QueryScenario,
  connectionUri: string,
  canonicalDir: string,
): Promise<void> {
  // 1. Provision the schema from the committed canonical DDL — the single
  //    TS-produced artifact every port executes. (No per-scenario synthesis.)
  await executeSql(connectionUri, readCanonicalSchemaSql());

  // The ObjectManager still needs the loaded metadata to map entities → rows.
  const root = await loadMetadataDir(canonicalDir);

  // 2. Seed data.
  if (scenario.seedData && scenario.seedData.trim().length > 0)
    await executeSql(connectionUri, scenario.seedData);

  // Kysely owns its pool exclusively (see migration-scenario.ts for why).
  // Pin the session timezone to UTC so TIMESTAMPTZ wire text always renders a
  // `+00` offset; canonicalTimestamptz converts any offset to UTC regardless,
  // but UTC sessions keep the read deterministic across host timezones.
  const kysely = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: connectionUri, options: "-c timezone=UTC" }),
    }),
  });
  try {
    // kyselyDriver wants Kysely<Record<string, Row>>; the actual row types are
    // resolved per-query so the placeholder generic is harmless.
    const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
    // Runtime column-naming MUST match what the committed schema artifact was
    // generated with (CANONICAL_COLUMN_NAMING), or the ObjectManager addresses
    // columns the schema doesn't have. See migration-scenario.ts for why both
    // runners pin "literal".
    const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: CANONICAL_COLUMN_NAMING });

    for (const spec of scenario.queries) {
      if (spec.expectError) {
        let threw = false;
        try {
          await execute(om, root, spec);
        } catch {
          threw = true;
        }
        if (!threw) {
          throw new Error(
            `${scenario.sourcePath} / ${spec.name}: expected the ${spec.op} to FAIL, but it succeeded`,
          );
        }
        continue;
      }
      const actual = await execute(om, root, spec);
      assertResult(scenario.sourcePath, spec, actual);
    }
  } finally {
    await kysely.destroy();
  }
}

// ---------------------------------------------------------------------------
// DSL → ObjectManager
// ---------------------------------------------------------------------------

async function execute(om: ObjectManager, root: MetaRoot, spec: QuerySpec): Promise<unknown> {
  // The corpus DSL uses unprefixed op names (`eq`, `gt`, etc.); the runtime-ts
  // Filter uses the $-prefixed form. Translate at the boundary.
  const filter = spec.filter ? toRuntimeFilter(spec.filter) : undefined;
  const sort = spec.sort?.map((s) => [s.field, s.dir] as [string, "asc" | "desc"]);

  if (spec.op === "get") {
    if (!spec.by) throw new Error(`${spec.name}: op:get requires 'by'`);
    const ids = Object.values(spec.by);
    if (ids.length !== 1) throw new Error(`${spec.name}: op:get supports single-field 'by' only`);
    return await om.findById(spec.entity, ids[0]);
  }
  if (spec.op === "create") {
    if (!spec.data) throw new Error(`${spec.name}: op:create requires 'data'`);
    return await om.create(spec.entity, spec.data);
  }
  if (spec.op === "update") {
    if (!spec.by) throw new Error(`${spec.name}: op:update requires 'by' (the record key)`);
    if (!spec.data) throw new Error(`${spec.name}: op:update requires 'data'`);
    const ids = Object.values(spec.by);
    if (ids.length !== 1) throw new Error(`${spec.name}: op:update supports single-field 'by' only`);
    return await om.update(spec.entity, ids[0], spec.data, { ifMissing: "throw" });
  }
  if (spec.op === "count") {
    return await om.count(spec.entity, filter);
  }
  if (spec.op === "relate") {
    if (!spec.by) throw new Error(`${spec.name}: op:relate requires 'by' (the source record key)`);
    if (!spec.relation) throw new Error(`${spec.name}: op:relate requires 'relation'`);
    return await om.relate(spec.entity, spec.by, spec.relation);
  }
  if (spec.op === "roundtrip") {
    // WRITE round-trip: INSERT the row through the runtime write path (NOT raw
    // SQL), then read it back by PK so the write codec + read path are both
    // exercised. The inserted row's PK (server-generated or explicit) drives the
    // read-back, so identity-generated PKs (increment / gen_random_uuid) are
    // covered too.
    if (!spec.insert) throw new Error(`${spec.name}: op:roundtrip requires 'insert' (the row to write)`);
    const created = await om.create(spec.entity, spec.insert as Record<string, unknown>);
    const pkField = primaryKeyField(root, spec.entity);
    const readBack = await om.findById(spec.entity, created[pkField]);
    // The PK is excluded from the comparison: a server-/runtime-generated PK
    // (gen_random_uuid / increment) is non-deterministic, so `expect` asserts the
    // written field VALUES, not the identity. (A scenario that supplies an
    // explicit PK still has it dropped here — assert PK round-trips via op:get.)
    if (readBack !== null) delete (readBack as Record<string, unknown>)[pkField];
    return readBack;
  }
  // op: list
  const opts: { orderBy?: [string, "asc" | "desc"][]; limit?: number; offset?: number } = {};
  if (sort && sort.length > 0) opts.orderBy = sort;
  if (spec.limit != null) opts.limit = spec.limit;
  if (spec.offset != null) opts.offset = spec.offset;
  return await om.findMany(spec.entity, filter, opts);
}

/**
 * The single-field primary-key NAME for an entity, read from its
 * `identity.primary` `@fields`. `op: roundtrip` reads the inserted row back by
 * this key. Composite PKs are not supported by roundtrip (none of the
 * roundtrip-target entities declare one).
 */
function primaryKeyField(root: MetaRoot, entityName: string): string {
  const entity = root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === entityName);
  if (!entity) throw new Error(`op:roundtrip: unknown entity '${entityName}'`);
  const primary = entity.ownChildren().find(
    (c) => c.type === TYPE_IDENTITY && c.subType === IDENTITY_SUBTYPE_PRIMARY,
  );
  if (!primary) throw new Error(`op:roundtrip: entity '${entityName}' has no primary identity`);
  const raw = primary.ownAttr(IDENTITY_ATTR_FIELDS);
  const fields = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? [raw] : [];
  if (fields.length !== 1)
    throw new Error(`op:roundtrip: entity '${entityName}' requires a single-field primary key`);
  return fields[0]!;
}

function toRuntimeFilter(filter: Record<string, unknown>): Filter {
  // Top-level `and: [filter, filter, ...]` lowers to the runtime's `$and` form.
  // Compose-by-AND is the only logical combinator supported today; `or` would
  // need both runtime-ts compileFilter AND the C# adapter to grow it first.
  if (Array.isArray(filter.and)) {
    return {
      $and: (filter.and as Record<string, unknown>[]).map(toRuntimeFilter),
    } as Filter;
  }
  // Otherwise: each top-level key is a field name; its value is a {op: value} object.
  const out: Record<string, unknown> = {};
  for (const [field, ops] of Object.entries(filter)) {
    const ops$: Record<string, unknown> = {};
    for (const [op, value] of Object.entries(ops as Record<string, unknown>)) ops$["$" + op] = value;
    out[field] = ops$;
  }
  return out as Filter;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assertResult(scenarioPath: string, spec: QuerySpec, actual: unknown): void {
  const expectedJson = canonicalizeExpected(spec.expect, spec.op);
  const actualJson = canonicalizeActual(actual, spec.op);
  if (expectedJson !== actualJson)
    throw new Error(
      `${scenarioPath} / ${spec.name}: result mismatch\n  expected: ${expectedJson}\n  actual:   ${actualJson}`,
    );
}

function canonicalizeExpected(expect: unknown, op: QuerySpec["op"]): string {
  if (op === "count") {
    const n = typeof expect === "number" ? expect : Number.parseInt(String(expect), 10);
    if (Number.isNaN(n)) throw new Error(`op:count expects an integer, got: ${expect}`);
    return String(n);
  }
  // `relate` (M:N navigation) is a SET — order is not part of the contract, so
  // sort both sides for a deterministic, port-agnostic comparison. `list` keeps
  // its order (the scenario pins it via `sort:`).
  if (op === "relate") return canonicalRowSet((expect ?? []) as Record<string, unknown>[]);
  return canonicalJson(expect);
}

function canonicalizeActual(actual: unknown, op: QuerySpec["op"]): string {
  if (op === "count") return String(actual);
  if (op === "relate") {
    const rows = (Array.isArray(actual) ? actual : actual == null ? [] : [actual]) as Record<string, unknown>[];
    return canonicalRowSet(rows.map(normalizeRow));
  }
  if (actual === null || actual === undefined) return "null";
  // get / create / update / roundtrip each return a single row.
  if (op === "get" || op === "create" || op === "update" || op === "roundtrip")
    return canonicalJson(normalizeRow(actual as Record<string, unknown>));
  // op: list
  const rows = actual as Record<string, unknown>[];
  return canonicalJson(rows.map(normalizeRow));
}

/** Canonicalize a row collection as an order-independent set (sorted by row JSON). */
function canonicalRowSet(rows: Record<string, unknown>[]): string {
  const each = rows.map((r) => canonicalJson(r)).sort();
  return `[${each.join(",")}]`;
}
