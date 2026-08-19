/**
 * `meta verify --db` honours `migrate.scope` (real sqlite, whole CLI pipeline).
 *
 * `migrate` and `verify --db` govern the identical object set — a drift gate
 * that fails on tables `migrate` deliberately does not own is incoherent — so
 * the two share ONE declaration (`migrate.scope`) rather than a second key.
 * An out-of-scope object is reported as out-of-scope, never as drift: silence
 * alone would misreport an unchecked table as a checked one.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";
import { arena, arenaFile, declareScope, PLATFORM, scaffold } from "./support/scope-fixture.js";

/** Materialize the current metadata schema into the DB via the real migrate path. */
async function materialize(repo: string, dbUrl: string): Promise<void> {
  const exit = await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "initial"]);
  expect(exit).toBe(0);
  const migrationsRoot = join(repo, ".metaobjects", "migrations");
  const dir = readdirSync(migrationsRoot).find((s) => s.endsWith("-initial"))!;
  const sql = readFileSync(join(migrationsRoot, dir, "up.sql"), "utf8");
  const client = createClient({ url: dbUrl });
  for (const stmt of sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
    await client.execute(stmt);
  }
  client.close();
}

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta verify --db — migrate.scope", () => {
  test("an out-of-scope object's divergence is reported as out-of-scope, not as drift", async () => {
    const { repo, dbUrl } = scaffold("metaobjects-verify-scope-");
    try {
      await materialize(repo, dbUrl);
      expect(await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"])).toBe(0);

      declareScope(repo, ["acme::platform::**"]);
      // The other owner's model gains a column its own migration has not applied.
      writeFileSync(arenaFile(repo), arena({ venue: true }), "utf8");
      out = [];
      err = [];

      expect(await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"])).toBe(0);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("out-of-scope");
      expect(all).toContain("matches");
      expect(all).not.toContain("venue");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("in-scope drift still fails the gate under a scope", async () => {
    const { repo, dbUrl } = scaffold("metaobjects-verify-scope-");
    try {
      await materialize(repo, dbUrl);
      declareScope(repo, ["acme::platform::**"]);
      // This consumer's OWN model gains a column the database lacks.
      writeFileSync(
        join(repo, "metaobjects", "meta.platform.json"),
        PLATFORM.replace(
          `{"field.string":{"name":"title"}}`,
          `{"field.string":{"name":"title"}},{"field.string":{"name":"owner"}}`,
        ),
        "utf8",
      );
      out = [];
      err = [];

      expect(await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"])).toBe(1);
      expect([...out, ...err].join("\n")).toContain("owner");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("with no migrate.scope declared, the same divergence IS drift (unchanged)", async () => {
    const { repo, dbUrl } = scaffold("metaobjects-verify-scope-");
    try {
      await materialize(repo, dbUrl);
      writeFileSync(arenaFile(repo), arena({ venue: true }), "utf8");
      out = [];
      err = [];

      expect(await run(["verify", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite"])).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("venue");
      expect(all).not.toContain("out-of-scope");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
