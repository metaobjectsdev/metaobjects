// query-scenario.ts — execute a QueryScenario end-to-end:
//   1. Apply the canonical schema (engine full-CREATE).
//   2. Apply tail-append DDL (views/comments/CHECK) — see below.
//   3. Execute seed-data SQL.
//   4. For each QuerySpec: translate to ObjectManager call, normalize, compare.
//
// The tail-append DDL (CREATE VIEW + COMMENT ON + enum CHECK) is the C# port's
// concern today; TS migrate-ts does not yet emit any of those. For the v2 corpus
// to work cross-port, the TS runner needs the same VIEW DDL the C# runner emits
// — otherwise projection-aggregate would fail with "relation v_program_stat
// does not exist". We synthesize the view DDL inline below (small, scenario-
// specific to the canonical schema). When TS migrate-ts grows view + CHECK
// emission, replace this with a direct call.

import { type MetaRoot } from "@metaobjectsdev/metadata";
import { buildExpectedSchema, diff, emit } from "@metaobjectsdev/migrate-ts";
import { ObjectManager, type Filter } from "@metaobjectsdev/runtime-ts";
import { kyselyDriver } from "@metaobjectsdev/runtime-ts/drivers";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";

import { loadMetadataDir } from "./load-metadata.ts";
import { canonicalJson, normalizeRow } from "./normalization.ts";
import { executeSql } from "./postgres-sql.ts";
import type { QueryScenario, QuerySpec } from "./scenario.ts";

// Hand-authored views matching the C# engine output. Required because TS
// migrate-ts does not yet emit view DDL (see file header).
const CANONICAL_VIEW_DDL = [
  `CREATE VIEW "v_program" AS
SELECT
  "id" AS "id",
  "title" AS "title",
  "status" AS "status"
FROM "programs";`,
  `CREATE VIEW "v_program_stat" AS
SELECT
  "id" AS "programId",
  (SELECT count(t."id") FROM "weeks" t WHERE t."programId" = "programs"."id") AS "weekCount"
FROM "programs";`,
];

export async function runQueryScenario(
  scenario: QueryScenario,
  connectionUri: string,
  canonicalDir: string,
): Promise<void> {
  // 1. Apply the canonical schema (tables + views — see header for the view caveat).
  const root = await loadMetadataDir(canonicalDir);
  await applyCanonicalSchema(connectionUri, root);

  // 2. Seed data.
  if (scenario.seedData && scenario.seedData.trim().length > 0)
    await executeSql(connectionUri, scenario.seedData);

  // Kysely owns its pool exclusively (see migration-scenario.ts for why).
  const kysely = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: connectionUri }) }),
  });
  try {
    // kyselyDriver wants Kysely<Record<string, Row>>; the actual row types are
    // resolved per-query so the placeholder generic is harmless.
    const driver = kyselyDriver({ db: kysely as never, dialect: "postgres" });
    const om = new ObjectManager({ metadata: root, driver });

    for (const spec of scenario.queries) {
      const actual = await execute(om, spec);
      assertResult(scenario.sourcePath, spec, actual);
    }
  } finally {
    await kysely.destroy();
  }
}

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------

async function applyCanonicalSchema(connectionUri: string, root: MetaRoot): Promise<void> {
  const expected = buildExpectedSchema(root);
  const r = await diff({ expected, actual: { tables: [], views: [] } });
  await executeSql(connectionUri, emit(r.changes, { dialect: "postgres" }).up);
  for (const ddl of CANONICAL_VIEW_DDL) await executeSql(connectionUri, ddl);
}

// ---------------------------------------------------------------------------
// DSL → ObjectManager
// ---------------------------------------------------------------------------

async function execute(om: ObjectManager, spec: QuerySpec): Promise<unknown> {
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
  if (spec.op === "count") {
    return await om.count(spec.entity, filter);
  }
  // op: list
  const opts: { orderBy?: [string, "asc" | "desc"][]; limit?: number; offset?: number } = {};
  if (sort && sort.length > 0) opts.orderBy = sort;
  if (spec.limit != null) opts.limit = spec.limit;
  if (spec.offset != null) opts.offset = spec.offset;
  return await om.findMany(spec.entity, filter, opts);
}

function toRuntimeFilter(filter: Record<string, Record<string, unknown>>): Filter {
  const out: Record<string, unknown> = {};
  for (const [field, ops] of Object.entries(filter)) {
    const ops$: Record<string, unknown> = {};
    for (const [op, value] of Object.entries(ops)) ops$["$" + op] = value;
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
  return canonicalJson(expect);
}

function canonicalizeActual(actual: unknown, op: QuerySpec["op"]): string {
  if (op === "count") return String(actual);
  if (actual === null || actual === undefined) return "null";
  if (op === "get") return canonicalJson(normalizeRow(actual as Record<string, unknown>));
  // op: list
  const rows = actual as Record<string, unknown>[];
  return canonicalJson(rows.map(normalizeRow));
}
