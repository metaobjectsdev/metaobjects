/**
 * Real column-default drift on a live Postgres database reaches the same verdict through
 * `meta verify --db` and `meta migrate --from-db --dry-run`, both on the shadow path: a
 * default somebody changed by hand (an integer 7 made 8, `now()` made `now() + 1 day`) is
 * reported by verify and planned by migrate, while the defaults exactly as the metadata
 * declares them read clean. The oracle is the ALTER TABLE the test runs itself.
 *
 * An explicitly configured scratch database that cannot be reached is a hard error naming
 * the cause in both commands, never a silent fall-back to another comparison. Plain
 * `meta migrate --dry-run` (no --from-db) reads no database at all: it says so, and it
 * refuses a --shadow-db it would otherwise have ignored.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { run } from "../../src/index.js";

const PG_URL = process.env.MIGRATE_TS_PG_URL;
const TABLE = "shadow_default_drift_events";
const UNREACHABLE_SHADOW = "postgresql://nobody:nothing@127.0.0.1:1/nope";

const MODEL = JSON.stringify({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "Event",
        children: [
          { "source.rdb": { name: "src", "@table": TABLE } },
          { "field.long": { name: "id" } },
          { "field.int": { name: "seq", "@default": 7, "@required": true } },
          { "field.timestamp": { name: "startsAt", "@column": "starts_at", "@default": "NOW()", "@required": true } },
          { "identity.primary": { name: "pk", "@fields": ["id"] } },
        ],
      },
    }],
  },
});

describe("shadow path: live default drift and an unreachable explicit shadow (env-gated)", () => {
  if (PG_URL === undefined || PG_URL.length === 0) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  let pool: Pool;
  let root: string;
  const args = (...rest: string[]): string[] => [...rest, "--cwd", root, "--db", PG_URL, "--dialect", "postgres"];

  /** Run the CLI, collecting everything it prints. */
  const captured = async (argv: string[]): Promise<{ exit: number; out: string }> => {
    const lines: string[] = [];
    const origLog = console.log;
    const origErr = console.error;
    const origWarn = console.warn;
    const keep = (...a: unknown[]): void => { lines.push(a.map(String).join(" ")); };
    console.log = keep; console.error = keep; console.warn = keep;
    try {
      return { exit: await run(argv), out: lines.join("\n") };
    } finally {
      console.log = origLog; console.error = origErr; console.warn = origWarn;
    }
  };

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG_URL });
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    root = mkdtempSync(join(tmpdir(), "shadow-default-drift-pg-"));
    mkdirSync(join(root, "metaobjects"), { recursive: true });
    writeFileSync(join(root, "metaobjects", "meta.events.json"), MODEL, "utf8");
    expect((await captured(args("migrate", "--from-db", "--slug", "shadow-default-drift", "--apply"))).exit).toBe(0);
  });
  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  test("the defaults as declared read clean through both commands", async () => {
    expect((await captured(args("verify"))).exit).toBe(0);
    const planned = await captured(args("migrate", "--from-db", "--dry-run"));
    expect(planned.exit).toBe(0);
    expect(planned.out).not.toContain("SET DEFAULT");
  });

  test("seq 8 vs 7 and starts_at now() + 1 day vs now() are drift for verify and planned by migrate", async () => {
    await pool.query(`ALTER TABLE ${TABLE} ALTER COLUMN seq SET DEFAULT 8`);
    await pool.query(`ALTER TABLE ${TABLE} ALTER COLUMN starts_at SET DEFAULT now() + interval '1 day'`);
    try {
      const verified = await captured(args("verify"));
      expect(verified.exit).toBe(1);
      expect(verified.out).toContain("seq");
      expect(verified.out).toContain("starts_at");

      const planned = await captured(args("migrate", "--from-db", "--dry-run"));
      expect(planned.exit).toBe(0);
      expect(planned.out).toContain("compared against a scratch (shadow) database");
      expect(planned.out).toMatch(/ALTER COLUMN \\?"seq\\?" SET DEFAULT '?7'?;/);
      expect(planned.out).toMatch(/ALTER COLUMN \\?"starts_at\\?" SET DEFAULT now\(\);/);

      // Without --from-db, migrate diffs the metadata against the committed snapshot and
      // never reads the database: it plans nothing here, and says so rather than reading
      // as a clean comparison with the database.
      const offline = await captured(args("migrate", "--dry-run"));
      expect(offline.exit).toBe(0);
      expect(offline.out).toContain("no database was read");
      expect(offline.out).toContain("--from-db");
    } finally {
      await pool.query(`ALTER TABLE ${TABLE} ALTER COLUMN seq SET DEFAULT 7`);
      await pool.query(`ALTER TABLE ${TABLE} ALTER COLUMN starts_at SET DEFAULT now()`);
    }
  });

  test("an explicit --shadow-db that cannot be reached is a hard error in migrate and verify", async () => {
    // A run that reads no database refuses a --shadow-db it would otherwise ignore.
    const offline = await captured(args("migrate", "--dry-run", "--shadow-db", UNREACHABLE_SHADOW));
    expect(offline.exit).toBe(2);
    expect(offline.out).toContain("--shadow-db needs --from-db");
    for (const argv of [
      args("migrate", "--from-db", "--dry-run", "--shadow-db", UNREACHABLE_SHADOW),
      args("verify", "--shadow-db", UNREACHABLE_SHADOW),
    ]) {
      const r = await captured(argv);
      expect(r.exit).not.toBe(0);
      expect(r.out).toContain("shadow database");
      expect(r.out).toContain("127.0.0.1:1");
    }
  });
});
