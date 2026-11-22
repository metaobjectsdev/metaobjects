// The service layer's generators (ADR-0067 layers 4 and 5): which entities get operations, where
// the files go in each layout, what the package's service is named, and the refusals. Behaviour is
// gated by the api-contract service lane and compilation by the service compile gate, both in
// `integration-tests`; this file holds the walk and the paths.
import { describe, expect, test } from "bun:test";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { InMemoryStringSource, loadUris, MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { contractTypes, entityFile, queriesFile, serviceFile, serviceRoutesFile } from "../src/generators/index.js";
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
    expect(files["acme/shop/service/index.ts"]).toContain("export function createShopService<A = unknown>(deps: ServiceDeps<A>): ShopService<A> {");
    // The entity module stays where the flat layout puts it, and the service reaches it.
    expect(files["acme/shop/service/createOrder.ts"]).toContain('from "../../../Order.js";');
  });

  test("on sqlite the service takes a sync or an async Drizzle driver, as the flat queries module does", async () => {
    const root = await load("acme::shop", [entity("Order")]);
    const files = await gen(root, [entityFile(), contractTypes(), serviceFile(), queriesFile()], "package", { dialect: "sqlite" });
    expect(files["acme/shop/service/index.ts"]).toContain('type Db = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;');
    expect(files["acme/shop/Order.queries.ts"]).toContain('type Db = BaseSQLiteDatabase<"sync" | "async", unknown, Record<string, unknown>>;');
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

// ADR-0066 on the generated side: the lifecycle, the declared operations, the permission points
// and the three `rules.*` keys that change what is generated. Behaviour over HTTP is gated by the
// api-contract rules corpus (`integration-tests/test/api-contract-rules.test.ts`).
const order = (transitions: unknown[], extra: unknown[] = []) =>
  entity("Order", [
    {
      "field.enum": {
        name: "status",
        "@values": ["open", "paid", "void"],
        "@default": "open",
        children: transitions,
      },
    },
    ...extra,
  ]);
const pay = { "transition.action": { name: "pay", "@from": ["open"], "@to": "paid" } };
const voidIt = { "transition.action": { name: "void", "@from": ["open", "paid"], "@to": "void", "@public": true } };
const api = (...ops: unknown[]) => ({ "api.operational": { name: "Shop", children: ops } });
const settlement = {
  "object.value": {
    name: "Settlement",
    children: [{ "field.long": { name: "orderId", extends: "Order.id" } }, { "field.string": { name: "reference", "@maxLength": 40 } }],
  },
};
// Keyed by its input's borrowed key (`orderId` extends `Order.id`, ADR-0066 §3).
const settle = {
  "operation.command": { name: "settle", "@inputRef": "Settlement", "@transitions": ["pay"], "@permission": "shop.settle" },
};

async function withSettings(root: MetaRoot, settings: Partial<MetaRoot["rulesSettings"]>): Promise<MetaRoot> {
  root.rulesSettings = { ...root.rulesSettings, ...settings };
  return root;
}

describe("service generators — lifecycles and declared operations (ADR-0066)", () => {
  test("each unclaimed transition derives a command file and a route; a claimed one derives neither", async () => {
    const root = await load("acme::shop", [order([pay, voidIt]), settlement, api(settle)]);
    const files = await gen(root, tier());
    expect(servicePaths(files)).toContain("acme/shop/service/voidOrder.ts");
    expect(servicePaths(files)).toContain("acme/shop/service/settle.ts");
    // `pay` is claimed by `settle`, so under the default `unclaimed` it has no command of its own.
    expect(servicePaths(files)).not.toContain("acme/shop/service/payOrder.ts");
    expect(files["acme/shop/transport/fastify.ts"]).toContain('"/orders/:id/void"');
    expect(files["acme/shop/transport/fastify.ts"]).not.toContain('"/orders/:id/pay"');
    // The derived permission name of a transition is `<package>.<Entity>.<transition>`; `void` is public.
    expect(files["acme/shop/service/index.ts"]).toContain('export type ShopPermission = "shop.settle";');
  });

  test("rules.lifecycle.commands: all derives a command for a claimed transition too; none derives none", async () => {
    const all = await gen(await withSettings(await load("acme::shop", [order([pay, voidIt]), settlement, api(settle)]), { lifecycleCommands: "all" }), tier());
    expect(servicePaths(all)).toContain("acme/shop/service/payOrder.ts");
    expect(all["acme/shop/service/payOrder.ts"]).toContain('"acme::shop.Order.pay"');
    const none = await gen(await withSettings(await load("acme::shop", [order([pay, voidIt]), settlement, api(settle)]), { lifecycleCommands: "none" }), tier());
    expect(servicePaths(none).filter((p) => /(pay|void)Order/.test(p))).toEqual([]);
    expect(servicePaths(none)).toContain("acme/shop/service/settle.ts");
  });

  test("rules.lifecycle.create: initial checks a create's state against the initial one; any does not", async () => {
    const initial = await gen(await load("acme::shop", [order([pay])]), tier());
    expect(initial["acme/shop/service/createOrder.ts"]).toContain('checkCreateState(values, { status: "open" });');
    const any = await gen(await withSettings(await load("acme::shop", [order([pay])]), { lifecycleCreate: "any" }), tier());
    expect(any["acme/shop/service/createOrder.ts"]).not.toContain("checkCreateState(");
    // A lifecycle field is moved only by a transition, under either setting.
    expect(any["acme/shop/service/updateOrder.ts"]).toContain('checkStateManaged(');
  });

  test("rules.permissions.names: require refuses a point with no @permission, naming the name it would derive", async () => {
    const root = await withSettings(await load("acme::shop", [order([pay])]), { permissionNames: "require" });
    await expect(gen(root, tier())).rejects.toThrow(/acme::shop\.Order\.pay/);
    // A declared or public point passes.
    const declared = await withSettings(
      await load("acme::shop", [order([{ "transition.action": { name: "pay", "@from": ["open"], "@to": "paid", "@permission": "shop.pay" } }, voidIt])]),
      { permissionNames: "require" },
    );
    expect(servicePaths(await gen(declared, tier()))).toContain("acme/shop/service/payOrder.ts");
  });

  test("a declared binding on a derived route's method and path is refused by name", async () => {
    const clash = {
      "operation.query": {
        name: "peek",
        "@objectRef": "Order",
        "@outputRef": "Order",
        "@public": true,
        children: [{ "binding.rest": { "@method": "GET", "@path": "/orders/{id}" } }],
      },
    };
    const root = await load("acme::shop", [order([pay]), api(clash)]);
    await expect(gen(root, tier())).rejects.toThrow(/operation peek and Order get are both mounted on GET/);
  });

  test("a command that lists @transitions but addresses no row by key is refused: it has no row to move", async () => {
    const unkeyed = { "operation.command": { name: "settle", "@objectRef": "Order", "@transitions": ["pay"], "@permission": "shop.settle" } };
    const root = await load("acme::shop", [order([pay]), api(unkeyed)]);
    await expect(gen(root, tier())).rejects.toThrow(/command settle lists @transitions but addresses no row by key/);
  });
});

describe("service generator — a store without interactive transactions (ADR-0067 §4)", () => {
  const noTx = (): Generator[] => [entityFile(), contractTypes(), serviceFile({ interactiveTransactions: false }), serviceRoutesFile()];
  const peek = { "operation.query": { name: "peek", "@objectRef": "Order", "@outputRef": "Order", "@public": true } };

  test("a package that declares a command is refused, naming the package, the command and the option", async () => {
    const root = await load("acme::shop", [order([pay]), settlement, api(settle)]);
    await expect(gen(root, noTx())).rejects.toThrow(
      /ERR_STORE_NO_INTERACTIVE_TX: package acme::shop declares command settle, and serviceFile\(\{ interactiveTransactions: false \}\)/,
    );
    // The same package generates with interactive transactions, the default.
    expect(servicePaths(await gen(root, tier()))).toContain("acme/shop/service/settle.ts");
  });

  test("a declared query is generated; the service offers no hooks and no event hook, and opens no transaction", async () => {
    const files = await gen(await load("acme::shop", [order([pay]), api(peek)]), noTx());
    expect(servicePaths(files)).toContain("acme/shop/service/peek.ts");
    const index = files["acme/shop/service/index.ts"]!;
    expect(index).not.toContain("ShopHooks");
    expect(index).not.toContain("ShopEvents");
    expect(index).not.toContain("readonly hooks?");
    for (const op of ["createOrder", "updateOrder", "deleteOrder", "payOrder"]) {
      const file = files[`acme/shop/service/${op}.ts`]!;
      expect(file).toContain("withoutTransaction(deps.db, opts.tx,");
      expect(file).not.toContain("inWriteTransaction");
      expect(file).not.toContain("deps.hooks");
      expect(file).not.toContain("emitWrite");
    }
    // The transition keeps its guarded update, which holds without a transaction.
    expect(files["acme/shop/service/payOrder.ts"]).toContain("makeTransition(");
  });
});
