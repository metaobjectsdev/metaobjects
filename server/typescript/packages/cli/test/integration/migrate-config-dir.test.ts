/**
 * The config a command reads comes from the directory the METADATA was resolved
 * from, never from ambient cwd.
 *
 * `metaobjects.config.ts` carries `columnNamingStrategy`. Once metadata resolves
 * from the nearest ancestor holding `.metaobjects/config.json`, reading that file
 * from cwd instead silently splits the two: run `meta migrate` from a subdirectory
 * of a project whose root declares `literal` and the metadata comes from the
 * ancestor while the strategy defaults to `snake_case` — emitting a migration that
 * RENAMES EVERY COLUMN. Newly reachable, too: before metadata sources were
 * resolvable, that invocation just failed with "no metaobjects/ found".
 *
 * The gate is byte-level and comparative, not a spot-check on one identifier: the
 * SQL a subdirectory run emits must be byte-identical to the SQL the project-root
 * run emits. A drifting default shows up as a diff whether or not anyone thought
 * to assert on the setting that drifted.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { run } from "../../src/index.js";

// Temp dirs live inside the monorepo so jiti can resolve @metaobjectsdev/* when
// it loads metaobjects.config.ts (same rationale as gen-sqlite.test.ts).
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");

const USERS = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [{
      "object.entity": {
        name: "User",
        children: [
          { "source.rdb": { name: "src", "@table": "users" } },
          { "field.long": { name: "id" } },
          // Two words, so `literal` and `snake_case` produce DIFFERENT column names.
          { "field.string": { name: "firstName" } },
          { "identity.primary": { name: "pk", "@fields": ["id"] } },
        ],
      },
    }],
  },
});

/** A project whose ROOT declares `columnNamingStrategy: "literal"`, with an
 *  otherwise-empty subdirectory to run from. */
function scaffold(): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const repo = mkdtempSync(join(WORKSPACE_TMP, "migrate-config-dir-"));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeFileSync(join(repo, "metaobjects", "meta.users.json"), USERS, "utf8");
  mkdirSync(join(repo, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(repo, ".metaobjects", "config.json"),
    JSON.stringify({ schema_version: 1 }),
    "utf8",
  );
  writeFileSync(
    join(repo, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(repo, "generated"))},
  dialect: "sqlite",
  columnNamingStrategy: "literal",
  generators: [],
});
`,
    "utf8",
  );
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  return repo;
}

/** The `up.sql` the run wrote, read out of the project root's migrations dir. */
function emittedUpSql(repo: string): string {
  const migrations = join(repo, ".metaobjects", "migrations");
  const dirs = readdirSync(migrations).filter((d) => d.endsWith("-init"));
  expect(dirs).toHaveLength(1);
  return readFileSync(join(migrations, dirs[0]!, "up.sql"), "utf8");
}

async function migrateFrom(repo: string, runDir: string): Promise<string> {
  const exit = await run([
    "migrate", "--from-db", "--cwd", runDir,
    "--db", `file:${join(repo, "local.db")}`,
    "--dialect", "sqlite", "--slug", "init",
  ]);
  expect(exit).toBe(0);
  return emittedUpSql(repo);
}

describe("meta migrate — config comes from the resolved config dir", () => {
  test("a subdirectory run emits byte-identical SQL to a project-root run", async () => {
    const fromRoot = scaffold();
    const fromSubdir = scaffold();
    try {
      const rootSql = await migrateFrom(fromRoot, fromRoot);
      const subdirSql = await migrateFrom(fromSubdir, join(fromSubdir, "apps", "api"));

      // Both runs honour the root's `literal` strategy. Asserted explicitly as
      // well as comparatively, so a failure says WHICH way it went rather than
      // only that the two disagree.
      expect(rootSql).toContain("firstName");
      expect(rootSql).not.toContain("first_name");

      // The paths differ per temp dir, so compare the SQL bodies only — nothing
      // in generated DDL should mention an absolute path anyway.
      expect(subdirSql).toBe(rootSql);
    } finally {
      rmSync(fromRoot, { recursive: true, force: true });
      rmSync(fromSubdir, { recursive: true, force: true });
    }
  });

  test("a subdirectory run writes its migration under the project root, not the subdirectory", async () => {
    const repo = scaffold();
    try {
      await migrateFrom(repo, join(repo, "apps", "api"));
      // `outDir` is relative (`./.metaobjects/migrations`) and must resolve against
      // the config dir, or the migration lands somewhere the next run cannot find.
      expect(readdirSync(join(repo, ".metaobjects", "migrations")).length).toBeGreaterThan(0);
      expect(readdirSync(join(repo, "apps", "api"))).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
