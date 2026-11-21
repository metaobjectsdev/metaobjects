/**
 * `meta schema` (1.3.0 T3): print the expected schema, read-only.
 *
 * The oracle is the migration engine, not the command's own output: the DDL `meta schema`
 * prints is executed against an EMPTY real SQLite database, and then `meta migrate --db`
 * introspects that database and diffs it against the metadata. If the DDL left anything out
 * (a column, the foreign key, the projection's view) or added anything, migrate proposes a
 * change and writes a migration file. A schema that is exactly the expected one gives
 * "no changes" and no file.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@libsql/client";
import { parseSnapshot, SNAPSHOT_FORMAT_VERSION } from "@metaobjectsdev/migrate-ts";
import { run } from "../../src/index.js";
import { declareScope, scaffold } from "./support/scope-fixture.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Author",
          children: [
            { "source.rdb": { name: "src", "@table": "authors" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name", "@required": true, "@maxLength": 80 } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Book",
          children: [
            { "source.rdb": { name: "src", "@table": "books" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "title", "@required": true } },
            { "field.long": { name: "authorId", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "identity.reference": { name: "authorRef", "@fields": ["authorId"], "@references": "Author" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "BookView",
          children: [
            { "source.rdb": { name: "src", "@kind": "view", "@view": "v_books" } },
            { "field.long": { name: "id", extends: "acme::Book.id" } },
            { "field.string": { name: "title", extends: "acme::Book.title" } },
            { "identity.primary": { name: "pk", extends: "acme::Book.pk" } },
          ],
        },
      },
    ],
  },
});

function project(config?: Record<string, unknown>): string {
  const repo = mkdtempSync(join(tmpdir(), "meta-schema-"));
  mkdirSync(join(repo, "metaobjects"), { recursive: true });
  writeFileSync(join(repo, "metaobjects", "meta.books.json"), META, "utf8");
  if (config !== undefined) {
    mkdirSync(join(repo, ".metaobjects"), { recursive: true });
    writeFileSync(join(repo, ".metaobjects", "config.json"), JSON.stringify({ schema_version: 1, ...config }), "utf8");
  }
  return repo;
}

/** Every path under `dir`, relative, so a test can prove a run wrote nothing. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

describe("meta schema", () => {
  test("the sqlite DDL builds exactly the schema meta migrate expects: tables, foreign key and view", async () => {
    const repo = project();
    const out = join(repo, "schema.sql");
    const dbUrl = `file:${join(repo, "local.db")}`;
    try {
      expect(await run(["schema", "--cwd", repo, "--dialect", "sqlite", "--out", out])).toBe(0);
      const sql = readFileSync(out, "utf8");

      const client = createClient({ url: dbUrl });
      await client.executeMultiple(sql);
      const objects = await client.execute("SELECT name, type FROM sqlite_master WHERE type IN ('table','view')");
      const fks = await client.execute("PRAGMA foreign_key_list(books)");
      client.close();
      const byName = new Map(objects.rows.map((r) => [String(r.name), String(r.type)]));
      expect(byName.get("authors")).toBe("table");
      expect(byName.get("books")).toBe("table");
      expect(byName.get("v_books")).toBe("view");
      expect(fks.rows.map((r) => [String(r.table), String(r.from), String(r.to)])).toEqual([["authors", "author_id", "id"]]);

      // The engine's own introspect-and-diff finds nothing to do, so writes no migration.
      expect(await run(["migrate", "--from-db", "--cwd", repo, "--db", dbUrl, "--dialect", "sqlite", "--slug", "probe"])).toBe(0);
      const migrations = join(repo, ".metaobjects", "migrations");
      // Each migration is a directory holding up.sql and down.sql, so look all the way down.
      const written = existsSync(migrations) ? tree(migrations).filter((f) => f.endsWith(".sql")) : [];
      expect(written).toEqual([]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30000);

  test("--as json is the neutral snapshot document, stable across runs, naming the same objects", async () => {
    const repo = project();
    try {
      const a = join(repo, "a.json");
      const b = join(repo, "b.json");
      expect(await run(["schema", "--cwd", repo, "--dialect", "postgres", "--as", "json", "--out", a])).toBe(0);
      expect(await run(["schema", "--cwd", repo, "--dialect", "postgres", "--as", "json", "--out", b])).toBe(0);
      const text = readFileSync(a, "utf8");
      expect(readFileSync(b, "utf8")).toBe(text);
      expect((JSON.parse(text) as { formatVersion: number }).formatVersion).toBe(SNAPSHOT_FORMAT_VERSION);
      const snapshot = parseSnapshot(text);
      expect(snapshot.tables.map((t) => t.name).sort()).toEqual(["authors", "books"]);
      expect(snapshot.views.map((v) => v.name)).toEqual(["v_books"]);
      expect(snapshot.tables.find((t) => t.name === "books")?.columns.map((c) => c.name).sort())
        .toEqual(["author_id", "id", "title"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("is read-only: no snapshot, no migration, no file of any kind without --out", async () => {
    const repo = project({ migrate: { dialect: "postgres" } });
    try {
      const before = tree(repo);
      const proc = Bun.spawnSync(["bun", join(import.meta.dirname, "../../bin/meta.ts"), "schema", "--cwd", repo]);
      expect(proc.exitCode).toBe(0);
      // The dialect came from migrate.dialect: Postgres DDL, not SQLite.
      const stdout = proc.stdout.toString();
      expect(stdout).toContain('CREATE TABLE "books"');
      expect(stdout).toContain("GENERATED BY DEFAULT AS IDENTITY");
      expect(tree(repo)).toEqual(before);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("leaves out what migrate.scope does not govern, as meta migrate does", async () => {
    const { repo } = scaffold("meta-schema-scope-");
    try {
      declareScope(repo, ["acme::platform::**"]);
      const out = join(repo, "schema.sql");
      expect(await run(["schema", "--cwd", repo, "--dialect", "sqlite", "--out", out])).toBe(0);
      const sql = readFileSync(out, "utf8");
      expect(sql).toContain('CREATE TABLE "jobs"');
      expect(sql).not.toContain('"matches"');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("refuses, exit 2, a scope that matches nothing, no dialect, mysql, and an unknown --as", async () => {
    const { repo } = scaffold("meta-schema-refuse-");
    try {
      declareScope(repo, ["nobody::**"]);
      expect(await run(["schema", "--cwd", repo, "--dialect", "sqlite"])).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
    const bare = project();
    try {
      expect(await run(["schema", "--cwd", bare])).toBe(2);
      expect(await run(["schema", "--cwd", bare, "--dialect", "mysql"])).toBe(2);
      expect(await run(["schema", "--cwd", bare, "--dialect", "sqlite", "--as", "yaml"])).toBe(2);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
