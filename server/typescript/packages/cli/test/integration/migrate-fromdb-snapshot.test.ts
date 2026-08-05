/**
 * Real-engine gate for the live-DB generate path advancing the committed snapshot.
 *
 * The day-1 command `meta init` prints —
 *   meta migrate --from-db --db file:dev.sqlite --dialect sqlite --slug init --apply
 * — applied the schema but never wrote the snapshot, so the day-2 documented
 * incremental flow (`meta migrate --dialect sqlite --slug <name>`) errored with
 * `no schema snapshot` on a project whose database was provably correct.
 *
 * Every migrate change in this repo carries the same gate, because a green unit
 * suite has repeatedly missed this class: emit -> apply to a REAL engine ->
 * introspect -> re-diff must be EMPTY. A snapshot file merely existing proves
 * nothing; the load-bearing assertions are that the OFFLINE follow-up produces a
 * migration, that migration applies, and the live re-diff then converges.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";

const ENTITY = (fields: string) => JSON.stringify({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "Author",
        children: [
          { "field.long": { name: "id" } },
          ...JSON.parse(fields),
          { "source.rdb": { name: "src", "@table": "authors" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

const ONE_FIELD = '[{"field.string":{"name":"name"}}]';
const TWO_FIELDS = '[{"field.string":{"name":"name"}},{"field.string":{"name":"bio"}}]';

function setupRepo(): { repo: string; dbUrl: string; migrationsDir: string; snapshot: string } {
  const repo = mkdtempSync(join(tmpdir(), "migrate-fromdb-snapshot-"));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeFileSync(join(repo, "metaobjects", "meta.authors.json"), ENTITY(ONE_FIELD), "utf8");
  const migrationsDir = join(repo, ".metaobjects", "migrations");
  return {
    repo,
    dbUrl: `file:${join(repo, "dev.sqlite")}`,
    migrationsDir,
    snapshot: join(migrationsDir, ".schema.sqlite.json"),
  };
}

/** Each migration is a `<timestamp>-<slug>/` directory holding up.sql + down.sql. */
const migrationDirs = (dir: string) =>
  existsSync(dir) ? readdirSync(dir).filter((e) => !e.startsWith(".")).sort() : [];

async function tableColumns(dbUrl: string, table: string): Promise<string[]> {
  const client = createClient({ url: dbUrl });
  try {
    const cols = await client.execute(`PRAGMA table_info(${table})`);
    return cols.rows.map((r) => String(r.name));
  } finally {
    client.close();
  }
}

describe("meta migrate live-DB path: committed snapshot (real sqlite)", () => {
  test("the greenfield --from-db --apply command leaves the documented offline flow working", async () => {
    const { repo, dbUrl, migrationsDir, snapshot } = setupRepo();
    try {
      // Day 1 — verbatim the command `meta init` prints as its next step.
      const exit = await run([
        "migrate", "--cwd", repo, "--from-db", "--db", dbUrl,
        "--dialect", "sqlite", "--slug", "init", "--apply",
      ]);
      expect(exit).toBe(0);
      expect(await tableColumns(dbUrl, "authors")).toContain("name");
      expect(existsSync(snapshot)).toBe(true);

      // Day 2 — add a field and run the documented incremental (offline) flow.
      // This is the command that used to fail with `no schema snapshot`.
      writeFileSync(join(repo, "metaobjects", "meta.authors.json"), ENTITY(TWO_FIELDS), "utf8");
      const exit2 = await run([
        "migrate", "--cwd", repo, "--dialect", "sqlite", "--slug", "add-bio",
      ]);
      expect(exit2).toBe(0);
      // A real migration was emitted for the new column (not "no changes").
      const emitted = migrationDirs(migrationsDir).filter((f) => f.endsWith("-add-bio"));
      expect(emitted.length).toBe(1);
      expect(readFileSync(join(migrationsDir, emitted[0]!, "up.sql"), "utf8")).toContain("bio");

      // Apply it, then prove the live database converges: re-diffing against the
      // real engine must find nothing left to do.
      const exit3 = await run([
        "migrate", "apply-pending", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite",
      ]);
      expect(exit3).toBe(0);
      expect(await tableColumns(dbUrl, "authors")).toContain("bio");

      const exit4 = await run([
        "migrate", "--cwd", repo, "--from-db", "--db", dbUrl, "--dialect", "sqlite",
      ]);
      expect(exit4).toBe(0);
      // Convergence: no second migration was written for the same change.
      expect(migrationDirs(migrationsDir).filter((f) => f.endsWith("-add-bio"))).toEqual(emitted);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60000);

  test("--apply without --from-db also advances the snapshot, so the next offline diff is clean", async () => {
    const { repo, dbUrl, migrationsDir, snapshot } = setupRepo();
    try {
      const exit = await run([
        "migrate", "--cwd", repo, "--from-db", "--db", dbUrl,
        "--dialect", "sqlite", "--slug", "init", "--apply",
      ]);
      expect(exit).toBe(0);

      // The documented "everyday changes ...and apply it" variant: no --from-db,
      // but --apply still routes through the live-DB path.
      writeFileSync(join(repo, "metaobjects", "meta.authors.json"), ENTITY(TWO_FIELDS), "utf8");
      const exit2 = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite",
        "--slug", "add-bio", "--apply",
      ]);
      expect(exit2).toBe(0);
      expect(await tableColumns(dbUrl, "authors")).toContain("bio");
      expect(existsSync(snapshot)).toBe(true);

      // The snapshot kept up, so an offline diff finds nothing — it does NOT
      // re-emit the already-applied ADD COLUMN (which would fail at apply).
      const before = migrationDirs(migrationsDir);
      const exit3 = await run([
        "migrate", "--cwd", repo, "--dialect", "sqlite", "--slug", "should-be-empty",
      ]);
      expect(exit3).toBe(0);
      expect(migrationDirs(migrationsDir)).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60000);

  test("--dry-run writes no snapshot", async () => {
    const { repo, dbUrl, snapshot } = setupRepo();
    try {
      const exit = await run([
        "migrate", "--cwd", repo, "--from-db", "--db", dbUrl,
        "--dialect", "sqlite", "--slug", "init", "--dry-run",
      ]);
      expect(exit).toBe(0);
      expect(existsSync(snapshot)).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60000);

  test("a blocked destructive change leaves the snapshot untouched", async () => {
    const { repo, dbUrl, snapshot } = setupRepo();
    try {
      const exit = await run([
        "migrate", "--cwd", repo, "--from-db", "--db", dbUrl,
        "--dialect", "sqlite", "--slug", "init", "--apply",
      ]);
      expect(exit).toBe(0);
      const applied = readFileSync(snapshot, "utf8");

      // Drop a column without --allow: blocked, exit 1, snapshot must not move
      // (advancing it would record a schema the database is not in).
      writeFileSync(
        join(repo, "metaobjects", "meta.authors.json"),
        ENTITY('[]'),
        "utf8",
      );
      const exit2 = await run([
        "migrate", "--cwd", repo, "--from-db", "--db", dbUrl,
        "--dialect", "sqlite", "--slug", "drop-name",
      ]);
      expect(exit2).not.toBe(0);
      expect(readFileSync(snapshot, "utf8")).toBe(applied);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60000);
});
