/**
 * #479 — Prisma as the ORM, end to end: one place to declare a field, and a build that fails when
 * Prisma and the model drift.
 *
 *  - `meta gen` under `orm: "prisma"` writes schema.prisma (prisma-schema) and contract-only
 *    entity modules (no Drizzle import), and `prisma validate` accepts the schema.
 *  - `meta verify --codegen` fails when schema.prisma is hand-edited.
 *  - `prisma db push` from the generated schema gives a database `meta verify --db` passes, and a
 *    deliberate change to that database fails it: on SQLite always, and on Postgres when
 *    MIGRATE_TS_PG_URL names a server (the ts-slow lane's sidecar). Each Postgres run creates a
 *    database of its own and drops it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient } from "@libsql/client";
import pg from "pg";
import { run } from "../../src/index.js";

const CLI_ROOT = resolve(import.meta.dirname, "../..");
const PRISMA_BIN = join(CLI_ROOT, "node_modules", ".bin", "prisma");
const SHOP = resolve(CLI_ROOT, "../codegen-ts/test/prisma/fixtures/shop/metaobjects");
// Under the cli package so the project's config resolves `@metaobjectsdev/codegen-ts` and
// `prisma/config` through the workspace (gitignored).
const WORKSPACE_TMP = resolve(import.meta.dirname, "../fixtures/__tmp__");
const PG_URL = process.env.MIGRATE_TS_PG_URL;

type Dialect = "postgres" | "sqlite";

function project(dialect: Dialect, prismaOpts = ""): string {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, "prisma-schema-"));
  cpSync(SHOP, join(root, "metaobjects"), { recursive: true });
  writeFileSync(
    join(root, "metaobjects.config.ts"),
    `import { defineConfig, prismaSchemaFile } from "@metaobjectsdev/codegen-ts";
export default defineConfig({
  orm: "prisma",
  dialect: ${JSON.stringify(dialect)},
  outDir: ${JSON.stringify(join(root, "src/generated"))},
  extStyle: "none",
  targets: { prisma: { outDir: ${JSON.stringify(join(root, "prisma"))} } },
  generators: ["entity", prismaSchemaFile({ target: "prisma"${prismaOpts} })],
});
`,
  );
  return root;
}

function prismaConfig(root: string, url: string): void {
  writeFileSync(
    join(root, "prisma.config.ts"),
    `import { defineConfig } from "prisma/config";
export default defineConfig({ schema: "prisma/schema.prisma", datasource: { url: ${JSON.stringify(url)} } });
`,
  );
}

/** Runs the Prisma CLI in `root`; returns its exit code and output. */
function prisma(root: string, ...args: string[]): { code: number; output: string } {
  const p = Bun.spawnSync([PRISMA_BIN, ...args, "--config", join(root, "prisma.config.ts")], {
    cwd: root,
    env: { ...process.env, PRISMA_HIDE_UPDATE_MESSAGE: "1", CHECKPOINT_DISABLE: "1" },
  });
  return { code: p.exitCode, output: `${p.stdout.toString()}${p.stderr.toString()}` };
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
const all = (): string => [...out, ...err].join("\n");

describe("orm: prisma — gen, prisma validate, verify --codegen", () => {
  test("gen writes schema.prisma and contract-only entity modules, and Prisma accepts the schema", async () => {
    const root = project("postgres");
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const schema = readFileSync(join(root, "prisma/schema.prisma"), "utf8");
      expect(schema).toContain('provider = "postgresql"');
      expect(schema).toContain("model Customer {");
      expect(existsSync(join(root, "prisma/schema.checks.sql"))).toBe(true);
      // The entity modules are Zod schemas and types: no Drizzle table, no DB layer.
      const entities = readdirSync(join(root, "src/generated")).filter((f) => f.endsWith(".ts"));
      expect(entities.length).toBeGreaterThan(0);
      for (const f of entities) expect(readFileSync(join(root, "src/generated", f), "utf8")).not.toContain("drizzle-orm");

      prismaConfig(root, "postgresql://u:p@localhost:5432/x");
      const v = prisma(root, "validate");
      expect(v.output).toContain("is valid");
      expect(v.code).toBe(0);
      // `prisma format` leaves the file as written, so formatting it is not an edit.
      expect(prisma(root, "format").code).toBe(0);
      expect(readFileSync(join(root, "prisma/schema.prisma"), "utf8")).toBe(schema);

      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a hand edit to schema.prisma is drift, and gen puts the file back", async () => {
    const root = project("postgres");
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const schemaPath = join(root, "prisma/schema.prisma");
      const written = readFileSync(schemaPath, "utf8");
      appendFileSync(schemaPath, "\nmodel Extra {\n  id Int @id\n}\n");
      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(1);
      expect(all()).toContain("schema.prisma");
      expect(await run(["gen", "--cwd", root])).toBe(0);
      expect(readFileSync(schemaPath, "utf8")).toBe(written);
      expect(await run(["verify", "--cwd", root, "--codegen"])).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a Drizzle-bound generator is refused under orm: prisma", async () => {
    const root = project("postgres");
    try {
      const cfg = join(root, "metaobjects.config.ts");
      writeFileSync(cfg, readFileSync(cfg, "utf8").replace('generators: ["entity",', 'generators: ["entity", "queries",'));
      expect(await run(["gen", "--cwd", root])).not.toBe(0);
      expect(all()).toContain('orm: "prisma" refuses "queries"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** The schema gate's changes from a `verify --format json` run, as `kind name` strings. */
async function schemaChanges(root: string, url: string): Promise<{ exit: number; changes: string[] }> {
  out = []; err = [];
  const exit = await run(["verify", "--cwd", root, "--db", url, "--dialect", "sqlite", "--format", "json"]);
  const payload = JSON.parse(out.join("\n")) as { schemaDrift?: { changes?: Array<{ kind: string; object: string; detail: string }> } };
  return { exit, changes: (payload.schemaDrift?.changes ?? []).map((c) => `${c.kind} ${c.detail}`) };
}

describe("orm: prisma — prisma db push, then meta verify --db (sqlite)", () => {
  test("the pushed database differs from the model only by the CHECKs SQLite cannot add; a changed one differs more", async () => {
    const root = project("sqlite", ', checks: "omit"');
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      const dbFile = join(root, "app.db");
      prismaConfig(root, `file:${dbFile}`);
      const push = prisma(root, "db", "push");
      expect(push.output).toContain("in sync");
      expect(push.code).toBe(0);

      // Every type, default, key, index and foreign key matches. What is left is the CHECKs:
      // SQLite cannot add one to a table Prisma created, so `checks: "omit"` leaves them out
      // and the gate reports each missing (docs/recipes/prisma.md, "SQLite").
      const url = `file:${dbFile}`;
      const pushed = await schemaChanges(root, url);
      expect(pushed.changes.map((c) => c.split(" (")[0])).toEqual([
        "add-check customers check customers_display_name_length_chk",
        "add-check customers check customers_tier_chk",
        "add-check orders check orders_total_numeric_chk",
      ]);

      const client = createClient({ url });
      await client.execute("ALTER TABLE tags ADD COLUMN stray TEXT");
      client.close();
      const changed = await schemaChanges(root, url);
      expect(changed.exit).toBe(1);
      expect(changed.changes.some((c) => c.startsWith("drop-column") && c.includes("stray"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

describe("orm: prisma — prisma db push, then meta verify --db (postgres, env-gated)", () => {
  if (PG_URL === undefined || PG_URL.length === 0) {
    // The ts-slow lane arms this: there the URL is the sidecar's, and a missing one is a broken
    // lane, not a skip.
    if (process.env.MIGRATE_TS_PG_EXPECT === "1") {
      test("MIGRATE_TS_PG_URL is set where MIGRATE_TS_PG_EXPECT=1 says a Postgres is", () => {
        expect(PG_URL).toBeDefined();
      });
    } else {
      test.skip("skipped — MIGRATE_TS_PG_URL not set", () => {});
    }
    return;
  }

  test("the pushed database, with the checks applied, matches the model; a changed column does not", async () => {
    const dbName = `mo_prisma_${process.pid}_${Date.now()}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(PG_URL);
    url.pathname = `/${dbName}`;
    const root = project("postgres");
    try {
      expect(await run(["gen", "--cwd", root])).toBe(0);
      prismaConfig(root, url.toString());
      const push = prisma(root, "db", "push");
      expect(push.output).toContain("in sync");
      expect(push.code).toBe(0);
      const checks = prisma(root, "db", "execute", "--file", join(root, "prisma/schema.checks.sql"));
      expect(checks.code).toBe(0);
      // The checks file is idempotent on Postgres: a second push and a second apply change nothing.
      expect(prisma(root, "db", "push").code).toBe(0);
      expect(prisma(root, "db", "execute", "--file", join(root, "prisma/schema.checks.sql")).code).toBe(0);

      out = []; err = [];
      const ok = await run(["verify", "--cwd", root, "--db", url.toString()]);
      expect(all()).not.toContain("drift (");
      expect(ok).toBe(0);

      const db = new pg.Client({ connectionString: url.toString() });
      await db.connect();
      await db.query('ALTER TABLE customers ALTER COLUMN email TYPE varchar(300)');
      await db.end();
      out = []; err = [];
      expect(await run(["verify", "--cwd", root, "--db", url.toString()])).toBe(1);
      expect(all()).toContain("email");
    } finally {
      rmSync(root, { recursive: true, force: true });
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  }, 120_000);
});
