// query-scenario.ts — execute a QueryScenario end-to-end:
//   1. Apply the canonical schema — tables + views via the migrate-ts engine.
//   2. Execute seed-data SQL.
//   3. For each QuerySpec: translate to ObjectManager call, normalize, compare.
//
// COMMENT ON / enum CHECK are still C#-only (TS migrate-ts doesn't emit them).
// None of the current query scenarios depend on those, so the runner skips them.

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

export async function runQueryScenario(
  scenario: QueryScenario,
  connectionUri: string,
  canonicalDir: string,
): Promise<void> {
  // 1. Apply the canonical schema — tables AND views, both via the engine pipeline.
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
    // See migration-scenario.ts for why both runners pin "literal".
    const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: "literal" });

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
  const expected = buildExpectedSchema(root, { columnNamingStrategy: "literal" });
  const r = await diff({ expected, actual: { tables: [], views: [] } });
  await executeSql(connectionUri, emit(r.changes, { dialect: "postgres" }).up);
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
