/**
 * Where the Postgres scratch database comes from: an explicit URL, else a database CREATEd on
 * the target server and always dropped, else none. A run opens it once however many
 * comparisons it makes, and an explicit one that cannot be used is an error. The live-server
 * cases skip gracefully when MIGRATE_TS_PG_URL is not set.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "kysely";
import type { SchemaSnapshot } from "@metaobjectsdev/migrate-ts";
import { parseMigrateArgs, parseVerifyArgs } from "../src/lib/args.js";
import { buildKyselyFromUrl } from "../src/lib/kysely.js";
import { describeExprCanonPath, shadowOpener, shadowSession, urlForDatabase } from "../src/lib/shadow.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

describe("shadow flags", () => {
  test("--shadow-db parses on migrate and verify", () => {
    expect(parseMigrateArgs(["--shadow-db", "postgres://h/s"]).shadowDb).toBe("postgres://h/s");
    const v = parseVerifyArgs(["--db", "postgres://h/d", "--shadow-db", "postgres://h/s"]);
    expect(v.shadowDb).toBe("postgres://h/s");
  });
});

describe("shadowOpener", () => {
  test("urlForDatabase keeps the server, credentials and options, and swaps the database", () => {
    expect(urlForDatabase("postgres://u:p@h:5433/live?sslmode=require", "mo_shadow_ab"))
      .toBe("postgres://u:p@h:5433/mo_shadow_ab?sslmode=require");
  });
  test("each source names itself, and a fallback says why the scratch database was not used", () => {
    expect(describeExprCanonPath("shadow")).toContain("scratch");
    expect(describeExprCanonPath("probe")).toContain("write privileges");
    expect(describeExprCanonPath("normaliser")).toContain("as text");
    expect(describeExprCanonPath("probe", "could not be opened: permission denied to create database"))
      .toContain("The scratch database was not used: could not be opened: permission denied to create database.");
  });

  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  const shadowDbs = async (target: Awaited<ReturnType<typeof buildKyselyFromUrl>>): Promise<string[]> =>
    (await sql<{ datname: string }>`SELECT datname FROM pg_database WHERE datname LIKE 'mo_shadow_%'`.execute(target.db))
      .rows.map((r) => r.datname);
  const EMPTY: SchemaSnapshot = { tables: [], views: [] };

  test("without a URL it CREATEs a database on the target and drops it on close", async () => {
    const target = await buildKyselyFromUrl(PG_URL, "postgres");
    try {
      const before = await shadowDbs(target);
      const handle = await shadowOpener(undefined, PG_URL)();
      expect((await shadowDbs(target)).length).toBe(before.length + 1);
      await sql`SELECT 1`.execute(handle.db);
      await handle.close();
      expect(await shadowDbs(target)).toEqual(before);
    } finally {
      await target.close();
    }
  });

  test("an explicit URL is opened as given and never dropped", async () => {
    const target = await buildKyselyFromUrl(PG_URL, "postgres");
    try {
      const handle = await shadowOpener(PG_URL, PG_URL)();
      await handle.close();
      // The explicit database is still there: the target itself answers.
      await sql`SELECT 1`.execute(target.db);
    } finally {
      await target.close();
    }
  });

  test("a session creates one database for every comparison of the run, and drops it on close", async () => {
    const target = await buildKyselyFromUrl(PG_URL, "postgres");
    try {
      const before = await shadowDbs(target);
      const session = shadowSession(undefined, PG_URL);
      expect("catalog" in (await session.schema(EMPTY))).toBe(true);
      expect("catalog" in (await session.schema(EMPTY))).toBe(true);
      expect((await shadowDbs(target)).length).toBe(before.length + 1);
      await session.close();
      expect(await shadowDbs(target)).toEqual(before);
    } finally {
      await target.close();
    }
  });

  test("an explicit URL that cannot be opened is an error naming it, without its password", async () => {
    const target = await buildKyselyFromUrl(PG_URL, "postgres");
    try {
      const bad = urlForDatabase(PG_URL, "mo_no_such_shadow_db");
      const session = shadowSession(bad, PG_URL);
      const err = await session.schema(EMPTY).then(() => undefined, (e: unknown) => e as Error);
      expect(err?.message).toMatch(/^shadow database: could not be opened: .*mo_no_such_shadow_db.*: .*does not exist/);
      const password = new URL(PG_URL).password;
      if (password !== "") expect(err?.message).not.toContain(password);
      await session.close();
    } finally {
      await target.close();
    }
  });
});
