// `registerAll: true` — one module that registers every generated entity's routes.
//
// An adopter estate found that no port generates an aggregate registration: every new
// entity meant a hand edit to the host file in each port. For TypeScript the routes
// generators can now emit it. The property that matters is BINDING: every import in the
// index must resolve to a routes file the same run emitted, and name a function that file
// actually exports — otherwise the index is a second list of entities that drifts.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { Generator, EmittedFile } from "../src/generator.js";
import type { OutputLayout } from "../src/import-path.js";
import { routesFile } from "../src/generators/routes-file.js";
import { routesFileHono } from "../src/generators/routes-file-hono.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";

const META = JSON.stringify({
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "name" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      // TPH: the base is registered, the subtype is not (its routes live in the base's file).
      { "object.entity": { name: "Auth", "@discriminator": "type", children: [
        { "source.rdb": { "@table": "auths" } },
        { "field.enum": { name: "type", "@values": ["Bridge", "Copay"] } },
        { "field.long": { name: "id" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
      ] } },
      { "object.entity": { name: "BridgeAuth", extends: "Auth", "@discriminatorValue": "Bridge",
        children: [{ "field.int": { name: "quantity" } }] } },
      // A value object has no routes and must not appear.
      { "object.value": { name: "Address", children: [{ "field.string": { name: "line1" } }] } },
    ],
  },
});

async function run(gen: Generator, outputLayout: OutputLayout = "flat"): Promise<EmittedFile[]> {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(META)]);
  expect(errors).toEqual([]);
  return gen.generate({
    entities: root.objects(), loadedRoot: root,
    matches: (e) => gen.filter?.(e) ?? true,
    config: { outDir: "/tmp/x", extStyle: "none", dbImport: "./db", dialect: "postgres", outputLayout },
    renderContext: makeRenderContext({
      dialect: "postgres", loadedRoot: root, outDir: "/tmp/x", dbImport: "./db", outputLayout,
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    }),
    warn: () => {},
  });
}

/** Every `import { h } from "./x"` in the index names a function the emitted `x.ts` exports. */
function expectBound(files: EmittedFile[], indexPath: string, exportKeyword: string): string[] {
  const index = files.find((f) => f.path === indexPath);
  expect(index).toBeDefined();
  const imports = [...index!.content.matchAll(/import \{ (\w+) \} from "\.\/([^"]+?)(?:\.js)?"/g)];
  for (const [, handler, spec] of imports) {
    const target = files.find((f) => f.path === `${spec}.ts`);
    expect(target, `index imports ./${spec}, which the run did not emit`).toBeDefined();
    expect(target!.content).toContain(`${exportKeyword} ${handler}(`);
  }
  return imports.map(([, handler]) => handler!);
}

describe("routes registerAll", () => {
  test("off by default: no index file, so existing projects see no new output", async () => {
    const paths = (await run(routesFile())).map((f) => f.path);
    expect(paths.some((p) => p.includes("routes.index"))).toBe(false);
    expect((await run(routesFileHono())).some((f) => f.path.includes("routes.index"))).toBe(false);
  });

  test("Fastify: registers every emitted routes file, and only those", async () => {
    const files = await run(routesFile({ registerAll: true }));
    const handlers = expectBound(files, "routes.index.ts", "export async function");
    expect(handlers).toEqual(["authRoutes", "customerRoutes"]);
    const index = files.find((f) => f.path === "routes.index.ts")!.content;
    expect(index).toMatch(/export async function registerAllRoutes\(\s*fastify: FastifyInstance,?\s*\)/);
    expect(index).toContain("await customerRoutes(fastify);");
    expect(index).toContain("unauthenticated");
    expect(index).not.toContain("BridgeAuth");
    expect(index).not.toContain("Address");
  });

  test("Hono: same set, the Hono handler names and signature", async () => {
    const files = await run(routesFileHono({ registerAll: true }));
    const handlers = expectBound(files, "routes.index.hono.ts", "export function");
    expect(handlers).toEqual(["registerAuthRoutes", "registerCustomerRoutes"]);
    const index = files.find((f) => f.path === "routes.index.hono.ts")!.content;
    expect(index).toContain("registerCustomerRoutes(app, deps);");
  });

  test("package layout: the index at the target root imports into each package directory", async () => {
    const files = await run(routesFile({ registerAll: true }), "package");
    expect(files.some((f) => f.path === "acme/Customer.routes.ts")).toBe(true);
    expectBound(files, "routes.index.ts", "export async function");
  });

  test("a filter narrows the index with the routes files", async () => {
    const files = await run(routesFile({ registerAll: true, filter: (e) => e.name === "Customer" }));
    expect(expectBound(files, "routes.index.ts", "export async function")).toEqual(["customerRoutes"]);
  });
});
