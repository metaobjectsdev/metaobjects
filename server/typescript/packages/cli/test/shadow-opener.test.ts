/**
 * Where the Postgres scratch database comes from: an explicit URL, else a database CREATEd on
 * the target server and always dropped, else none. The live-server cases skip gracefully when
 * MIGRATE_TS_PG_URL is not set.
 */
import { describe, expect, test } from "bun:test";
import { sql } from "kysely";
import { parseMigrateArgs, parseVerifyArgs } from "../src/lib/args.js";
import { buildKyselyFromUrl } from "../src/lib/kysely.js";
import { describeExprCanonPath, shadowOpener, urlForDatabase } from "../src/lib/shadow.js";

const PG_URL = process.env["MIGRATE_TS_PG_URL"];

describe("shadow flags", () => {
  test("--shadow-db and --no-shadow-db parse on migrate and verify", () => {
    expect(parseMigrateArgs(["--shadow-db", "postgres://h/s"]).shadowDb).toBe("postgres://h/s");
    expect(parseMigrateArgs(["--no-shadow-db"]).noShadowDb).toBe(true);
    const v = parseVerifyArgs(["--db", "postgres://h/d", "--shadow-db", "postgres://h/s"]);
    expect(v.shadowDb).toBe("postgres://h/s");
    expect(parseVerifyArgs(["--db", "postgres://h/d", "--no-shadow-db"]).noShadowDb).toBe(true);
  });
});

describe("shadowOpener", () => {
  test("urlForDatabase keeps the server, credentials and options, and swaps the database", () => {
    expect(urlForDatabase("postgres://u:p@h:5433/live?sslmode=require", "mo_shadow_ab"))
      .toBe("postgres://u:p@h:5433/mo_shadow_ab?sslmode=require");
  });
  test("disabled opens nothing", () => {
    expect(shadowOpener({ url: undefined, disabled: true }, { url: "postgres://h/d", handle: {} as never })).toBeUndefined();
  });
  test("each source names itself", () => {
    expect(describeExprCanonPath("shadow")).toContain("scratch");
    expect(describeExprCanonPath("probe")).toContain("write privileges");
    expect(describeExprCanonPath("normaliser")).toContain("as text");
  });

  if (!PG_URL) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  const shadowDbs = async (target: Awaited<ReturnType<typeof buildKyselyFromUrl>>): Promise<string[]> =>
    (await sql<{ datname: string }>`SELECT datname FROM pg_database WHERE datname LIKE 'mo_shadow_%'`.execute(target.db))
      .rows.map((r) => r.datname);

  test("without a URL it CREATEs a database on the target and drops it on close", async () => {
    const target = await buildKyselyFromUrl(PG_URL, "postgres");
    try {
      const before = await shadowDbs(target);
      const open = shadowOpener({ url: undefined, disabled: false }, { url: PG_URL, handle: target })!;
      const handle = (await open())!;
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
      const open = shadowOpener({ url: PG_URL, disabled: false }, { url: PG_URL, handle: target })!;
      const handle = (await open())!;
      await handle.close();
      // The explicit database is still there: the target itself answers.
      await sql`SELECT 1`.execute(target.db);
    } finally {
      await target.close();
    }
  });
});
