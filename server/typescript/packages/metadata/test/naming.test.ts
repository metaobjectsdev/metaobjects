import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemorySource } from "../src/loader/meta-data-source.js";
import { resolveTableSchema, resolveTableName } from "../src/naming.js";

async function load(doc: unknown) {
  const loader = new MetaDataLoader();
  const { root } = await loader.load([
    new InMemorySource(JSON.stringify(doc), { id: "test.json" }),
  ]);
  return root;
}

describe("resolveTableSchema", () => {
  it("returns the explicit @schema attr when present on source.rdb (writable)", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "source.rdb": { "@table": "orders", "@schema": "sales" } },
              ],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBe("sales");
  });

  it("returns undefined when @schema is omitted (default-aware callers decide what 'undefined' means)", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "source.rdb": { "@table": "orders" } },
              ],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBeUndefined();
  });

  it("returns undefined when there is no source.rdb child at all", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableSchema(entity)).toBeUndefined();
  });

  it("reads @schema from source.rdb (@kind: view) for projection entities", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "OrderSummary",
              children: [
                { "source.rdb": { "@kind": "view", "@table": "v_order_summary", "@schema": "reporting" } },
              ],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "OrderSummary")!;
    expect(resolveTableSchema(entity)).toBe("reporting");
  });

  it("does not affect resolveTableName", async () => {
    const root = await load({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "source.rdb": { "@table": "orders", "@schema": "sales" } },
              ],
            },
          },
        ],
      },
    });
    const entity = root.ownChildren().find((c) => c.name === "Order")!;
    expect(resolveTableName(entity)).toBe("orders");
  });
});
