// field.duration through the ObjectManager: a value is written and read in the canonical ISO-8601
// form (fixtures/duration-wire), a duration inside a jsonb value object is canonical too, and a
// filter operand is spelled the way the column stores it — so `PT90M` finds a stored `PT1H30M`
// on a text column. Postgres (which refuses a signed ISO-8601 duration as interval input) is
// covered live by the persistence-conformance roundtrip-all-types scenario.
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { ObjectManager, type Row } from "../src/index.js";
import { kyselyDriver } from "../src/drivers/index.js";
import { buildSelectSpec } from "../src/query-builder.js";

const DURATION_MODEL = { "metadata.root": { package: "p", children: [
  { "object.value": { name: "Policy", children: [
    { "field.duration": { name: "timeout" } },
    { "field.duration": { name: "steps", isArray: true } },
  ] } },
  { "object.entity": { name: "Job", children: [
    { "source.rdb": { "@table": "jobs" } },
    { "field.long": { name: "id" } },
    { "field.duration": { name: "wait" } },
    { "field.object": { name: "policy", "@objectRef": "Policy", "@storage": "jsonb" } },
    { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
  ] } },
] } };

async function durationRoot(): Promise<MetaRoot> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(DURATION_MODEL))]);
  expect(r.errors).toEqual([]);
  return r.root;
}

async function withSqlite(fn: (om: ObjectManager, db: Kysely<Record<string, Row>>) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "om-duration-"));
  const db = new Kysely<Record<string, Row>>({ dialect: new LibsqlDialect({ url: `file:${join(dir, "t.db")}` }) });
  try {
    await sql.raw("CREATE TABLE jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, wait TEXT, policy TEXT)").execute(db);
    await fn(new ObjectManager({ metadata: await durationRoot(), driver: kyselyDriver({ db, dialect: "sqlite" }) }), db);
  } finally {
    await db.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("SQLite: a duration and a duration inside a jsonb value object are stored and read canonical", async () => {
  await withSqlite(async (om, db) => {
    const created = await om.create("Job", { wait: "PT90M", policy: { timeout: "P1D", steps: ["PT60S", "-PT90S"] } });
    expect(created.wait).toBe("PT1H30M");
    expect(created.policy).toEqual({ timeout: "PT24H", steps: ["PT1M", "-PT1M30S"] });
    const stored = (await sql.raw("SELECT wait, policy FROM jobs").execute(db)).rows[0] as Record<string, string>;
    expect(stored["wait"]).toBe("PT1H30M");
    expect(JSON.parse(stored["policy"]!)).toEqual({ timeout: "PT24H", steps: ["PT1M", "-PT1M30S"] });
  });
});

test("SQLite: a filter operand is canonicalised, so equal spans match", async () => {
  await withSqlite(async (om) => {
    await om.create("Job", { wait: "PT1H30M" });
    await om.create("Job", { wait: "-PT1M30S" });
    expect((await om.findMany("Job", { wait: "PT90M" })).map((r) => r.wait)).toEqual(["PT1H30M"]);
    expect((await om.findMany("Job", { wait: { $in: ["-PT90S", "PT5400S"] } })).length).toBe(2);
    expect(await om.count("Job", { wait: { $ne: "P0D" } })).toBe(2);
    await expect(om.findMany("Job", { wait: "P1M" })).rejects.toThrow(/not an ISO-8601 duration/);
  });
});

test("a filter operand on Postgres is the interval spelling, never a signed ISO literal", async () => {
  const root = await durationRoot();
  const spec = buildSelectSpec(root.findObject("Job")!, { wait: "-PT90S" }, {}, undefined, undefined, "postgres");
  expect(spec.where).toEqual({ kind: "eq", column: "wait", value: "-00:01:30" });
});
