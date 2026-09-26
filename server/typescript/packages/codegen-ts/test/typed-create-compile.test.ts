// The generated WRITE entry points are typed with the entity's insert input.
//
// `update<Entity>` has taken a typed `<Entity>Patch` since FR-035, but `create<Entity>` (and
// `insertPreserving<Entity>`, and a TPH subtype's `create<Sub>` / `update<Sub>ById`) took
// `data: unknown`. After renaming a field, tsc flagged every update and read site but not
// `create<Entity>(db, { oldName: … })`, which failed only at runtime as a ZodError.
//
// Each now takes `z.input<typeof <Entity>InsertSchema>` (exported as `<Entity>Create`), and
// still validates through the schema at runtime. Proven the only way that counts: a caller
// module compiled against the generated tree with the real TS compiler — a correct call is
// clean, a misspelt or missing field is an error at the call site.

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
    package: "brew",
    children: [
      { "object.entity": { name: "Brewer", children: [
        { "source.rdb": { "@table": "brewers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "displayName", "@required": true, "@maxLength": 80 } },
        { "field.string": { name: "email", "@required": true } },
        { "field.timestamp": { name: "createdAt", "@required": true, "@autoSet": "onCreate" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Party", "@discriminator": "partyType", children: [
        { "source.rdb": { "@table": "parties" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "partyType", "@values": ["Carrier"] } },
        { "field.string": { name: "label", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Carrier", extends: "Party", "@discriminatorValue": "Carrier", children: [
        { "field.int": { name: "fleetSize" } },
      ]}},
    ],
  },
};

async function loadModel(): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "typed-create.json" }),
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

/** Generate the tree, add `caller.ts` with `body`, compile everything; the caller's diagnostics. */
async function compileCaller(dialect: Dialect, body: string): Promise<{ all: string[]; caller: string[] }> {
  const root = await loadModel();
  const dir = mkdtempSync(join(import.meta.dir, `tmp-typed-create-${dialect}-`));
  try {
    const files = await generate(root, dialect, dir);
    for (const f of files) writeFileSync(join(dir, f.path), f.content);
    const caller = [
      `import { createBrewer, insertPreservingBrewer } from "./Brewer.queries";`,
      `import { createCarrier, updateCarrierById } from "./Party.queries";`,
      `declare const db: Parameters<typeof createBrewer>[0];`,
      `declare const tphDb: Parameters<typeof createCarrier>[0];`,
      `export async function run(): Promise<void> {`,
      body,
      `}`,
      ``,
    ].join("\n");
    writeFileSync(join(dir, "caller.ts"), caller);
    const all = compile(dir, [...files.map((f) => f.path), "caller.ts"]);
    return { all, caller: all.filter((d) => d.startsWith("caller.ts:")) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const dialect of ["postgres", "sqlite"] as const) {
  describe(`generated create calls are typed with the insert input (${dialect})`, () => {
    test("the signatures name the typed input, not unknown", async () => {
      const root = await loadModel();
      const dir = mkdtempSync(join(import.meta.dir, `tmp-typed-create-src-${dialect}-`));
      try {
        const files = await generate(root, dialect, dir);
        const brewer = files.find((f) => f.path === "Brewer.ts")!.content.replace(/\s+/g, " ");
        const queries = files.find((f) => f.path === "Brewer.queries.ts")!.content.replace(/\s+/g, " ");
        const party = files.find((f) => f.path === "Party.queries.ts")!.content.replace(/\s+/g, " ");
        expect(brewer).toContain("export type BrewerCreate = z.input<typeof BrewerInsertSchema>;");
        expect(brewer).toContain(
          "export type BrewerCreatePreserving = z.input< typeof BrewerInsertPreservingSchema >;",
        );
        expect(queries).toContain("data: BrewerCreate");
        expect(queries).toContain("data: BrewerCreatePreserving");
        expect(queries).not.toContain("data: unknown");
        expect(party).not.toContain("data: unknown");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("a correct create / insertPreserving / TPH create + update compiles clean", async () => {
      const { all } = await compileCaller(
        dialect,
        [
          `  await createBrewer(db, { displayName: "Cy", email: "cy@example.com" });`,
          `  await insertPreservingBrewer(db, { displayName: "Cy", email: "cy@example.com", createdAt: "2026-09-21T01:00:00Z" });`,
          `  await createCarrier(tphDb, { partyType: "Carrier", label: "Acme", fleetSize: 3 });`,
          `  await updateCarrierById(tphDb, 1, { fleetSize: 4 });`,
        ].join("\n"),
      );
      expect(all).toEqual([]);
    });

    test("a misspelt field in a create call is a compile error at the call site", async () => {
      const { caller } = await compileCaller(
        dialect,
        `  await createBrewer(db, { name: "Cy", email: "cy@example.com" });`,
      );
      expect(caller.length).toBeGreaterThan(0);
      expect(caller.join("\n")).toContain("name");
    });

    test("a missing required field in a create call is a compile error", async () => {
      const { caller } = await compileCaller(dialect, `  await createBrewer(db, { email: "cy@example.com" });`);
      expect(caller.join("\n")).toContain("displayName");
    });

    test("a misspelt field in a TPH subtype create / update is a compile error", async () => {
      const { caller } = await compileCaller(
        dialect,
        [
          `  await createCarrier(tphDb, { partyType: "Carrier", label: "Acme", fleet: 3 });`,
          `  await updateCarrierById(tphDb, 1, { fleet: 4 });`,
        ].join("\n"),
      );
      expect(caller.length).toBe(2);
    });
  });
}
