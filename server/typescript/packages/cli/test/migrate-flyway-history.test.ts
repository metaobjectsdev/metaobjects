/**
 * Flyway owns `flyway_schema_history` (adopter report D1).
 *
 * `meta migrate --from-db` diffs metadata against the live database. On a Flyway-managed
 * database the runner's own ledger is a live table the metadata never declares, so the diff
 * proposed `DROP TABLE flyway_schema_history`, and its hint said to re-run with
 * `--allow drop-table`. Following the hint deletes the runner's history.
 */
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { readSnapshot, snapshotPath } from "@metaobjectsdev/migrate-ts";
import { migrateCommand } from "../src/commands/migrate.js";
import { verifyCommand } from "../src/commands/verify.js";
import { buildKyselyFromUrl } from "../src/lib/kysely.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const MODEL = JSON.stringify({
  "metadata.root": {
    package: "acme::platform",
    children: [{
      "object.entity": {
        name: "Job",
        children: [
          { "source.rdb": { name: "src", "@table": "jobs" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

async function fixture(opts: { jobs: boolean } = { jobs: true }): Promise<{ root: string; db: string }> {
  const root = await mkdtemp(join(tmpdir(), "flyway-history-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.platform.json"), MODEL, "utf8");
  await mkdir(join(root, ".metaobjects"), { recursive: true });
  await writeFile(
    join(root, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1, migrate: { dialect: "sqlite" } }),
    "utf8",
  );
  const db = join(root, "t.db");
  const k = await buildKyselyFromUrl(`file:${db}`, "sqlite");
  try {
    if (opts.jobs) await sql`CREATE TABLE "jobs" (id INTEGER NOT NULL PRIMARY KEY)`.execute(k.db);
    await sql`CREATE TABLE "flyway_schema_history" (installed_rank INTEGER NOT NULL PRIMARY KEY)`.execute(k.db);
  } finally {
    await k.close();
  }
  return { root, db };
}

const files = async (dir: string): Promise<string[]> =>
  (await readdir(dir).catch(() => [] as string[])).filter((e) => !e.startsWith("."));

describe("meta migrate --from-db and Flyway's history table", () => {
  test("--migration-format flyway leaves flyway_schema_history out of the diff", async () => {
    const f = await fixture();
    const out = join(f.root, "flyway-out");
    // No --allow: a proposed DROP TABLE would be blocked and exit 1.
    const code = await migrateCommand(
      ["--from-db", "--db", `file:${f.db}`, "--dialect", "sqlite", "--migration-format", "flyway",
       "--out-dir", out, "--slug", "x"],
      f.root,
    );
    expect(code).toBe(0);
    expect(await files(out)).toEqual([]);
  });

  test("without the flyway format the table is still an unmodeled live table", async () => {
    const f = await fixture();
    const code = await migrateCommand(
      ["--from-db", "--db", `file:${f.db}`, "--dialect", "sqlite", "--slug", "x"],
      f.root,
    );
    expect(code).toBe(1);
  });

  test("meta verify --db agrees: the history table is no drift under the flyway format", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, migrate: { dialect: "sqlite", format: "flyway" } }),
      "utf8",
    );
    expect(await verifyCommand(["--db", `file:${f.db}`, "--dialect", "sqlite"], f.root)).toBe(0);
  });

  // A project baselined on a Flyway-managed database before the table was filtered at
  // introspection carries it in its committed snapshot, and that snapshot is one side of
  // both the offline diff and `verify --db`'s snapshot comparison.
  async function fixtureWithHistoryInSnapshot(): Promise<{ root: string; db: string }> {
    const f = await fixture();
    expect(await migrateCommand(["baseline", "--from-db", "--db", `file:${f.db}`, "--dialect", "sqlite"], f.root)).toBe(0);
    const snapshot = await readSnapshot(snapshotPath(join(f.root, ".metaobjects", "migrations"), "sqlite"));
    expect(snapshot?.tables.map((t) => t.name)).toContain("flyway_schema_history");
    return f;
  }

  test("offline --migration-format flyway does not propose dropping a history table the snapshot records", async () => {
    const f = await fixtureWithHistoryInSnapshot();
    const code = await migrateCommand(
      ["--dialect", "sqlite", "--migration-format", "flyway", "--slug", "x"],
      f.root,
    );
    expect(code).toBe(0);
    expect(await files(join(f.root, "src", "main", "resources", "db", "migration"))).toEqual([]);
  });

  test("offline without the flyway format still proposes the drop", async () => {
    const f = await fixtureWithHistoryInSnapshot();
    expect(await migrateCommand(["--dialect", "sqlite", "--slug", "x"], f.root)).toBe(1);
  });

  test("meta verify --db agrees with a snapshot that records the history table", async () => {
    const f = await fixtureWithHistoryInSnapshot();
    await writeFile(
      join(f.root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, migrate: { dialect: "sqlite", format: "flyway" } }),
      "utf8",
    );
    expect(await verifyCommand(["--db", `file:${f.db}`, "--dialect", "sqlite"], f.root)).toBe(0);
  });

  // The format reaches `meta verify` the way it reaches `meta migrate`: by flag, with no
  // `migrate.format` in the config. The same run without the flag is the drift case below.
  test("meta verify --db --migration-format flyway (flag, no config) leaves the history table out", async () => {
    const f = await fixture();
    expect(await verifyCommand(
      ["--db", `file:${f.db}`, "--dialect", "sqlite", "--migration-format", "flyway"], f.root,
    )).toBe(0);
  });

  test("the flag also covers a snapshot that records the history table", async () => {
    const f = await fixtureWithHistoryInSnapshot();
    expect(await verifyCommand(
      ["--db", `file:${f.db}`, "--dialect", "sqlite", "--migration-format", "flyway"], f.root,
    )).toBe(0);
  });

  test("the flag wins over the config key, as it does for meta migrate", async () => {
    const f = await fixture();
    await writeFile(
      join(f.root, ".metaobjects", "config.json"),
      JSON.stringify({ schema_version: 1, migrate: { dialect: "sqlite", format: "flyway" } }),
      "utf8",
    );
    expect(await verifyCommand(
      ["--db", `file:${f.db}`, "--dialect", "sqlite", "--migration-format", "default"], f.root,
    )).toBe(1);
  });

  test("meta verify refuses a migration format meta migrate does not accept", async () => {
    const f = await fixture();
    expect(await verifyCommand(
      ["--db", `file:${f.db}`, "--dialect", "sqlite", "--migration-format", "liquibase"], f.root,
    )).toBe(2);
  });

  // Flyway creates its history table on its first run, before any project table exists. An
  // offline baseline on such a database would record the metadata as already applied, so no
  // CREATE TABLE would ever be emitted: the empty-database refusal has to see it as empty.
  describe("migrate baseline on a database that holds only Flyway's history table", () => {
    const committedSnapshot = (root: string) =>
      readSnapshot(snapshotPath(join(root, ".metaobjects", "migrations"), "sqlite"));

    test("under the flyway format it is an empty database: refused, no snapshot written", async () => {
      const f = await fixture({ jobs: false });
      const code = await migrateCommand(
        ["baseline", "--db", `file:${f.db}`, "--dialect", "sqlite", "--migration-format", "flyway"], f.root,
      );
      expect(code).toBe(2);
      expect(await committedSnapshot(f.root)).toBeNull();
    });

    test("without the flyway format the table still counts as a live table", async () => {
      const f = await fixture({ jobs: false });
      expect(await migrateCommand(["baseline", "--db", `file:${f.db}`, "--dialect", "sqlite"], f.root)).toBe(0);
      expect((await committedSnapshot(f.root))?.tables.map((t) => t.name)).toEqual(["jobs"]);
    });
  });

  test("meta verify --db without the flyway format reports it as drift", async () => {
    const f = await fixture();
    expect(await verifyCommand(["--db", `file:${f.db}`, "--dialect", "sqlite"], f.root)).toBe(1);
  });
});
