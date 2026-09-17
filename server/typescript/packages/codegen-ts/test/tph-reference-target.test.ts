// A reference or M:N relationship whose TARGET is a TPH subtype.
//
// A TPH subtype has no table of its own: it lives in its discriminator base's single
// table, and its module (`Carrier.ts`) exports schemas and types but no Drizzle table
// const. Every site that bound "the other side" of a reference derived the import from
// the TARGET's own name, so an FK, a junction's one() side, or an M:N traversal onto
// `Carrier` imported `carriers` from a module that never exports it: the generated tree
// did not compile. The binding has to land on the base (`parties` from `Party.ts`), and
// an M:N onto a subtype has to filter the base table's rows by discriminator, because
// the junction FK can only point at the base table and a Broker id in it is not a Carrier.
//
// Compiling is necessary and not sufficient. A `.references()` that silently disappears
// compiles fine, and so does an M:N route with no discriminator filter, so the presence
// of each is asserted on the emitted text as well.
//
// The model is TS-local on purpose, and mirrors migrate-ts's
// `expected-schema-tph.test.ts`, which asserts the same FKs from the DDL side.

import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import ts from "typescript";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { namesFile } from "../src/generators/names-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
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
      { "object.entity": { name: "Depot", children: [
        { "source.rdb": { "@table": "depots" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      { "object.entity": { name: "Party", "@discriminator": "partyType", children: [
        { "source.rdb": { "@table": "parties" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "partyType", "@values": ["Carrier", "Broker"] } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ]}},
      // An abstract intermediate level: its reference is a column of `parties` too.
      { "object.entity": { name: "Organization", extends: "Party", abstract: true, children: [
        { "field.long": { name: "hqDepotId" } },
        { "identity.reference": { name: "fkHqDepot", "@fields": "hqDepotId", "@references": "Depot" } },
      ]}},
      { "object.entity": { name: "Carrier", extends: "Organization", "@discriminatorValue": "Carrier", children: [
        { "field.long": { name: "homeDepotId" } },
        { "identity.reference": { name: "fkHomeDepot", "@fields": "homeDepotId", "@references": "Depot" } },
      ]}},
      { "object.entity": { name: "Broker", extends: "Party", "@discriminatorValue": "Broker", children: [
        { "field.string": { name: "mcNumber", "@maxLength": 20 } },
      ]}},
      { "object.entity": { name: "Shipment", children: [
        { "source.rdb": { "@table": "shipments" } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "relationship.association": { name: "carriers", "@cardinality": "many", "@objectRef": "Carrier", "@through": "Leg" } },
      ]}},
      // The M:N junction, with a cardinality-one navigation onto the subtype as well.
      { "object.entity": { name: "Leg", children: [
        { "source.rdb": { "@table": "legs" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "shipmentId", "@required": true } },
        { "field.long": { name: "carrierId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "identity.reference": { name: "fkShipment", "@fields": "shipmentId", "@references": "Shipment" } },
        { "identity.reference": { name: "fkCarrier", "@fields": "carrierId", "@references": "Carrier" } },
        { "relationship.association": { name: "carrier", "@cardinality": "one", "@objectRef": "Carrier" } },
      ]}},
    ],
  },
};

async function loadModel(): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "tph-reference-target.json" }),
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
  // `matches` composed from each generator's own filter, as runner.ts does — a TPH
  // subtype gets no table and no routes by design, and must not be reported as a gap.
  const genCtx = (generator: { filter?: (e: MetaObject) => boolean }): GenContext => ({
    entities: root.objects(),
    loadedRoot: root,
    matches: (e) => generator.filter?.(e) ?? true,
    projectRoot: dir,
    config: { outDir: dir, extStyle: "none", dbImport: "./db", dialect } as never,
    renderContext,
    warn: () => {},
  });
  const generators = [entityFile(), namesFile(), queriesFile(), routesFile(), barrel()];
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

/** Does this column's declaration carry `.references(() => <target>)`? Compared with
 *  whitespace and commas stripped: the formatter wraps long callbacks differently per
 *  dialect. The declaration runs up to the next column. */
function referencesTarget(src: string, field: string, anyColumn: string, target: string): boolean {
  const m = new RegExp(` ${field}: \\w+\\((?:(?! \\w+: \\w+\\().)*`).exec(src);
  if (m === null) throw new Error(`no column ${field}`);
  return m[0].replace(/[\s,]/g, "").includes(`.references(():${anyColumn}=>${target})`);
}

for (const dialect of ["postgres", "sqlite"] as const) {
  describe(`reference onto a TPH subtype (${dialect})`, () => {
    const anyColumn = dialect === "postgres" ? "AnyPgColumn" : "AnySQLiteColumn";

    test("the generated model tier compiles", async () => {
      const root = await loadModel();
      // Under the package so drizzle-orm and zod resolve to their REAL types from this
      // package's node_modules. Routes are left out of the program for the reason the
      // codegen-compile gate leaves them out: the server framework's types are not on an
      // in-memory compile's path. Their binding is asserted on text below, and the M:N
      // discriminator filter is exercised against a real database in runtime-ts.
      const dir = mkdtempSync(join(import.meta.dir, `tmp-tph-ref-${dialect}-`));
      try {
        const files = (await generate(root, dialect, dir)).filter((f) => !f.path.endsWith(".routes.ts"));
        for (const f of files) {
          mkdirSync(dirname(join(dir, f.path)), { recursive: true });
          writeFileSync(join(dir, f.path), f.content);
        }
        expect(compile(dir, files.map((f) => f.path))).toEqual([]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test("FKs onto the subtype reference the base table", async () => {
      const leg = fileNamed(await generate(await loadModel(), dialect, "/x"), "Leg.ts");
      expect(leg).toMatch(/import \{ parties \} from "\.\/Party\.js"/);
      expect(leg).not.toContain("carriers");
      expect(referencesTarget(leg, "carrierId", anyColumn, "parties.id")).toBe(true);
      // The cardinality-one navigation and the junction's one() side, both onto `parties`.
      expect(leg).toContain("carrier: one(parties, { fields: [legs.carrierId], references: [parties.id] })");
      expect(leg).toContain("fkCarrier: one(parties, { fields: [legs.carrierId], references: [parties.id], })");
    });

    test("references declared on a subtype or an intermediate level keep their FKs", async () => {
      const party = fileNamed(await generate(await loadModel(), dialect, "/x"), "Party.ts");
      expect(referencesTarget(party, "homeDepotId", anyColumn, "depots.id")).toBe(true);
      expect(referencesTarget(party, "hqDepotId", anyColumn, "depots.id")).toBe(true);
    });

    test("the M:N traversal targets the base table, filtered to the subtype", async () => {
      const routes = fileNamed(await generate(await loadModel(), dialect, "/x"), "Shipment.routes.ts");
      expect(routes).toMatch(/import \{ parties \} from "\.\/Party\.js"/);
      expect(routes).not.toContain("carriers }");
      expect(routes).toContain("targetTable: parties,");
      expect(routes).toContain("targetPkColumn: PartyNames.fields.id.column,");
      expect(routes).toMatch(
        /targetDiscriminator: \{ column: PartyNames\.fields\.partyType\.column, value: "Carrier",? \}/,
      );
    });
  });
}
