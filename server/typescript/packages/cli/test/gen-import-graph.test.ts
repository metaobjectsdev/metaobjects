// `meta gen` touches no database, so running it loads no query builder and no driver.
// It used to: the schema advice it prints imported the migrate-ts package root, whose
// introspect / apply / replay modules import kysely, and kysely was a seventh of gen's
// start-up. The gen path reads `@metaobjectsdev/migrate-ts/offline` instead; a driver is
// imported dynamically, by the commands that connect, when they connect.
//
// Behaviour, not source: a real `genCommand` run, in a child Bun process that refuses to
// load the database packages the migrate commands connect with (the oracle is that list of
// package names; `bun:sqlite` is a builtin Bun will not let a plugin override). The run must finish and write the entity.
// The controls prove the refusal is live: the same child fails when asked to import
// kysely, or the migrate-ts package root that used to drag it in.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const WORKSPACE_TMP = resolve(import.meta.dirname, "fixtures", "__tmp__");
const GEN = resolve(import.meta.dirname, "..", "src", "commands", "gen.ts");

const DATABASE_PACKAGES = ["kysely", "pg", "mysql2", "better-sqlite3", "@libsql/client", "@libsql/kysely-libsql"];

const PLUGIN = `
Bun.plugin({
  name: "refuse-database-packages",
  setup(build) {
    for (const name of ${JSON.stringify(DATABASE_PACKAGES)}) {
      build.module(name, () => {
        throw new Error("DATABASE_PACKAGE_LOADED: " + name);
      });
    }
  },
});
`;

const RUNNER = `
const [mode, root] = process.argv.slice(2);
if (mode === "gen") {
  const { genCommand } = await import(${JSON.stringify(GEN)});
  process.exit(await genCommand([], root));
}
await import(mode);
`;

let dir: string;
let project: string;

beforeAll(() => {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  dir = mkdtempSync(join(WORKSPACE_TMP, "gen-import-graph-"));
  writeFileSync(join(dir, "plugin.ts"), PLUGIN);
  writeFileSync(join(dir, "runner.ts"), RUNNER);

  project = join(dir, "project");
  mkdirSync(join(project, "metaobjects"), { recursive: true });
  mkdirSync(join(project, ".metaobjects"), { recursive: true });
  writeFileSync(
    join(project, "metaobjects", "meta.app.json"),
    JSON.stringify({
      "metadata.root": {
        package: "app",
        children: [
          {
            "object.entity": {
              name: "Talk",
              children: [
                { "source.rdb": { "@table": "talks" } },
                { "field.long": { name: "id" } },
                { "field.string": { name: "title", "@required": true } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
        ],
      },
    }),
  );
  writeFileSync(join(project, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, sources: [] }));
  writeFileSync(
    join(project, "metaobjects.config.ts"),
    `
import { defineConfig } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  outDir: ${JSON.stringify(join(project, "generated"))},
  dialect: "sqlite",
  dbImport: "~/db",
  extStyle: "none",
  generators: ["entity"],
});
`,
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function child(mode: string) {
  const proc = Bun.spawnSync(["bun", "--preload", join(dir, "plugin.ts"), join(dir, "runner.ts"), mode, project], {
    cwd: project,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode, output: `${proc.stdout}${proc.stderr}` };
}

describe("meta gen loads no database package", () => {
  test("a gen run finishes with every database package refused", () => {
    const result = child("gen");
    expect(result.output).not.toContain("DATABASE_PACKAGE_LOADED");
    expect(result.code).toBe(0);
    expect(existsSync(join(project, "generated"))).toBe(true);
  });

  test("control: the refusal rejects kysely", () => {
    const result = child("kysely");
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("DATABASE_PACKAGE_LOADED: kysely");
  });

  test("control: the refusal rejects the migrate-ts package root", () => {
    const result = child("@metaobjectsdev/migrate-ts");
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("DATABASE_PACKAGE_LOADED");
  });
});
