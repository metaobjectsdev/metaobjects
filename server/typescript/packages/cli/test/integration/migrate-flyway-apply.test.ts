/**
 * #192 real-engine gate for the Flyway output adapter.
 *
 * Every migrate change in this repo carries this gate, because a green unit suite
 * has historically missed exactly this class: emit -> apply to a REAL engine ->
 * re-diff must be EMPTY. Filenames being well-formed proves nothing about whether
 * the emitted SQL is complete.
 *
 * The load-bearing assertion is the convergence one: after applying V1__, a second
 * migrate against the advanced snapshot must report no changes and write no V2__.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { run } from "../../src/index.js";

const ENTITY = (fields: string) => JSON.stringify({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "Order",
        children: [
          { "field.long": { name: "id" } },
          ...JSON.parse(fields),
          { "source.rdb": { name: "src", "@table": "orders" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

const ONE_FIELD = '[{"field.string":{"name":"ref"}}]';
const TWO_FIELDS = '[{"field.string":{"name":"ref"}},{"field.string":{"name":"note"}}]';

function setupRepo(): { repo: string; dbUrl: string; flywayDir: string } {
  const repo = mkdtempSync(join(tmpdir(), "migrate-flyway-apply-"));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeFileSync(join(repo, "metaobjects", "meta.orders.json"), ENTITY(ONE_FIELD), "utf8");
  return {
    repo,
    dbUrl: `file:${join(repo, "local.db")}`,
    flywayDir: join(repo, "src", "main", "resources", "db", "migration"),
  };
}

const visible = (dir: string) => readdirSync(dir).filter((e) => !e.startsWith(".")).sort();

/** Apply a .sql file to the real sqlite db, statement by statement. */
async function applySql(dbUrl: string, file: string): Promise<void> {
  const sql = readFileSync(file, "utf8");
  const client = createClient({ url: dbUrl });
  try {
    for (const stmt of sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0)) {
      await client.execute(stmt);
    }
  } finally {
    client.close();
  }
}

describe("meta migrate --migration-format flyway (real sqlite)", () => {
  test("emits V1__, applies against a real engine, and converges", async () => {
    const { repo, dbUrl, flywayDir } = setupRepo();
    try {
      // 1. Generate from an empty DB. --from-db introspects the (empty) database,
      //    so the diff is the full CREATE TABLE.
      const exit = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite",
        "--migration-format", "flyway", "--from-db", "--slug", "init",
      ]);
      expect(exit).toBe(0);
      expect(visible(flywayDir)).toEqual(["U1__init.sql", "V1__init.sql"]);

      // 2. The emitted SQL must actually run on a real engine.
      await applySql(dbUrl, join(flywayDir, "V1__init.sql"));

      const client = createClient({ url: dbUrl });
      const objects = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      );
      client.close();
      expect(objects.rows.map((r) => String(r.name))).toContain("orders");

      // 3. CONVERGENCE — the load-bearing assertion. Re-diffing the now-migrated
      //    database must find nothing left to do, and write no second migration.
      const exit2 = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite",
        "--migration-format", "flyway", "--from-db",
      ]);
      expect(exit2).toBe(0);
      expect(visible(flywayDir)).toEqual(["U1__init.sql", "V1__init.sql"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30000);

  test("a follow-up change emits V2__ past the existing V1__ and also applies", async () => {
    const { repo, dbUrl, flywayDir } = setupRepo();
    try {
      const exit = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite",
        "--migration-format", "flyway", "--from-db", "--slug", "init",
      ]);
      expect(exit).toBe(0);
      await applySql(dbUrl, join(flywayDir, "V1__init.sql"));

      // Add a field, regenerate against the live (migrated) DB.
      writeFileSync(join(repo, "metaobjects", "meta.orders.json"), ENTITY(TWO_FIELDS), "utf8");
      const exit2 = await run([
        "migrate", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite",
        "--migration-format", "flyway", "--from-db", "--slug", "add_note",
      ]);
      expect(exit2).toBe(0);
      // The counter advanced past V1__ — it did not restart, and the U__ file did
      // not double-bump it to V3__.
      expect(visible(flywayDir)).toEqual([
        "U1__init.sql", "U2__add_note.sql", "V1__init.sql", "V2__add_note.sql",
      ]);

      await applySql(dbUrl, join(flywayDir, "V2__add_note.sql"));
      const client = createClient({ url: dbUrl });
      const cols = await client.execute("PRAGMA table_info(orders)");
      client.close();
      expect(cols.rows.map((r) => String(r.name))).toContain("note");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30000);
});
