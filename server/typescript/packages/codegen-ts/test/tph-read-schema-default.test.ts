// A `@required` field that also carries `@default` in a TPH hierarchy.
//
// `@default` means "the caller may omit this on INSERT; the database fills it in".
// It says nothing about READING: the column is NOT NULL with a default, so a row of
// this subtype always carries a real value. Two emitters disagreed about that.
//
// The read schema asked `fieldWillBeOptional` (required OR has-a-default), so it
// emitted `.optional()` AND — through `isTphReadNullTolerant` — `.nullable()`, inferring
// `T | null | undefined`. The declared interface keyed its `?` on bare `@required`,
// declaring `T | null`. The value `parse<Base>()` returns was then not assignable to the
// base union and the generated module did not compile.
//
// Optionality-on-insert and null-tolerance-on-read are different questions; only the
// insert shape may consult `@default`. Asserted on the emitted text for both a
// base-declared and a subtype-declared field — the defect is not specific to the level
// the field is declared at — and by compiling the tree, which is the symptom adopters saw.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { namesFile } from "../src/generators/names-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { barrel } from "../src/generators/barrel.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { EmittedFile, GenContext } from "../src/generator.js";
import type { Dialect } from "../src/metaobjects-config.js";

const MODEL = {
  "metadata.root": {
    package: "demo",
    children: [
      { "object.entity": { name: "Party", "@discriminator": "partyType", children: [
        { "source.rdb": { "@table": "parties" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "partyType", "@values": ["Carrier", "Broker"] } },
        // Base-declared, required, with a default: every row carries it.
        { "field.boolean": { name: "active", "@required": true, "@default": true } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Carrier", extends: "Party", "@discriminatorValue": "Carrier", children: [
        // Subtype-declared, required, with a default.
        { "field.int": { name: "fleetSize", "@required": true, "@default": 1 } },
        // A subtype-declared field with NO default stays null-tolerant: it is NULL on a
        // sibling's row. This is the control that keeps the fix from over-reaching.
        { "field.string": { name: "dotNumber", "@maxLength": 20 } },
      ]}},
      { "object.entity": { name: "Broker", extends: "Party", "@discriminatorValue": "Broker", children: [
        { "field.string": { name: "mcNumber", "@maxLength": 20 } },
      ]}},
    ],
  },
};

async function loadModel(): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "tph-read-schema-default.json" }),
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
    includeNames: true,
  });
  // `matches` composed from each generator's own filter, as runner.ts does.
  const genCtx = (generator: { filter?: (e: MetaObject) => boolean }): GenContext => ({
    entities: root.objects(),
    loadedRoot: root,
    matches: (e) => generator.filter?.(e) ?? true,
    projectRoot: dir,
    config: { outDir: dir, extStyle: "none", dbImport: "./db", dialect } as never,
    renderContext,
    warn: () => {},
  });
  const generators = [entityFile(), namesFile(), queriesFile(), barrel()];
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

/** An emitted file with its whitespace collapsed, so assertions survive the formatter's line breaks. */
function fileNamed(files: EmittedFile[], path: string): string {
  const f = files.find((x) => x.path === path);
  if (f === undefined) throw new Error(`no emitted file ${path}; got ${files.map((x) => x.path).join(", ")}`);
  return f.content.replace(/\s+/g, " ");
}

/** The body of one emitted `z.object({...})`, whitespace already collapsed. */
function schemaBody(src: string, name: string): string {
  const m = new RegExp(`export const ${name} = z\\.object\\(\\{(.*?)\\}\\);`).exec(src);
  const body = m?.[1];
  if (body === undefined) throw new Error(`no ${name} in ${src.slice(0, 200)}`);
  return body;
}

/** One field's entry within a schema body: from `<name>:` up to the next `<name>:`. */
function entry(body: string, field: string): string {
  const m = new RegExp(`${field}: (?:(?!\\w+: ).)*`).exec(body);
  if (m === null) throw new Error(`no ${field} in ${body}`);
  return m[0].trim().replace(/,$/, "");
}

for (const dialect of ["postgres", "sqlite"] as const) {
  describe(`a required field with @default in a TPH hierarchy (${dialect})`, () => {
    test("the generated model tier compiles", async () => {
      const root = await loadModel();
      const dir = mkdtempSync(join(import.meta.dir, `tmp-tph-default-${dialect}-`));
      try {
        const files = await generate(root, dialect, dir);
        for (const f of files) {
          mkdirSync(dirname(join(dir, f.path)), { recursive: true });
          writeFileSync(join(dir, f.path), f.content);
        }
        expect(compile(dir, files.map((f) => f.path))).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("the read schema answers from the column, and never `.optional()`", async () => {
      const read = schemaBody(fileNamed(await generate(await loadModel(), dialect, "/x"), "Carrier.ts"), "CarrierSchema");
      // Base-declared + required + @default -> `.notNull().default(true)`: a real value on
      // every row. Neither optional NOR nullable — this is the entry FW-4 got wrong both ways.
      expect(entry(read, "active")).toBe("active: z.boolean()");
      // Subtype-declared -> the shared table cannot hold `.notNull()` (a Broker row stores
      // NULL there), so `.nullable()` is correct and stays. `.optional()` is not: the column
      // is selected on every read, so the key is always present.
      expect(entry(read, "fleetSize")).toBe("fleetSize: z.number().int().nullable()");
      expect(entry(read, "dotNumber")).toBe("dotNumber: z.string().max(20).nullable()");
      // The PK is the base table's key — present on every row.
      expect(entry(read, "id")).toBe("id: z.number().int()");
      expect(read).not.toContain(".optional()");
    });

    test("the declared interface admits exactly what the read schema infers", async () => {
      const carrier = fileNamed(await generate(await loadModel(), dialect, "/x"), "Carrier.ts");
      const iface = /export interface Carrier \{(.*?)\}/.exec(carrier)?.[1];
      expect(iface).toBeDefined();
      expect(iface).toContain("active: boolean;");
      expect(iface).toContain("fleetSize: number | null;");
    });

    test("the insert schema still lets the database supply a base column's default", async () => {
      const insert = schemaBody(fileNamed(await generate(await loadModel(), dialect, "/x"), "Carrier.ts"), "CarrierInsertSchema");
      expect(entry(insert, "active")).toBe("active: z.boolean().optional()");
    });
  });
}
