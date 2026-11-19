/**
 * rc.21 part B fix round 2 (N2): `meta verify --db` reads every declared `origin.function` from
 * pg_proc, so a declaration the database does not have (a `numeric` result declared `int`, which the
 * view's cast would round) is a finding and fails the run. Needs a Postgres: set
 * METAOBJECTS_TEST_PG_URL; without one the test is skipped (the check itself is covered live in
 * integration-tests view-vocabulary-rc21-pg.test.ts).
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { verifyCommand } from "../src/commands/verify.js";

const PG_URL = process.env.METAOBJECTS_TEST_PG_URL;
const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

function model(returns: string, subType: string): string {
  return JSON.stringify({ "metadata.root": { package: "acme", children: [
    { "object.entity": { name: "Meter", children: [
      { "source.rdb": { "@table": "meters" } },
      { "field.long": { name: "id" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
    ] } },
    { "object.projection": { name: "MeterRow", children: [
      { "source.rdb": { "@kind": "view", "@table": "v_meter_row" } },
      { "field.long": { name: "id", extends: "Meter.id" } },
      { [`field.${subType}`]: { name: "reading", children: [
        { "origin.function": { "@function": "meter_reading", "@schema": "verify_fn", "@args": ["id"], "@params": ["long"], "@returns": returns } } ] } },
      { "identity.primary": { name: "id", extends: "Meter.id" } },
    ] } },
  ] } });
}

async function project(returns: string, subType: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "verify-declared-functions-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.acme.json"), model(returns, subType), "utf8");
  await mkdir(join(root, ".metaobjects"), { recursive: true });
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1 }), "utf8");
  return root;
}

async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    const code = await fn();
    return { code, out: lines.join("\n") };
  } finally {
    console.log = log;
    console.error = err;
  }
}

describe("meta verify --db — declared origin.function signatures", () => {
  test.skipIf(PG_URL === undefined)("a declared return type the database does not have fails the run, named; a matching one is no finding", async () => {
    const k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: PG_URL }) }) });
    try {
      await sql.raw("DROP SCHEMA IF EXISTS verify_fn CASCADE").execute(k);
      await sql.raw("CREATE SCHEMA verify_fn").execute(k);
      await sql.raw("CREATE FUNCTION verify_fn.meter_reading(bigint) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$ SELECT $1 * 1.5 $$").execute(k);

      const bad = await capture(async () => verifyCommand(["--db", PG_URL!], await project("int", "int")));
      expect(bad.code).toBe(1);
      expect(bad.out).toContain("origin.function verify_fn.meter_reading on MeterRow.reading: declared (long) → int, which needs " +
        "verify_fn.meter_reading(bigint) → integer; the database has verify_fn.meter_reading(bigint) → numeric.");
      // Fix round 3 (M2): the run says what the comparison does not see.
      expect(bad.out).toContain("a domain is compared by its own name, not its base type");

      const good = await capture(async () => verifyCommand(["--db", PG_URL!], await project("decimal", "decimal")));
      expect(good.out).not.toContain("origin.function verify_fn.meter_reading");
    } finally {
      await sql.raw("DROP SCHEMA IF EXISTS verify_fn CASCADE").execute(k);
      await k.destroy();
    }
  }, 60_000);
});
