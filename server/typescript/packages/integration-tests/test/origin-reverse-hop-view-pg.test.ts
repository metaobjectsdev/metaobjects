/**
 * Postgres: a projection view whose origin `@via` walks an identity.reference BACKWARDS (#560).
 *
 * `Project.timeEntries` names no relationship: it walks TimeEntry's `project` reference from the
 * entity it targets back to the entity holding it. The loader accepted that hop, but the view
 * emitter resolved hops only through relationships and forward references, so it silently left
 * the aggregate and first columns out of CREATE VIEW. This test migrates an empty database, puts
 * rows in, and reads the view: a missing column, or a join pointed the wrong way, fails it.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { buildExpectedSchema, collectUnmanagedNames, diff, emit, introspectPostgres, splitSqlStatements } from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { startPostgres, type RunningPg } from "../src/postgres-container.ts";

const META = {
  "metadata.root": {
    package: "acme::studio",
    children: [
      { "object.entity": { name: "Project", children: [
        { "source.rdb": { "@table": "projects" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "TimeEntry", children: [
        { "source.rdb": { "@table": "time_entries" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "projectId" } },
        { "field.decimal": { name: "hours", "@precision": 6, "@scale": 2 } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "project", "@fields": "projectId", "@references": "Project" } },
      ] } },
      { "object.projection": { name: "ProjectHours", children: [
        { "source.rdb": { "@kind": "view", "@view": "v_project_hours" } },
        { "field.long": { name: "id", extends: "Project.id" } },
        { "field.string": { name: "name", extends: "Project.name" } },
        { "field.decimal": { name: "totalHours", "@precision": 10, "@scale": 2, children: [
          { "origin.aggregate": { "@agg": "sum", "@of": "TimeEntry.hours", "@via": "Project.timeEntries" } } ] } },
        { "field.int": { name: "entryCount", children: [
          { "origin.aggregate": { "@agg": "count", "@of": "TimeEntry.id", "@via": "Project.timeEntries" } } ] } },
        { "field.decimal": { name: "latestHours", "@precision": 6, "@scale": 2, children: [
          { "origin.first": { "@of": "TimeEntry.hours", "@via": "Project.timeEntries", "@orderBy": ["id:desc"] } } ] } },
        { "identity.primary": { name: "id", extends: "Project.id" } },
      ] } },
    ],
  },
};

let pg: RunningPg;
let k: Kysely<Record<string, unknown>>;
let root: MetaRoot;

beforeAll(async () => {
  pg = await startPostgres();
  k = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: new Pool({ connectionString: pg.connectionUri, max: 1 }) }),
  });
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(META))]);
  expect(loaded.errors).toEqual([]);
  root = loaded.root;
}, 120_000);

afterAll(async () => {
  await k.destroy();
  await pg.stop();
}, 60_000);

describe("origin @via over a reverse identity.reference hop (postgres)", () => {
  test("the view carries the aggregate and first columns, joined from the holder", async () => {
    const views = buildProjectionViews(root, { dialect: "postgres" });
    const result = await diff({
      expected: buildExpectedSchema(root, { views }),
      actual: await introspectPostgres(k),
      dialect: "postgres",
      unmanagedNames: collectUnmanagedNames(root),
    });
    expect(result.blocked).toEqual([]);
    for (const stmt of splitSqlStatements(emit(result.changes, { dialect: "postgres" }).up)) {
      await sql.raw(stmt).execute(k);
    }

    await sql.raw(`INSERT INTO projects (id, name) VALUES (1, 'Alpha'), (2, 'Idle')`).execute(k);
    await sql.raw(`INSERT INTO time_entries (id, project_id, hours) VALUES (10, 1, 2.50), (11, 1, 4.00)`).execute(k);

    const rows = await sql<Record<string, unknown>>`SELECT * FROM v_project_hours ORDER BY id`.execute(k);
    // Columns follow the default snake_case naming; pg returns numeric and bigint as strings.
    const num = (v: unknown) => (v === null ? null : Number(v));
    expect(rows.rows.map((r) => ({
      id: Number(r.id), name: r.name, totalHours: num(r.total_hours),
      entryCount: num(r.entry_count), latestHours: num(r.latest_hours),
    }))).toEqual([
      { id: 1, name: "Alpha", totalHours: 6.5, entryCount: 2, latestHours: 4 },
      { id: 2, name: "Idle", totalHours: null, entryCount: 0, latestHours: null },
    ]);
  }, 60_000);
});
