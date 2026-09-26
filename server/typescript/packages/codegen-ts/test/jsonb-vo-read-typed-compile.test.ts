// A jsonb value-object column is typed on READ, on every dialect.
//
// On SQLite/D1 a `field.object @storage: jsonb` column was emitted as
// `text(…, { mode: "json" })` with no `.$type<VO>()`, so Drizzle inferred the column as
// `unknown` and a finder's row carried it untyped: `(await findCustomerById(db, 2))
// ?.address?.city` failed with TS2339 "Property 'city' does not exist on type '{}'". The
// Postgres `jsonb()` column already carried `.$type<VO>()`. Array-of-VO columns were typed
// on both. Proven the only way that counts: a caller module reading nested members through
// the generated finder, compiled against the generated tree with the real TS compiler.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { EmittedFile, GenContext } from "../src/generator.js";
import type { Dialect } from "../src/metaobjects-config.js";

const MODEL = {
  "metadata.root": {
    package: "rentals",
    children: [
      { "object.value": { name: "GeoPoint", children: [
        { "field.double": { name: "lat", "@required": true } },
        { "field.double": { name: "lng", "@required": true } },
      ]}},
      { "object.value": { name: "Address", children: [
        { "field.string": { name: "street", "@required": true, "@maxLength": 120 } },
        { "field.string": { name: "city", "@required": true, "@maxLength": 80 } },
        { "field.object": { name: "geo", "@objectRef": "GeoPoint", "@storage": "jsonb" } },
      ]}},
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "fullName", "@required": true, "@maxLength": 100 } },
        { "field.object": { name: "address", "@objectRef": "Address", "@storage": "jsonb" } },
        { "field.object": { name: "pastAddresses", "@objectRef": "Address", "@storage": "jsonb", isArray: true } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
    ],
  },
};

async function loadModel(): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "jsonb-vo-read.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

async function generate(root: MetaRoot, dialect: Dialect, dir: string): Promise<EmittedFile[]> {
  const renderContext = makeRenderContext({
    dialect,
    loadedRoot: root,
    outDir: dir,
    dbImport: "./db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  const genCtx = (generator: { filter?: (e: MetaObject) => boolean }): GenContext => ({
    entities: root.objects(),
    loadedRoot: root,
    matches: (e) => generator.filter?.(e) ?? true,
    projectRoot: dir,
    config: { outDir: dir, extStyle: "none", dbImport: "./db", dialect } as never,
    renderContext,
    warn: () => {},
  });
  const generators = [entityFile({ allowlists: false }), queriesFile()];
  return (await Promise.all(generators.map((g) => g.generate(genCtx(g))))).flat();
}

function compile(dir: string, paths: string[]): string[] {
  const program = ts.createProgram(
    paths.map((p) => join(dir, p)),
    {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      skipLibCheck: true,
    },
  );
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where =
      d.file && d.start !== undefined
        ? `${d.file.fileName.slice(dir.length + 1)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
        : "";
    return `${where}${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
  });
}

async function compileCaller(dialect: Dialect, body: string): Promise<string[]> {
  const root = await loadModel();
  const dir = mkdtempSync(join(import.meta.dir, `tmp-jsonb-vo-read-${dialect}-`));
  try {
    const files = await generate(root, dialect, dir);
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    const caller = [
      `import { findCustomerById } from "./Customer.queries";`,
      `declare const db: Parameters<typeof findCustomerById>[0];`,
      `export async function run(): Promise<void> {`,
      `  const c = await findCustomerById(db, 2);`,
      body,
      `}`,
      ``,
    ].join("\n");
    writeFileSync(join(dir, "caller.ts"), caller);
    return compile(dir, [...files.map((f) => f.path), "caller.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const dialect of ["postgres", "sqlite"] as const) {
  describe(`a jsonb value-object column is typed on read (${dialect})`, () => {
    test("the column carries .$type<VO>() / .$type<VO[]>() with a type-only import", async () => {
      const root = await loadModel();
      const dir = mkdtempSync(join(import.meta.dir, `tmp-jsonb-vo-src-${dialect}-`));
      try {
        const files = await generate(root, dialect, dir);
        const customer = files.find((f) => f.path === "Customer.ts")!.content.replace(/\s+/g, " ");
        expect(customer).toContain(".$type<Address>()");
        expect(customer).toContain(".$type<Address[]>()");
        expect(customer).toMatch(/import (type \{[^}]*\bAddress\b|\{[^}]*\btype Address\b)/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("nested members read through the generated finder compile clean", async () => {
      const diagnostics = await compileCaller(
        dialect,
        [
          `  const city: string | undefined = c?.address?.city;`,
          `  const lat: number | undefined = c?.address?.geo?.lat;`,
          `  const first: string | undefined = c?.pastAddresses?.[0]?.street;`,
          `  void city; void lat; void first;`,
        ].join("\n"),
      );
      expect(diagnostics).toEqual([]);
    });

    test("a misspelt nested member is a compile error", async () => {
      const diagnostics = await compileCaller(dialect, `  void c?.address?.citty;`);
      expect(diagnostics.join("\n")).toContain("citty");
    });
  });
}
