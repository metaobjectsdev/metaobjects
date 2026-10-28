// The api reference described the stock queries and routes whatever the generator list held,
// so a project that wired none of them, or its own, got pages naming functions and endpoints
// nothing emits, with no drift to catch it. Each surface is now documented only when a
// generator in the run writes it.
import { describe, expect, test } from "bun:test";
import { InMemoryStringSource, MetaDataLoader } from "@metaobjectsdev/metadata";
import { buildApiModel } from "../src/generators/api-model.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { apiDocsFile } from "../src/generators/api-docs-file.js";
import { entityFile } from "../src/generators/entity-file.js";
import { docsFile } from "../src/generators/docs-file.js";
import { runEmitsEntityModule, runEmitsQueries, runEmitsRestRoutes } from "../src/ui-tier-gate.js";

async function loadRoot() {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "acme::shop",
          children: [{
            "object.entity": {
              name: "Product",
              children: [
                { "source.rdb": { "@table": "products" } },
                { "field.long": { name: "id" } },
                { "field.string": { name: "title" } },
                { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
              ],
            },
          }],
        },
      }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

const kinds = (model: ReturnType<typeof buildApiModel>): Set<string> =>
  new Set(model.units.find((u) => u.node === "Product")!.symbols.map((s) => s.kind));

describe("the api reference documents only the surfaces the run writes", () => {
  test("a caller that is not a run still gets every surface", async () => {
    const root = await loadRoot();
    const k = kinds(buildApiModel(root, { loadedRoot: root }));
    expect(k.has("data-access")).toBe(true);
    expect(k.has("rest")).toBe(true);
  });

  test("no queries generator: the query helpers are not documented", async () => {
    const root = await loadRoot();
    const without = kinds(buildApiModel(root, { loadedRoot: root, includeQueries: false }));
    expect(without.has("data-access")).toBe(false);
    expect(without.has("rest")).toBe(true);
    expect(without.has("model")).toBe(true);
  });

  test("no entity generator: the model, its schemas and relations() are not documented", async () => {
    const root = await loadRoot();
    const without = kinds(buildApiModel(root, { loadedRoot: root, includeEntityModule: false }));
    expect(without.has("model")).toBe(false);
    expect(without.has("validation")).toBe(false);
    expect(without.has("data-access")).toBe(true);
  });

  test("no routes generator: the REST endpoints are not documented", async () => {
    const root = await loadRoot();
    const without = kinds(buildApiModel(root, { loadedRoot: root, includeRestRoutes: false }));
    expect(without.has("rest")).toBe(false);
    expect(without.has("model")).toBe(true);
  });
});

describe("what the run's generators say they write", () => {
  test("queries: the shipped generator, found by its marker", () => {
    expect(runEmitsQueries([])).toBe(false);
    expect(runEmitsQueries([entityFile(), routesFile()])).toBe(false);
    expect(runEmitsQueries([queriesFile()])).toBe(true);
  });

  test("queries: an owned copy ejected before the marker is found by its name", () => {
    expect(runEmitsQueries([{ name: "queries-file", generate: () => [] }])).toBe(true);
    expect(runEmitsQueries([{ name: "house-queries", generate: () => [] }])).toBe(false);
    expect(runEmitsQueries([{ name: "house-queries", emitsQueries: true, generate: () => [] }])).toBe(true);
  });

  test("entity module: the shipped generator by its marker, an older owned copy by its name", () => {
    expect(runEmitsEntityModule([])).toBe(false);
    expect(runEmitsEntityModule([queriesFile(), routesFile()])).toBe(false);
    expect(runEmitsEntityModule([entityFile()])).toBe(true);
    expect(runEmitsEntityModule([{ name: "entity-file", generate: () => [] }])).toBe(true);
    expect(runEmitsEntityModule([{ name: "house-entity", emitsEntityModule: true, generate: () => [] }])).toBe(true);
  });

  test("routes: Fastify counts, Hono alone does not", () => {
    expect(runEmitsRestRoutes([])).toBe(false);
    expect(runEmitsRestRoutes([routesFile()])).toBe(true);
    expect(runEmitsRestRoutes([routesFileHono()])).toBe(false);
    expect(runEmitsRestRoutes([routesFileHono(), routesFile()])).toBe(true);
  });
});

describe("through meta gen: the written pages follow the generator list", () => {
  async function page(generators: Parameters<typeof defineConfig>[0]["generators"]): Promise<string> {
    const root = await loadRoot();
    const tmp = mkdtempSync(join(tmpdir(), "api-docs-surfaces-"));
    try {
      await runGen({
        config: defineConfig({
          outDir: join(tmp, "src"), extStyle: "none", dbImport: "../db", dialect: "sqlite",
          targets: { docs: { outDir: join(tmp, "docs") } }, generators,
        }),
        metadata: root, projectRoot: tmp,
      });
      return readFileSync(join(tmp, "docs", "api", "Product.md"), "utf8");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  test("entity and docs only: neither the queries nor the routes are described", async () => {
    const p = await page([entityFile(), apiDocsFile()]);
    expect(p).not.toContain("GET /products");
    expect(p).not.toContain("findProductById");
  });

  test("with the queries and routes generators wired, both are", async () => {
    const p = await page([entityFile(), queriesFile(), routesFile(), apiDocsFile()]);
    expect(p).toContain("GET /products");
    expect(p).toContain("findProductById");
    expect(p).toContain("ProductInsertSchema");
  });

  test("the meta init --with-docs scaffold (docs generators only) names nothing that is not generated", async () => {
    const p = await page([docsFile(), apiDocsFile()]);
    for (const symbol of ["interface Product", "ProductInsertSchema", "ProductUpdateSchema", "findProductById", "GET /products"]) {
      expect(p).not.toContain(symbol);
    }
  });

  test("a generator of your own that mounts routes and carries the marker counts", async () => {
    const own = { ...routesFile(), name: "house-routes" };
    const p = await page([entityFile(), own, apiDocsFile()]);
    expect(p).toContain("GET /products");
    expect(p).not.toContain("findProductById");
  });
});
