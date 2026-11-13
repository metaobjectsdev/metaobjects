// An object's collection name (its own `@collectionName`, else the project's `naming.collections`
// pluralizer over its name) names every generated collection symbol: `list<Plural>`, the reverse
// finders, the Drizzle collection variable and the REST segment (`$path`). A project that
// declares neither keeps every name byte for byte, and the generated model tier compiles
// under each setting.

import { describe, expect, test, setDefaultTimeout } from "bun:test";
import { COMPILE_TEST_TIMEOUT_MS } from "../compile-timeout.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  DEFAULT_PHYSICAL_NAMING, InMemoryStringSource, MetaDataLoader, type MetaObject, type MetaRoot,
} from "@metaobjectsdev/metadata";
import { entityFile } from "../../src/generators/entity-file.js";
import { namesFile } from "../../src/generators/names-file.js";
import { queriesFile } from "../../src/generators/queries-file.js";
import { routesFile } from "../../src/generators/routes-file.js";
import { barrel } from "../../src/generators/barrel.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import { assertNoCollectionNameCollisions } from "../../src/naming/collection-name-collision.js";
import { hookListNameSegment, listFnName, reverseFinderFnName } from "../../src/naming.js";
import type { EmittedFile, GenContext } from "../../src/generator.js";

setDefaultTimeout(COMPILE_TEST_TIMEOUT_MS);

const pk = { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } };

const MODEL = [
  { "object.entity": { name: "Faq", "@collectionName": "FAQs", children: [
    { "source.rdb": { "@table": "faq" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "question", "@maxLength": 200 } },
    pk,
  ]}},
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "orders" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "faqId" } },
    pk,
    { "identity.reference": { name: "faqRef", "@fields": "faqId", "@references": "Faq" } },
  ]}},
];

async function load(collections?: string): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "demo", children: MODEL } }), { id: "collections.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  if (collections !== undefined) result.root.physicalNaming = { ...DEFAULT_PHYSICAL_NAMING, collections };
  return result.root;
}

async function generate(root: MetaRoot): Promise<Map<string, string>> {
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
  const files: EmittedFile[] = (await Promise.all(generators.map((g) => g.generate(genCtx(g))))).flat();
  return new Map(files.map((f) => [f.path, f.content]));
}

function compile(files: Map<string, string>): string[] {
  // Under the package so drizzle-orm and zod resolve; the route tier is framework-bound and
  // proven by the api-contract lane, as in every compile gate.
  const dir = mkdtempSync(join(import.meta.dir, "tmp-collection-names-"));
  try {
    const paths: string[] = [];
    for (const [path, content] of files) {
      if (path.includes(".routes")) continue;
      writeFileSync(join(dir, path), content);
      paths.push(join(dir, path));
    }
    const program = ts.createProgram(paths, {
      strict: true, noEmit: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, skipLibCheck: true,
    });
    return ts.getPreEmitDiagnostics(program).map((d) =>
      `${d.file?.fileName.slice(dir.length + 1) ?? ""} ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("collection names in the generated model tier", () => {
  test("a declared @collectionName names its collection symbols; an undeclared object keeps its own", async () => {
    const root = await load();
    const files = await generate(root);
    const faq = root.findObject("Faq")!;
    const order = root.findObject("Order")!;
    expect(listFnName(faq)).toBe("listFAQs");
    expect(listFnName(order)).toBe("listOrders");
    expect(files.get("Faq.queries.ts")).toContain("export async function listFAQs(");
    expect(files.get("Faq.ts")).toContain("export const fAQs = pgTable(");
    expect(files.get("Faq.ts")).toContain(`"/faqs"`);
    expect(files.get("Order.queries.ts")).toContain("export async function listOrders(");
    expect(files.get("Order.queries.ts")).toContain("export async function findOrdersByFaq(");
    expect(compile(files)).toEqual([]);
  });

  test("naming.collections: none keeps names singular, and a list hook never shadows the detail hook", async () => {
    const root = await load("none");
    const files = await generate(root);
    const order = root.findObject("Order")!;
    expect(listFnName(order)).toBe("listOrder");
    expect(reverseFinderFnName(order, "faqId")).toBe("findOrderByFaq");
    expect(hookListNameSegment(order)).toBe("OrderList");
    expect(files.get("Order.queries.ts")).toContain("export async function listOrder(");
    expect(files.get("Order.ts")).toContain("export const order = pgTable(");
    expect(files.get("Order.ts")).toContain(`"/order"`);
    // A declared name still wins over the configured pluralizer.
    expect(files.get("Faq.queries.ts")).toContain("export async function listFAQs(");
    expect(compile(files)).toEqual([]);
  });

  test("two objects whose collection names meet are refused by name", async () => {
    const result = await new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "demo", children: [
        ...MODEL,
        { "object.entity": { name: "Question", "@collectionName": "FAQs", children: [
          { "source.rdb": { "@table": "questions" } },
          { "field.long": { name: "id" } },
          pk,
        ]}},
      ] } }), { id: "collide.json" }),
    ]);
    expect(result.errors.map((e) => e.message)).toEqual([]);
    expect(() => assertNoCollectionNameCollisions(result.root.objects())).toThrow(/"demo::Question".*"FAQs"/);
  });
});
