// `meta docs` honours the routes generator's `expose` option (adopter report): a page listed
// DELETE for an entity whose routes file does not mount it, so the adopter overrode the docs by
// hand. The documented endpoints are the verbs `routes-file.ts` mounts.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildApiModel } from "../src/generators/api-model.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { runRoutesExpose } from "../src/ui-tier-gate.js";
import type { Generator } from "../src/generator.js";

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
    expect(JSON.stringify(buildApiModel(root, ctx))).toBe(JSON.stringify(buildApiModel(root, { ...ctx, expose: all })));
  });

  test("a per-entity expose lists only the verbs mounted", async () => {
    const root = await loadRoot();
    const expose = (e: { name: string }) => (e.name === "AuditEntry" ? (["list", "get"] as const) : undefined);
    const model = buildApiModel(root, { loadedRoot: root, expose });
    expect(sigs(model, "AuditEntry")).toEqual(["GET /audit_entries", "GET /audit_entries/:id"]);
    expect(sigs(model, "Product")).toHaveLength(6);
  });

  test("update mounts both PATCH and PUT; delete and create are separate", async () => {
    const root = await loadRoot();
    const model = buildApiModel(root, { loadedRoot: root, expose: ["list", "update"] });
    expect(sigs(model, "Product")).toEqual(["GET /products", "PATCH /products/:id", "PUT /products/:id"]);
  });

  test("the opt-in Hono surface follows the same option", async () => {
    const root = await loadRoot();
    const model = buildApiModel(root, { loadedRoot: root, includeHonoRoutes: true, expose: ["list", "get", "create"] });
    expect(sigs(model, "Product", "rest-hono")).toEqual(["GET /products", "GET /products/:id", "POST /products"]);
  });
});

describe("runRoutesExpose reads the option off the configured generators", () => {
  test("no routes generator, or one that mounts everything, leaves docs unchanged", () => {
    expect(runRoutesExpose([])).toBeUndefined();
    expect(runRoutesExpose([routesFile()])).toBeUndefined();
    expect(runRoutesExpose([routesFile({ expose: ["list"] }), routesFileHono()])).toBeUndefined();
  });

  test("a generator with expose yields it; two generators union their verbs", async () => {
    const root = await loadRoot();
    const product = root.objects().find((o) => o.name === "Product")!;
    expect(runRoutesExpose([routesFile({ expose: ["list", "get"] })] as Generator[])?.constructor).toBe(Function);
    const one = runRoutesExpose([routesFile({ expose: ["list", "get"] })]) as (e: typeof product) => readonly string[] | undefined;
    expect(one(product)).toEqual(["list", "get"]);
    const both = runRoutesExpose([routesFile({ expose: ["list"] }), routesFileHono({ expose: ["get", "delete"] })]) as (e: typeof product) => readonly string[] | undefined;
    expect(both(product)).toEqual(["list", "get", "delete"]);
  });
});
