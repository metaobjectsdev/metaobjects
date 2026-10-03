// FR-044 — a relative-date filter value ({ now: "<ISO duration>" }) is legal only on the
// reporting hosts (loader rule F1). A programmatic caller skips the loader, so the view
// lowering must refuse it rather than emit a bogus SQL literal.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";

const MODEL = {
  "metadata.root": {
    package: "test",
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.int": { name: "id" } },
            { "field.timestamp": { name: "placedAt" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "OrderView",
          "@filter": { placedAt: { gte: "2026-01-01T00:00:00Z" } },
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_order_view" } },
            { "field.int": { name: "id", extends: "Order.id" } },
            { "field.timestamp": { name: "placedAt", extends: "Order.placedAt" } },
            { "identity.primary": { name: "id", extends: "Order.id" } },
          ],
        },
      },
    ],
  },
};

describe("view lowering refuses a relative-date filter value", () => {
  test("a { now } operand that bypassed the loader throws a clear error", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(result.errors).toEqual([]);
    const proj = result.root.findObject("OrderView")!;
    // The loader would have refused this (F1); mutate the stored filter to simulate a
    // programmatic caller that skipped it.
    const filter = proj.ownAttr("filter") as Record<string, Record<string, unknown>>;
    filter.placedAt = { gte: { now: "-P7D" } };

    expect(() => extractViewSpec(proj, result.root, { columnNamingStrategy: "snake_case" })).toThrow(
      /relative-date filter value.*cannot be lowered to a view/,
    );
  });

  test("the unmutated projection still extracts", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    const proj = result.root.findObject("OrderView")!;
    expect(() => extractViewSpec(proj, result.root, { columnNamingStrategy: "snake_case" })).not.toThrow();
  });
});
