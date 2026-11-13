// A docs page's cross-page links resolve to the target's real page. Pages are
// placed under their package path (DOCS_PAGE_LAYOUT), so a foreign-key "References" link from
// `acme/sales/Order.md` to `acme::crm::Customer` is `../crm/Customer.md`, never the bare
// `Customer.md` that only resolved when every page sat in one directory.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../src/generators/docs-file.js";
import { makeRenderContext } from "../src/render-context.js";
import { buildPkMap } from "../src/pk-resolver.js";
import { buildRelationMap } from "../src/relation-resolver.js";
import type { GenContext } from "../src/generator.js";

const MODEL = [
  {
    "metadata.root": {
      package: "acme::crm",
      children: [
        {
          "object.entity": {
            name: "Customer",
            children: [
              { "source.rdb": { "@table": "customers" } },
              { "field.long": { name: "id" } },
              { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        },
      ],
    },
  },
  {
    "metadata.root": {
      package: "acme::sales",
      children: [
        {
          "object.entity": {
            name: "Order",
            children: [
              { "source.rdb": { "@table": "orders" } },
              { "field.long": { name: "id" } },
              { "field.long": { name: "customerId", "@required": true } },
              { "field.long": { name: "parentId" } },
              { "identity.primary": { name: "id", "@fields": ["id"], "@generation": "increment" } },
              { "identity.reference": { name: "customer", "@fields": ["customerId"], "@references": "acme::crm::Customer" } },
              { "identity.reference": { name: "parent", "@fields": ["parentId"], "@references": "acme::sales::Order" } },
            ],
          },
        },
      ],
    },
  },
];

async function render(): Promise<Map<string, string>> {
  const res = await new MetaDataLoader().load(
    MODEL.map((m, i) => new InMemoryStringSource(JSON.stringify(m), { id: `m${i}.json`, format: "json" })),
  );
  expect(res.errors).toEqual([]);
  const root = res.root;
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    renderContext: makeRenderContext({
      dialect: "sqlite", loadedRoot: root, outDir: "/tmp", dbImport: "~/db",
      pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
    }),
    warn: () => {},
  };
  const out = await docsFile().generate(ctx);
  return new Map(out.map((f) => [f.path, f.content]));
}

describe("docsFile — cross-page links follow package placement ", () => {
  it("a reference into another package links up and across", async () => {
    const pages = await render();
    const order = pages.get("acme/sales/Order.md");
    expect(order).toBeDefined();
    expect(pages.has("acme/crm/Customer.md")).toBe(true);
    expect(order).toContain("**References:** [`Customer.id`](../crm/Customer.md)");
    expect(order).not.toContain("](Customer.md)");
  });

  it("a reference within the package links beside the page", async () => {
    const pages = await render();
    expect(pages.get("acme/sales/Order.md")).toContain("**References:** [`Order.id`](./Order.md)");
  });

  // The Identity section's reference bullet links its target too, bare or qualified.
  it("an identity reference links its target, package-qualified or bare", async () => {
    const order = (await render()).get("acme/sales/Order.md")!;
    expect(order).toContain("**Reference:** `customerId` → [`acme::crm::Customer`](../crm/Customer.md)");
    expect(order).toContain("**Reference:** `parentId` → [`acme::sales::Order`](./Order.md)");
  });
});
