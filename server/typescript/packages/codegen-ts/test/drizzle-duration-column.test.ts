// field.duration in the generated Drizzle modules: the column is the module-local duration codec
// (a `customType`, never an import from drizzle core), declared ONCE per module — including the
// write-through entity whose table and replica view share one file — and the module compiles on
// every dialect. The codec's behaviour is held to fixtures/duration-wire/vectors.json by
// duration-wire-helper.test.ts; this file runs it once more through a real SQLite round trip.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";
import type { Dialect } from "../src/metaobjects-config.js";

async function loadRoot() {
  const json = JSON.stringify({
    "metadata.root": {
      package: "test",
      children: [
        {
          "object.entity": {
            name: "Hold",
            children: [
              { "source.rdb": { "@table": "hold" } },
              { "field.int": { name: "id" } },
              { "field.duration": { name: "holdFor", "@required": true } },
              { "field.duration": { name: "grace" } },
              { "field.duration": { name: "laps", isArray: true } },
              { "identity.primary": { name: "pk", "@fields": "id" } },
            ],
          },
        },
        {
          "object.entity": {
            name: "Timer",
            children: [
              // Write-through: the table and its replica view land in one module.
              { "source.rdb": { "@kind": "table", "@table": "timer", "@role": "primary" } },
              { "source.rdb": { "@kind": "view", "@view": "v_timer", "@role": "replica" } },
              { "field.int": { name: "id" } },
              { "field.duration": { name: "period", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": "id" } },
            ],
          },
        },
        {
          "object.projection": {
            name: "HoldView",
            children: [
              { "source.rdb": { "@kind": "view", "@view": "v_hold" } },
              { "field.int": { name: "id", extends: "Hold.id", "@required": true } },
              { "field.duration": { name: "holdFor", extends: "Hold.holdFor", "@required": true } },
              { "identity.primary": { name: "pk", extends: "Hold.pk" } },
            ],
          },
        },
      ],
    },
  });
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  return result.root;
}

function compile(dir: string, files: string[]): readonly ts.Diagnostic[] {
  const program = ts.createProgram(files.map((f) => join(dir, f)), {
    strict: true,
    noEmit: true,
    noUncheckedIndexedAccess: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
  });
  return ts.getPreEmitDiagnostics(program);
}

async function generate(dialect: Dialect, dir: string) {
  const root = await loadRoot();
  const renderContext = makeRenderContext({ outputLayout: "flat",
    dialect,
    loadedRoot: root,
    outDir: dir,
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    projectRoot: dir,
    config: { outputLayout: "flat", outDir: dir, extStyle: "none", dbImport: "~/db", dialect } as never,
    renderContext,
    warn: () => {},
  };
  return await entityFile({ allowlists: false }).generate(ctx);
}

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe("generated field.duration columns", () => {
  for (const dialect of ["sqlite", "postgres", "mysql"] as const) {
    test(`${dialect}: the codec is local, declared once per module, and every module compiles`, async () => {
      const dir = mkdtempSync(join(import.meta.dir, `tmp-duration-${dialect}-`));
      try {
        const files = await generate(dialect, dir);
        for (const f of files) writeFileSync(join(dir, f.path), f.content);
        const core = `drizzle-orm/${dialect === "postgres" ? "pg" : dialect}-core`;

        for (const name of ["Hold", "Timer", "HoldView"]) {
          const file = files.find((f) => f.path === `${name}.ts`);
          expect(file, `${name}.ts was generated`).toBeDefined();
          const content = file!.content;
          expect(occurrences(content, "const durationColumn =")).toBe(1);
          expect(content).not.toMatch(new RegExp(`import\\s*\\{[^}]*durationColumn[^}]*\\}\\s*from\\s*"${core}"`));
          expect(content).toContain(`durationColumn(`);
        }
        const hold = files.find((f) => f.path === "Hold.ts")!.content;
        expect(hold).toContain(dialect === "postgres" ? 'dataType: () => "interval"' : dialect === "mysql" ? 'dataType: () => "bigint"' : 'dataType: () => "integer"');
        // The write schemas carry the canonicalizing helper, once.
        expect(occurrences(hold, "function durationWrite(")).toBe(1);
        if (dialect === "postgres") expect(hold).toMatch(/laps: durationColumn\([^)]*\)\.array\(\)/);

        const diagnostics = compile(dir, files.map((f) => f.path));
        expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"))).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("sqlite: a duration is stored as integer microseconds, reads back canonical, and orders as a span", async () => {
    const dir = mkdtempSync(join(import.meta.dir, "tmp-duration-sqlite-run-"));
    try {
      const files = await generate("sqlite", dir);
      for (const f of files) writeFileSync(join(dir, f.path), f.content);
      // The generated module imports `~/db` only from the query files; the table module needs
      // drizzle alone, which resolves from this package.
      const mod = (await import(pathToFileURL(join(dir, "Hold.ts")).href)) as Record<string, unknown>;
      const { drizzle } = await import("drizzle-orm/bun-sqlite");
      const { asc, eq, gt, lt } = await import("drizzle-orm");
      const sqlite = new Database(":memory:");
      sqlite.run("CREATE TABLE hold (id INTEGER PRIMARY KEY, hold_for INTEGER NOT NULL, grace INTEGER, laps TEXT)");
      const db = drizzle(sqlite);
      // biome-ignore lint/suspicious/noExplicitAny: the generated table, imported dynamically
      const table = mod.holds as any;
      const insert = (mod.HoldInsertSchema as { parse(v: unknown): Record<string, unknown> }).parse({
        id: 1, holdFor: "P1DT0.5S", grace: "-PT90S", laps: ["PT90M"],
      });
      await db.insert(table).values(insert);
      expect(sqlite.query("SELECT hold_for, grace FROM hold").get()).toEqual({ hold_for: 86400500000, grace: -90000000 });
      // A filter value binds through the codec too: a spelling of the same span matches.
      const rows = await db.select().from(table).where(eq(table.holdFor, "P1DT0.5S"));
      expect(rows).toEqual([{ id: 1, holdFor: "PT24H0.5S", grace: "-PT1M30S", laps: ["PT1H30M"] }]);
      // Ordering is the span's, not the text's: PT9S < PT10S < PT1H (as text, "PT10S" < "PT1H" < "PT9S").
      const parse = (mod.HoldInsertSchema as { parse(v: unknown): Record<string, unknown> }).parse;
      for (const [id, holdFor] of [[2, "PT10S"], [3, "PT9S"], [4, "PT1H"], [5, "-PT1M"]] as const) {
        await db.insert(table).values(parse({ id, holdFor }));
      }
      const sorted = await db.select({ holdFor: table.holdFor }).from(table).orderBy(asc(table.holdFor));
      expect(sorted.map((r: { holdFor: string }) => r.holdFor)).toEqual(["-PT1M", "PT9S", "PT10S", "PT1H", "PT24H0.5S"]);
      const between = await db.select({ id: table.id }).from(table)
        .where(gt(table.holdFor, "PT9S")).orderBy(asc(table.holdFor));
      expect(between.map((r: { id: number }) => r.id)).toEqual([2, 4, 1]);
      const under = await db.select({ id: table.id }).from(table).where(lt(table.holdFor, "PT10S")).orderBy(asc(table.id));
      expect(under.map((r: { id: number }) => r.id)).toEqual([3, 5]);
      // runtime-ts binds a SQLite operand as the microsecond integer; the codec passes it through.
      const byMicros = await db.select({ id: table.id }).from(table).where(eq(table.holdFor, 10000000 as never));
      expect(byMicros).toEqual([{ id: 2 }]);
      sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
