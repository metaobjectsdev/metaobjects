// `meta docs` honours the routes generator's `expose` option (adopter report): a page listed
// DELETE for an entity whose routes file does not mount it, so the adopter overrode the docs by
// hand. The documented endpoints are the verbs `routes-file.ts` mounts.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildApiModel } from "../src/generators/api-model.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { runRoutesExpose } from "../src/ui-tier-gate.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { apiDocsFile } from "../src/generators/api-docs-file.js";

const ENTITY = (name: string, table: string) => ({
  "object.entity": {
    name,
    children: [
      { "source.rdb": { "@table": table } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "title" } },
      { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
    ],
  },
});

async function loadRoot() {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({ "metadata.root": { package: "acme::shop", children: [ENTITY("Product", "products"), ENTITY("AuditEntry", "audit_entries")] } }),
      { id: "meta.json", format: "json" },
    ),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}

const sigs = (model: ReturnType<typeof buildApiModel>, unit: string, kind = "rest") =>
  model.units.find((u) => u.node === unit)!.symbols.filter((s) => s.kind === kind).map((s) => s.signature).sort();

describe("api docs follow the routes generator's expose option", () => {
  test("no expose documents all five verbs, as before", async () => {
    const root = await loadRoot();
    expect(sigs(buildApiModel(root, { loadedRoot: root }), "Product")).toEqual([
      "DELETE /products/:id", "GET /products", "GET /products/:id", "PATCH /products/:id", "POST /products", "PUT /products/:id",
    ]);
  });

  test("without expose the model is identical to exposing every verb, Fastify and Hono", async () => {
    const root = await loadRoot();
    const all = ["list", "get", "create", "update", "delete"] as const;
    const ctx = { loadedRoot: root, includeHonoRoutes: true };
    expect(JSON.stringify(buildApiModel(root, ctx))).toBe(JSON.stringify(buildApiModel(root, { ...ctx, expose: { rest: all, restHono: all } })));
  });

  test("a per-entity expose lists only the verbs mounted", async () => {
    const root = await loadRoot();
    const rest = (e: { name: string }) => (e.name === "AuditEntry" ? (["list", "get"] as const) : undefined);
    const model = buildApiModel(root, { loadedRoot: root, expose: { rest } });
    expect(sigs(model, "AuditEntry")).toEqual(["GET /audit_entries", "GET /audit_entries/:id"]);
    expect(sigs(model, "Product")).toHaveLength(6);
  });

  test("update mounts both PATCH and PUT; delete and create are separate", async () => {
    const root = await loadRoot();
    const model = buildApiModel(root, { loadedRoot: root, expose: { rest: ["list", "update"] } });
    expect(sigs(model, "Product")).toEqual(["GET /products", "PATCH /products/:id", "PUT /products/:id"]);
  });

  test("the opt-in Hono surface follows the same option", async () => {
    const root = await loadRoot();
    const model = buildApiModel(root, { loadedRoot: root, includeHonoRoutes: true, expose: { restHono: ["list", "get", "create"] } });
    expect(sigs(model, "Product", "rest-hono")).toEqual(["GET /products", "GET /products/:id", "POST /products"]);
  });
});

describe("each routes surface documents its own generator's expose", () => {
  test("Fastify narrowed, Hono default: Fastify lists two verbs, Hono all", async () => {
    const root = await loadRoot();
    const expose = runRoutesExpose([routesFile({ expose: ["list", "get"] }), routesFileHono()]);
    const model = buildApiModel(root, { loadedRoot: root, includeHonoRoutes: true, ...(expose && { expose }) });
    expect(sigs(model, "Product", "rest")).toEqual(["GET /products", "GET /products/:id"]);
    expect(sigs(model, "Product", "rest-hono")).toHaveLength(6);
  });

  test("Hono narrowed, Fastify default: Hono lists two verbs, Fastify all", async () => {
    const root = await loadRoot();
    const expose = runRoutesExpose([routesFile(), routesFileHono({ expose: ["list", "get"] })]);
    const model = buildApiModel(root, { loadedRoot: root, includeHonoRoutes: true, ...(expose && { expose }) });
    expect(sigs(model, "Product", "rest")).toHaveLength(6);
    expect(sigs(model, "Product", "rest-hono")).toEqual(["GET /products", "GET /products/:id"]);
  });

  test("both narrowed differently: each surface keeps its own verbs", async () => {
    const root = await loadRoot();
    const expose = runRoutesExpose([routesFile({ expose: ["list"] }), routesFileHono({ expose: ["get", "delete"] })]);
    const model = buildApiModel(root, { loadedRoot: root, includeHonoRoutes: true, ...(expose && { expose }) });
    expect(sigs(model, "Product", "rest")).toEqual(["GET /products"]);
    expect(sigs(model, "Product", "rest-hono")).toEqual(["DELETE /products/:id", "GET /products/:id"]);
  });
});

describe("runRoutesExpose reads the option off the configured generators", () => {
  test("no routes generator, or only ones that mount everything, leaves docs unchanged", () => {
    expect(runRoutesExpose([])).toBeUndefined();
    expect(runRoutesExpose([routesFile()])).toBeUndefined();
    expect(runRoutesExpose([routesFile(), routesFileHono()])).toBeUndefined();
  });

  test("a surface is narrowed only by its own generators; two on one surface union their verbs", async () => {
    const root = await loadRoot();
    const product = root.objects().find((o) => o.name === "Product")!;
    type Fn = (e: typeof product) => readonly string[] | undefined;
    const one = runRoutesExpose([routesFile({ expose: ["list", "get"] }), routesFileHono()]);
    expect(one?.restHono).toBeUndefined();
    expect((one?.rest as Fn)(product)).toEqual(["list", "get"]);
    const two = runRoutesExpose([routesFile({ expose: ["list"] }), routesFile({ expose: ["get", "delete"] })]);
    expect((two?.rest as Fn)(product)).toEqual(["list", "get", "delete"]);
    expect(runRoutesExpose([routesFile({ expose: ["list"] }), routesFile()])?.rest).toBeUndefined();
  });
});

describe("a routes generator's own filter removes the entities it does not mount", () => {
  test("the rejected entity is documented with no routes; the rest are unchanged", async () => {
    const root = await loadRoot();
    const expose = runRoutesExpose([routesFile({ filter: (e) => e.name !== "AuditEntry" })]);
    const model = buildApiModel(root, { loadedRoot: root, ...(expose !== undefined && { expose }) });
    expect(sigs(model, "AuditEntry")).toEqual([]);
    expect(sigs(model, "Product")).toHaveLength(6);
  });

  test("filter and expose compose; a second unfiltered generator on the surface mounts everything", async () => {
    const root = await loadRoot();
    const audit = root.objects().find((o) => o.name === "AuditEntry")!;
    const product = root.objects().find((o) => o.name === "Product")!;
    type Fn = (e: typeof audit) => readonly string[] | undefined;
    const both = runRoutesExpose([routesFile({ filter: (e) => e.name !== "AuditEntry", expose: ["list"] })]);
    expect((both?.rest as Fn)(audit)).toEqual([]);
    expect((both?.rest as Fn)(product)).toEqual(["list"]);
    expect(runRoutesExpose([routesFile({ filter: () => false }), routesFile()])?.rest).toBeUndefined();
  });
});

describe("through meta gen: the written api pages list only the mounted verbs", () => {
  async function pages(generators: Parameters<typeof defineConfig>[0]["generators"]) {
    const root = await loadRoot();
    const tmp = mkdtempSync(join(tmpdir(), "api-docs-expose-"));
    try {
      const { warnings } = await runGen({
        config: defineConfig({
          outDir: join(tmp, "src"), extStyle: "none", dbImport: "../db", dialect: "sqlite",
          targets: { docs: { outDir: join(tmp, "docs") } }, generators,
        }),
        metadata: root, projectRoot: tmp,
      });
      return { product: readFileSync(join(tmp, "docs", "api", "Product.md"), "utf8"), warnings };
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  test("expose omitting create/update/delete: write routes are not documented; default is unchanged", async () => {
    const narrowed = await pages([routesFile({ expose: ["list", "get"] }), apiDocsFile()]);
    const page = narrowed.product;
    expect(page).toContain("GET /products");
    expect(page).not.toMatch(/\b(POST|PATCH|PUT|DELETE) \/products/);
    const full = await pages([routesFile(), apiDocsFile()]);
    expect(full.product).toMatch(/POST \/products/);
    expect(full.product).toMatch(/DELETE \/products\/:id/);
  });

  test("an owned routes copy with no mountsRoutes marker is warned about", async () => {
    const { mountsRoutes: _marker, ...stale } = routesFile();
    const { warnings } = await pages([stale, apiDocsFile()]);
    expect(warnings.join("\n")).toContain("mountsRoutes");
  });
});
