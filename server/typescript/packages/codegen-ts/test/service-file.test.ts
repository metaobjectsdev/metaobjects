// The service layer's generators (ADR-0067 layers 4 and 5): which entities get operations, where
// the files go in each layout, what the package's service is named, and the refusals. Behaviour is
// gated by the api-contract service lane and compilation by the service compile gate, both in
// `integration-tests`; this file holds the walk and the paths.
import { describe, expect, test } from "bun:test";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InMemoryStringSource, loadUris, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { contractTypes, entityFile, serviceFile, serviceRoutesFile } from "../src/generators/index.js";
import { defineConfig, runGen, type OutputLayout } from "../src/index.js";
import { serviceModelOf, serviceRoutesName, serviceTypeName } from "../src/service-walk.js";
import { makeScratchDir, removeTree } from "../src/scratch-dir.js";
import type { Generator } from "../src/generator.js";

const FITNESS = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..", "..", "..", "..", "..", "fixtures", "persistence-conformance", "canonical", "meta.fitness.json",
);

const entity = (name: string, extra: unknown[] = [], table = `${name.toLowerCase()}s`) => ({
  "object.entity": {
    name,
    children: [
      { "source.rdb": { "@table": table } },
      { "field.long": { name: "id" } },
      { "field.string": { name: "title", "@maxLength": 80 } },
      { "identity.primary": { name: "pk", "@fields": ["id"] } },
      ...extra,
    ],
  },
});

async function load(pkg: string, children: unknown[]): Promise<MetaRoot> {
  const result = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: pkg, children } }), { id: "service.json" }),
  ]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  return result.root;
}

async function gen(
  root: MetaRoot,
  generators: Generator[],
  layout: OutputLayout = "package",
  extra: Record<string, unknown> = {},
): Promise<Record<string, string>> {
  const dir = makeScratchDir("service-file-");
  try {
    const r = await runGen({
      config: defineConfig({ outDir: "gen", extStyle: "js", dialect: "postgres", outputLayout: layout, generators, ...extra }),
      metadata: root,
      projectRoot: dir,
      dryRun: true,
    });
    const out = join(dir, "gen");
    return Object.fromEntries([...(r.rendered ?? new Map<string, string>())].map(([path, content]) => [path.slice(out.length + 1), content]));
  } finally {
    removeTree(dir);
  }
}

const tier = (): Generator[] => [entityFile(), contractTypes(), serviceFile(), serviceRoutesFile()];
const servicePaths = (files: Record<string, string>) =>
  Object.keys(files).filter((p) => p.includes("/service/") || p.includes("/transport/") || p.startsWith("service/") || p.startsWith("transport/")).sort();

describe("service generators — what they write", () => {
  test("one file per operation, the index and the transport, under the package's directory", async () => {
    const root = await load("acme::shop", [entity("Order"), entity("Customer")]);
    expect(servicePaths(await gen(root, tier()))).toEqual([
      "acme/shop/service/createCustomer.ts",
      "acme/shop/service/createOrder.ts",
      "acme/shop/service/deleteCustomer.ts",
      "acme/shop/service/deleteOrder.ts",
      "acme/shop/service/getCustomer.ts",
      "acme/shop/service/getOrder.ts",
      "acme/shop/service/index.ts",
      "acme/shop/service/listCustomers.ts",
      "acme/shop/service/listOrders.ts",
      "acme/shop/service/updateCustomer.ts",
      "acme/shop/service/updateOrder.ts",
      "acme/shop/transport/fastify.ts",
    ]);
  });

  test("the flat layout keeps the package directory: two packages cannot both write service/index.ts", async () => {
    const root = await load("acme::shop", [entity("Order")]);
    const files = await gen(root, tier(), "flat");
    expect(files["acme/shop/service/index.ts"]).toContain("export function createShopService(deps: ServiceDeps): ShopService {");
    // The entity module stays where the flat layout puts it, and the service reaches it.
    expect(files["acme/shop/service/createOrder.ts"]).toContain('from "../../../Order.js";');
  });

  test("the service is named for the package's last segment; the root package's is ModelService", () => {
    expect(serviceTypeName("acme::purchasing")).toBe("PurchasingService");
    expect(serviceTypeName("acme::purchase_orders")).toBe("PurchaseOrdersService");
    expect(serviceTypeName("")).toBe("ModelService");
    expect(serviceRoutesName("acme::purchasing")).toBe("purchasingServiceRoutes");
  });

  test("a model with no store-backed entity gets no file, and a project that lists none sees no change", async () => {
    const root = await load("acme::shop", [{ "object.value": { name: "Money", children: [{ "field.long": { name: "cents" } }] } }]);
    expect(servicePaths(await gen(root, tier()))).toEqual([]);
    const withOrder = await load("acme::shop", [entity("Order")]);
    expect(servicePaths(await gen(withOrder, [entityFile(), contractTypes()]))).toEqual([]);
  });

  test("filter narrows the entities that get operations", async () => {
    const root = await load("acme::shop", [entity("Order"), entity("Customer")]);
    const onlyOrder = (e: { name: string }) => e.name === "Order";
    const files = await gen(root, [entityFile(), contractTypes(), serviceFile({ filter: onlyOrder }), serviceRoutesFile({ filter: onlyOrder })]);
    expect(servicePaths(files).filter((p) => p.includes("Customer"))).toEqual([]);
    expect(files["acme/shop/service/index.ts"]).not.toContain("Customer");
  });

  test("a relative runtimeImport (an owned copy) is resolved from the file, one folder below the package", async () => {
    const root = await load("acme::shop", [entity("Order")]);
    const files = await gen(root, [entityFile(), contractTypes(), serviceFile({ runtimeImport: "../codegen/runtime" }), serviceRoutesFile({ runtimeImport: "../codegen/runtime" })]);
    expect(files["acme/shop/service/createOrder.ts"]).toContain('from "../../../../codegen/runtime/service/index.js";');
    expect(files["acme/shop/transport/fastify.ts"]).toContain('from "../../../../codegen/runtime/service/fastify.js";');
  });

  test("written to another target than the entity module's, it is refused by name", async () => {
    const root = await load("acme::shop", [entity("Order")]);
    await expect(
      gen(root, [entityFile(), contractTypes(), serviceFile({ target: "api" })], "package", {
        targets: { api: { outDir: "api" } },
        importBase: "@acme/model",
      }),
    ).rejects.toThrow(/service: write it to the entity module's target/);
  });
});

describe("service walk — which entities get the derived operations", () => {
  test("over the fitness corpus: concrete, store-backed, single-key entities only", async () => {
    const result = await loadUris([pathToFileURL(FITNESS).href]);
    expect(result.errors).toEqual([]);
    const covered = serviceModelOf(result.root).flatMap((p) => p.entities.map((e) => e.obj.name));
    expect(covered).toContain("Program");
    // A concrete entity that inherits its fields from an abstract one.
    expect(covered).toContain("Gadget");
    // The abstract level has no table of its own.
    expect(covered).not.toContain("Labeled");
    // A single-table hierarchy, its base and its subtypes, is later service work.
    for (const tph of ["Auth", "BridgeAuth", "CouponAuth", "PermitAuth", "ReferralAuth"]) expect(covered).not.toContain(tph);
  });
});
