import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("migrate command with --dialect d1", () => {
  let dir: string;
  let cwdBefore: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrate-d1-cmd-"));
    cwdBefore = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty DB + one entity → emits 0001_<slug>.sql with CREATE TABLE", async () => {
    // Set up wrangler.toml with one D1 binding.
    writeFileSync(join(dir, "wrangler.toml"), [
      `name = "test-app"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "test-db"`,
      `database_id = "test-id"`,
    ].join("\n"));

    // Set up a minimal metaobjects/ with one entity.
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.users.json"), JSON.stringify({
      "metadata.root": {
        "package": "test::users",
        "children": [{
          "object.entity": {
            "name": "User",
            "children": [
              { "field.long":   { "name": "id" } },
              { "field.string": { "name": "email" } },
              { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ]
          }
        }]
      }
    }));

    // Mock the wrangler runner — return an empty DB.
    const runnerCalls: string[][] = [];
    const mockRunner = async (args: string[], _cwd: string) => {
      runnerCalls.push(args);
      // Extract the SQL from the args (arg pattern: ... --command <sql> ...)
      const cmdIdx = args.indexOf("--command");
      const sql = cmdIdx >= 0 ? args[cmdIdx + 1] ?? "" : "";
      if (sql.includes("sqlite_version")) {
        return { stdout: JSON.stringify([{ success: true, results: [{ v: "3.44.2" }] }]), stderr: "" };
      }
      return { stdout: JSON.stringify([{ success: true, results: [] }]), stderr: "" };
    };

    const { migrateCommand } = await import("../../src/commands/migrate.js");
    const code = await migrateCommand(["--dialect", "d1", "--slug", "init"], dir, mockRunner);
    expect(code).toBe(0);

    const migrationsDir = join(dir, "migrations");
    expect(existsSync(migrationsDir)).toBe(true);
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(files).toEqual(["0001_init.sql"]);
    const sql = readFileSync(join(migrationsDir, "0001_init.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE");
    expect(sql).not.toMatch(/BEGIN/);
    // .down sidecar exists too:
    expect(existsSync(join(migrationsDir, ".down", "0001_init.sql"))).toBe(true);
  });

  test("errors when wrangler.toml is missing and --d1 is not supplied", async () => {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.users.json"), JSON.stringify({
      "metadata.root": { "package": "test::users", "children": [] },
    }));

    const { migrateCommand } = await import("../../src/commands/migrate.js");
    const code = await migrateCommand(["--dialect", "d1", "--slug", "init"], dir);
    expect(code).toBe(2);
  });

  test("errors when --db is supplied with --dialect d1", async () => {
    writeFileSync(join(dir, "wrangler.toml"), `name = "x"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "x"\ndatabase_id = "y"\n`);
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.users.json"), JSON.stringify({
      "metadata.root": { "package": "test::users", "children": [] },
    }));

    const { migrateCommand } = await import("../../src/commands/migrate.js");
    const code = await migrateCommand(["--dialect", "d1", "--db", "file:foo.db", "--slug", "init"], dir);
    expect(code).toBe(2);
  });
});
