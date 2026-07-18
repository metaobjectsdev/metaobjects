/**
 * View value-probe — the #195 projection read-model origins against a real SQLite.
 *
 * The PG counterpart lives in `view-lifecycle-pg.test.ts` (that file is Postgres-only:
 * it imports `pg` + Testcontainers). SQLite lowers the #195 origins DIFFERENTLY —
 * `bool_or`/`bool_and` become `MAX`/`MIN` over 1/0, and `array_agg` becomes
 * `json_group_array` (a JSON TEXT string, not a native array) — so the empty-set pins
 * (`any=0` / `all=1` / `collect=[]` / `first=null`) must be proven on a real SQLite
 * engine too, not just asserted as un-executed DDL text in the codegen-ts emitter test.
 *
 * This applies the emitted schema + view to a libsql tmp-file DB, seeds a populated and
 * an EMPTY (zero-related-rows) parent, SELECTs the view, and asserts the converged values.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import {
  buildExpectedSchema, diff, emit, introspectSqlite,
} from "@metaobjectsdev/migrate-ts";
import { buildProjectionViews } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

// Same Program → Week → ProgramSummary graph as the PG value-probe: one field per
// #195 origin kind (predicateAgg any/all, collectAgg, first, computed). literal naming
// → view column names are the field names verbatim.
const META = JSON.stringify({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Program", children: [
    { "source.rdb": { "@table": "programs" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "status", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "relationship.aggregation": { name: "weeks", "@cardinality": "many", "@objectRef": "Week" } },
  ] } },
  { "object.entity": { name: "Week", children: [
    { "source.rdb": { "@table": "weeks" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "programId", "@required": true } },
    { "field.string": { name: "label", "@required": true } },
    { "field.int": { name: "durationMinutes", "@required": true } },
    { "field.timestamp": { name: "createdAt", "@required": true } },
    { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
  ] } },
  { "object.projection": { name: "ProgramSummary", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_program_summary" } },
    { "identity.primary": { name: "id", extends: "Program.id", "@fields": "id" } },
    { "field.long": { name: "id", extends: "Program.id", children: [
      { "origin.passthrough": { "@from": "Program.id" } } ] } },
    { "field.boolean": { name: "anyLongWeek", children: [
      { "origin.aggregate": { "@agg": "any", "@via": "Program.weeks", "@filter": { durationMinutes: { gt: 60 } } } } ] } },
    { "field.boolean": { name: "allLongWeeks", children: [
      { "origin.aggregate": { "@agg": "all", "@via": "Program.weeks", "@filter": { durationMinutes: { gt: 60 } } } } ] } },
    { "field.string": { name: "weekLabels", isArray: true, children: [
      { "origin.aggregate": { "@agg": "collect", "@of": "Week.label", "@via": "Program.weeks", "@orderBy": ["label:asc"] } } ] } },
    { "field.string": { name: "latestWeekLabel", children: [
      { "origin.first": { "@of": "Week.label", "@via": "Program.weeks", "@orderBy": ["createdAt:desc"] } } ] } },
    { "field.boolean": { name: "isPublished", children: [
      { "origin.computed": { "@expr": { op: "eq", left: { field: "status" }, right: { value: "PUBLISHED" } } } } ] } },
  ] } },
]}});

let tmpDir: string;
let k: Kysely<Record<string, unknown>>;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "view-lifecycle-sqlite-"));
  k = new Kysely({ dialect: new LibsqlDialect({ url: `file:${join(tmpDir, "test.db")}` }) });
});

afterEach(async () => {
  await k.destroy();
  rmSync(tmpDir, { recursive: true, force: true });
});

// libsql execute() is single-statement — split on ";" (no view body carries an inner ";").
async function applyRaw(text: string): Promise<void> {
  for (const stmt of text.trim().split(";").map((s) => s.trim()).filter(Boolean)) {
    await sql.raw(stmt).execute(k);
  }
}

describe("view value-probe — real SQLite (#195 origins)", () => {
  test("any/all/collect/computed/first converge on real SQLite, incl. empty-set pins", async () => {
    const root = (await new MetaDataLoader().load([new InMemoryStringSource(META)])).root;
    const expected = buildExpectedSchema(root, {
      dialect: "sqlite",
      columnNamingStrategy: "literal",
      views: buildProjectionViews(root, { dialect: "sqlite", columnNamingStrategy: "literal" }),
    });

    const actual0 = await introspectSqlite(k);
    const initial = await diff({ expected, actual: actual0, dialect: "sqlite" });
    expect(initial.blocked).toEqual([]);
    const { up } = emit(initial.changes, {
      dialect: "sqlite",
      expectedSchema: expected,
      ...(actual0.meta !== undefined && { actualMeta: actual0.meta }),
    });
    // SQLite lowers collect to json_group_array (a JSON string), any/all to MAX/MIN over 1/0.
    expect(up).toContain(`CREATE VIEW "v_program_summary" AS`);
    expect(up).toContain("json_group_array");
    expect(up).toMatch(/COALESCE\(MAX\(CASE WHEN[^)]*\)[^,]*, 0\) AS "anyLongWeek"/);
    expect(up).toMatch(/COALESCE\(MIN\(CASE WHEN[^)]*\)[^,]*, 1\) AS "allLongWeeks"/);
    await applyRaw(up);

    // THE convergence gate: a second diff against the just-applied DB is a no-op.
    const followup = await diff({ expected, actual: await introspectSqlite(k), dialect: "sqlite" });
    if (followup.changes.length > 0) {
      console.error("NOT CONVERGED (sqlite) — a second migrate would emit:");
      for (const c of followup.changes) console.error("  -", c.kind, JSON.stringify(c).slice(0, 200));
    }
    expect(followup.changes).toEqual([]);

    // Seed a POPULATED program (id 1) and an EMPTY one (id 2, zero weeks).
    await sql.raw(`INSERT INTO "programs" ("id","status") VALUES (1,'PUBLISHED'),(2,'DRAFT')`).execute(k);
    await sql.raw(
      `INSERT INTO "weeks" ("id","programId","label","durationMinutes","createdAt") VALUES
         (1, 1, 'A', 30, '2026-01-01T00:00:00Z'),
         (2, 1, 'B', 90, '2026-02-01T00:00:00Z')`,
    ).execute(k);

    const rows = await sql.raw(
      `SELECT "id","anyLongWeek","allLongWeeks","weekLabels","latestWeekLabel","isPublished"
         FROM "v_program_summary" ORDER BY "id"`,
    ).execute(k);
    type Row = {
      id: number; anyLongWeek: number; allLongWeeks: number;
      weekLabels: string; latestWeekLabel: string | null; isPublished: number;
    };
    const byId = new Map((rows.rows as Row[]).map((r) => [String(r.id), r]));

    // Populated (id 1). SQLite has no boolean type: any/all/computed come back as 1/0,
    // and collect is a json_group_array TEXT string that must be JSON.parse'd.
    const full = byId.get("1")!;
    expect(full.anyLongWeek).toBe(1);                    // 90 > 60
    expect(full.allLongWeeks).toBe(0);                   // 30 is NOT > 60
    expect(JSON.parse(full.weekLabels)).toEqual(["A", "B"]);
    expect(full.latestWeekLabel).toBe("B");              // most recent by createdAt
    expect(full.isPublished).toBe(1);                    // status = 'PUBLISHED'

    // Empty (id 2): ZERO weeks — the empty-set pins.
    const empty = byId.get("2")!;
    expect(empty.anyLongWeek).toBe(0);                   // any over ∅ = false (0)
    expect(empty.allLongWeeks).toBe(1);                  // all over ∅ = true (1, vacuous)
    expect(JSON.parse(empty.weekLabels)).toEqual([]);    // collect over ∅ = [] (NOT null)
    expect(empty.latestWeekLabel).toBeNull();            // first over ∅ = null
    expect(empty.isPublished).toBe(0);                   // status = 'DRAFT'
  });
});
