// Where "the other side" of a reference is THIS entity's own table, or a table only an
// ancestor owns. Three shapes, each found by the pairwise feature-combination gate
// (integration-tests, feature-combinations-pg) with every other gate green:
//
//   - a cardinality-one relationship onto the declaring entity itself (`Order.parent`)
//     imported the entity's own table const from its own module, clashing with the local
//     declaration (TS2440). A TPH base navigating to one of its subtypes is the same case
//     once the subtype binds to the base's table;
//   - an M:N self-join's route mount imported the source table a second time, beside the
//     entity-module import that already brings it in (TS2300 — and a SyntaxError when
//     Node loads the module);
//   - a reference onto an ABSTRACT level of a TPH hierarchy imported a table const from a
//     module that has none: the rows live in the discriminator base's table.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { InMemoryStringSource, MetaDataLoader, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { entityFile } from "../src/generators/entity-file.js";
import { namesFile } from "../src/generators/names-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { barrel } from "../src/generators/barrel.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { EmittedFile, GenContext } from "../src/generator.js";

const pk = { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } };

const MODEL = {
  "metadata.root": {
    package: "demo",
    children: [
      // Self-referencing one, and both self-join M:N shapes, on a plain entity.
      { "object.entity": { name: "Order", children: [
        { "source.rdb": { "@table": "orders" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "parentOrderId" } },
        pk,
        { "identity.reference": { name: "fkParent", "@fields": "parentOrderId", "@references": "Order" } },
        { "relationship.association": { name: "parent", "@cardinality": "one", "@objectRef": "Order" } },
        { "relationship.association": { name: "follows", "@cardinality": "many", "@objectRef": "Order", "@through": "OrderLink", "@sourceRefField": "fromOrderId" } },
        { "relationship.association": { name: "siblings", "@cardinality": "many", "@objectRef": "Order", "@through": "OrderPair", "@symmetric": true } },
      ]}},
      { "object.entity": { name: "OrderLink", children: [
        { "source.rdb": { "@table": "order_links" } },
        { "field.long": { name: "fromOrderId", "@required": true } },
        { "field.long": { name: "toOrderId", "@required": true } },
        { "identity.primary": { name: "pk", "@fields": ["fromOrderId", "toOrderId"] } },
        { "identity.reference": { name: "fkFrom", "@fields": "fromOrderId", "@references": "Order" } },
        { "identity.reference": { name: "fkTo", "@fields": "toOrderId", "@references": "Order" } },
      ]}},
      { "object.entity": { name: "OrderPair", children: [
        { "source.rdb": { "@table": "order_pairs" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "aOrderId", "@required": true } },
        { "field.long": { name: "bOrderId", "@required": true } },
        pk,
        { "identity.reference": { name: "fkA", "@fields": "aOrderId", "@references": "Order" } },
        { "identity.reference": { name: "fkB", "@fields": "bOrderId", "@references": "Order" } },
      ]}},
      // A TPH base navigating to its own subtype, and a reference onto an abstract level.
      { "object.entity": { name: "Party", "@discriminator": "partyType", children: [
        { "source.rdb": { "@table": "parties" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "partyType", "@values": ["Carrier"] } },
        { "field.long": { name: "preferredCarrierId" } },
        pk,
        { "identity.reference": { name: "fkPreferred", "@fields": "preferredCarrierId", "@references": "Carrier" } },
        { "relationship.association": { name: "preferredCarrier", "@cardinality": "one", "@objectRef": "Carrier" } },
      ]}},
      { "object.entity": { name: "Organization", extends: "Party", abstract: true, children: [
        { "field.string": { name: "legalName", "@maxLength": 80 } },
      ]}},
      { "object.entity": { name: "Carrier", extends: "Organization", "@discriminatorValue": "Carrier" } },
      { "object.entity": { name: "Contract", children: [
        { "source.rdb": { "@table": "contracts" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "organizationId", "@required": true } },
        pk,
        { "identity.reference": { name: "fkOrganization", "@fields": "organizationId", "@references": "Organization" } },
      ]}},
    ],
  },
};

async function generate(): Promise<{ root: MetaRoot; files: EmittedFile[] }> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "reference-binding.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  const root = result.root;
  const renderContext = makeRenderContext({
    dialect: "postgres", loadedRoot: root, outDir: "/x", dbImport: "./db",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root), includeNames: true,
  });
  const genCtx = (g: { filter?: (e: MetaObject) => boolean }): GenContext => ({
    entities: root.objects(), loadedRoot: root, matches: (e) => g.filter?.(e) ?? true, projectRoot: "/x",
    config: { outDir: "/x", extStyle: "none", dbImport: "./db", dialect: "postgres" } as never,
    renderContext, warn: () => {},
  });
  const generators = [entityFile(), namesFile(), queriesFile(), routesFile(), barrel()];
  return { root, files: (await Promise.all(generators.map((g) => g.generate(genCtx(g))))).flat() };
}

describe("a reference whose other side is the entity's own table, or an ancestor's", () => {
  test("the model tier compiles", async () => {
    const { files } = await generate();
    // Under the package so drizzle-orm and zod resolve to their real types. Routes are
    // excluded here for the reason the codegen-compile gate excludes them; the
    // feature-combination gate compiles them against the real server framework.
    const dir = mkdtempSync(join(import.meta.dir, "tmp-reference-binding-"));
    try {
      const model = files.filter((f) => !f.path.endsWith(".routes.ts"));
      for (const f of model) writeFileSync(join(dir, f.path), f.content);
      const program = ts.createProgram(model.map((f) => join(dir, f.path)), {
        strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
      });
      const diagnostics = ts.getPreEmitDiagnostics(program).map((d) =>
        `${d.file?.fileName.slice(dir.length + 1) ?? ""} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
      expect(diagnostics).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an M:N self-join route file imports the source table once", async () => {
    const { files } = await generate();
    const routes = files.find((f) => f.path === "Order.routes.ts")!.content;
    // Every import declaration's bound names, flattened: a binding named twice is the
    // defect, whatever module the second one comes from.
    const bound = [...routes.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from/g)]
      .flatMap((m) => m[1]!.split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean));
    expect(bound.filter((name, i) => bound.indexOf(name) !== i)).toEqual([]);
    expect(routes).toContain("targetTable: orders,");
  });
});
