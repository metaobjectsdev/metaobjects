import { describe, expect, test } from "bun:test";
import { InMemoryStringSource, MetaDataLoader, composeRegistry, coreProviders, type MetaData } from "@metaobjectsdev/metadata";
import { provider, resolveSystemRef } from "../src/index.js";

const SHOP = {
  "metadata.root": {
    package: "acme::shop",
    children: [
      { "system.internal": { name: "Shop", children: [
        { "app.service": { name: "api", "@needs": ["db"], "@calls": ["Mail", "Billing.ledger"] } },
        { "resource.database": { name: "db" } },
      ] } },
      { "system.internal": { name: "Billing", children: [{ "app.service": { name: "ledger" } }] } },
      { "system.external": { name: "Mail" } },
    ],
  },
};
const ESTATE = { "metadata.root": { package: "acme::estate", children: [{ "system.external": { name: "Dns" } }] } };

async function load(): Promise<MetaData> {
  const loader = new MetaDataLoader({ registry: composeRegistry([...coreProviders, provider]), strict: true });
  const { root } = await loader.load([
    new InMemoryStringSource(JSON.stringify(SHOP), { id: "meta.shop.json" }),
    new InMemoryStringSource(JSON.stringify(ESTATE), { id: "meta.estate.json" }),
  ]);
  return root;
}

function api(root: MetaData): MetaData {
  const shop = root.children().find((c) => c.name === "Shop")!;
  return shop.children().find((c) => c.name === "api")!;
}

describe("resolveSystemRef", () => {
  test("a bare name is a node of the referrer's own system", async () => {
    const r = resolveSystemRef(api(await load()), "db");
    expect(`${r?.type}.${r?.subType}:${r?.name}`).toBe("resource.database:db");
  });

  test("a bare name that is no sibling falls back to a top-level node of the referrer's package", async () => {
    expect(resolveSystemRef(api(await load()), "Mail")?.subType).toBe("external");
  });

  test("System.child walks into another system, and pkg::System.child into another package", async () => {
    const root = await load();
    expect(resolveSystemRef(api(root), "Billing.ledger")?.name).toBe("ledger");
    expect(resolveSystemRef(api(root), "acme::shop::Billing.ledger")?.name).toBe("ledger");
    expect(resolveSystemRef(api(root), "acme::estate::Dns")?.name).toBe("Dns");
  });

  test("a name that matches nothing resolves to nothing, as does a bare name from another package", async () => {
    const root = await load();
    expect(resolveSystemRef(api(root), "nope")).toBeUndefined();
    expect(resolveSystemRef(api(root), "Billing.nope")).toBeUndefined();
    expect(resolveSystemRef(api(root), "Dns")).toBeUndefined();
  });

  test("given the kinds wanted, a bare name prefers the sibling of that kind when an app and a resource share it", async () => {
    const SAME = { "metadata.root": { package: "acme::shop", children: [
      { "system.internal": { name: "Shop", children: [
        { "app.service": { name: "worker", "@needs": ["worker"] } },
        { "resource.queue": { name: "worker" } },
      ] } },
    ] } };
    const loader = new MetaDataLoader({ registry: composeRegistry([...coreProviders, provider]), strict: true });
    const { root } = await loader.load([new InMemoryStringSource(JSON.stringify(SAME), { id: "meta.shop.json" })]);
    const app = root.children()[0]!.children().find((c) => c.type === "app")!;
    expect(resolveSystemRef(app, "worker", "needs", ["resource"])?.type).toBe("resource");
  });
});
