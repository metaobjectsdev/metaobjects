/**
 * The shadow path compares comments and GENERATED identity catalog to catalog. Two things that
 * must hold around that, end to end through `meta verify --db` and `meta migrate`:
 *
 * - A committed snapshot written before formatVersion 4 never recorded comments or identity (a
 *   v3 `baseline --from-db` left them out), so the committed-snapshot check treats them as
 *   unknown and stays green; the same snapshot written as v4 says "none", and that difference
 *   from the database is reported.
 * - A live comment the metadata does not declare is drift for `verify --db`, but `migrate` does
 *   not clear it without `--allow drop-comment`: it plans the rest and says it kept the comment.
 *
 * Skips gracefully when MIGRATE_TS_PG_URL is not set.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { snapshotPath } from "@metaobjectsdev/migrate-ts";
import { run } from "../../src/index.js";

const PG_URL = process.env.MIGRATE_TS_PG_URL;
const TABLE = "shadow_catalog_t";

const MODEL = JSON.stringify({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "ShadowCatalog",
        "@description": "Catalog rows.",
        children: [
          { "source.rdb": { name: "src", "@table": TABLE } },
          { "field.long": { name: "id" } },
          { "field.string": { name: "label", "@maxLength": 40, "@description": "Shown name." } },
          { "field.int": { name: "qty" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

interface SnapshotFile {
  formatVersion: number;
  snapshot: { tables: Array<{ name: string; description?: string; columns: Array<{ description?: string; identity?: string }> }> };
}

describe("shadow catalog: snapshot versions and undeclared comments (env-gated)", () => {
  if (PG_URL === undefined || PG_URL.length === 0) {
    test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    return;
  }
  let pool: Pool;
  let root: string;
  const snapFile = (): string => snapshotPath(join(root, ".metaobjects", "migrations"), "postgres");
  const pg = ["--cwd", "", "--db", PG_URL, "--dialect", "postgres"];
  const args = (...rest: string[]): string[] => [...rest, ...pg.map((a) => (a === "" ? root : a))];

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
    root = mkdtempSync(join(tmpdir(), "shadow-catalog-pg-"));
    mkdirSync(join(root, "metaobjects"), { recursive: true });
    writeFileSync(join(root, "metaobjects", "meta.catalog.json"), MODEL, "utf8");
    // Day 1: the table, with its comments and a GENERATED identity, and a v4 snapshot of it.
    expect((await captured(args("migrate", "--from-db", "--slug", "shadow-catalog", "--apply"))).exit).toBe(0);
  });
  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${TABLE} CASCADE`);
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  test("the database the migration built is clean, against the metadata and the snapshot", async () => {
    const live = await pool.query(`SELECT obj_description('${TABLE}'::regclass, 'pg_class') AS c`);
    expect(live.rows[0].c).toBe("Catalog rows.");
    expect((await captured(args("verify"))).exit).toBe(0);
  });

  test("a snapshot that never recorded identity and comments verifies clean as v3, and is a difference as v4", async () => {
    const written = readFileSync(snapFile(), "utf8");
    const file = JSON.parse(written) as SnapshotFile;
    expect(file.formatVersion).toBe(4);
    // What a v3 `baseline --from-db` wrote for this very table: no comments, no identity.
    for (const t of file.snapshot.tables) {
      delete t.description;
      for (const c of t.columns) { delete c.description; delete c.identity; }
    }
    try {
      writeFileSync(snapFile(), JSON.stringify({ ...file, formatVersion: 3 }), "utf8");
      expect((await captured(args("verify"))).exit).toBe(0);
      writeFileSync(snapFile(), JSON.stringify(file), "utf8");
      const v4 = await captured(args("verify"));
      expect(v4.exit).toBe(1);
      expect(v4.out).toContain("the committed schema snapshot disagrees");
    } finally {
      writeFileSync(snapFile(), written, "utf8");
    }
  });

  test("an undeclared live comment is drift for verify, and migrate keeps it unless --allow drop-comment", async () => {
    await pool.query(`COMMENT ON COLUMN ${TABLE}.qty IS 'set by a DBA'`);
    try {
      const verified = await captured(args("verify"));
      expect(verified.exit).toBe(1);
      expect(verified.out).toContain("comment");

      const kept = await captured(args("migrate", "--from-db", "--dry-run"));
      expect(kept.exit).toBe(0);
      expect(kept.out).not.toContain("IS NULL");
      expect(kept.out).toContain(`kept the comment on ${TABLE}.qty`);
      expect(kept.out).toContain("--allow drop-comment");

      const cleared = await captured(args("migrate", "--from-db", "--dry-run", "--allow", "drop-comment"));
      expect(cleared.exit).toBe(0);
      expect(cleared.out).toContain("COMMENT ON COLUMN");
      expect(cleared.out).toContain("IS NULL;");
      expect(cleared.out).not.toContain("kept the comment");
    } finally {
      await pool.query(`COMMENT ON COLUMN ${TABLE}.qty IS NULL`);
    }
  });
});
