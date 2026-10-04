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
    // own, sanctioned (ADR-0039): a test-only MUTATION of the attr value stored on this
    // node — the resolving accessor could hand back an inherited value object, and
    // writing through it would edit a different node than the one under test.
    const filter = proj.ownAttr("filter") as Record<string, Record<string, unknown>>;
    filter.placedAt = { gte: { now: "-P7D" } };

    expect(() => extractViewSpec(proj, result.root, { columnNamingStrategy: "snake_case" })).toThrow(
      /^Projection OrderView: view @filter on "placedAt": a relative-date filter value.*cannot be lowered to a view/,
    );
  });

  test("a pre-desugar shorthand { field: { now } } is a VALUE, not an op named `now`", async () => {
    // metadata's attr.filter desugar reads an object carrying a `now` key as `eq` of a
    // relative-date value. The lowering's own desugar must agree, or the shorthand lowers
    // as op "now" and the guard (which inspects values) never sees it.
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    expect(result.errors).toEqual([]);
    const proj = result.root.findObject("OrderView")!;
    // own, sanctioned (ADR-0039): test-only mutation of this node's stored attr value.
    const filter = proj.ownAttr("filter") as Record<string, unknown>;
    filter.placedAt = { now: "-P7D" };

    expect(() => extractViewSpec(proj, result.root, { columnNamingStrategy: "snake_case" })).toThrow(
      /^Projection OrderView: view @filter on "placedAt": a relative-date filter value.*cannot be lowered to a view/,
    );
  });

  test("the unmutated projection still extracts", async () => {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
    const proj = result.root.findObject("OrderView")!;
    expect(() => extractViewSpec(proj, result.root, { columnNamingStrategy: "snake_case" })).not.toThrow();
  });
});

// The origin.aggregate scoping `@filter` reaches SQL through a different resolver
// (`resolveAggregateFilter`) than the row-scope `@filter` above, so it is pinned on its own.
const AGG_MODEL = {
  "metadata.root": {
    package: "test",
    children: [
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.int": { name: "id" } },
            { "relationship.association": { name: "orders", "@objectRef": "Order", "@cardinality": "many" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@table": "orders" } },
            { "field.int": { name: "id" } },
            { "field.int": { name: "customerId" } },
            { "field.timestamp": { name: "placedAt" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "identity.reference": { name: "fkCustomer", "@fields": "customerId", "@references": "Customer" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "CustomerStat",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_customer_stat" } },
            {
              "field.int": {
                name: "customerId",
                extends: "Customer.id",
                children: [{ "origin.passthrough": { "@from": "Customer.id" } }],
              },
            },
            {
              "field.long": {
                name: "recentOrders",
                children: [
                  {
                    "origin.aggregate": {
                      "@agg": "count",
                      "@of": "Order.id",
                      "@via": "Customer.orders",
                      "@filter": { placedAt: { gte: "2026-01-01T00:00:00Z" } },
                    },
                  },
                ],
              },
            },
            { "identity.primary": { name: "id", extends: "Customer.id", "@fields": "customerId" } },
          ],
        },
      },
    ],
  },
};

describe("the origin.aggregate @filter refuses a relative-date value too", () => {
  async function loadAgg() {
    const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(AGG_MODEL))]);
    expect(result.errors).toEqual([]);
    const proj = result.root.findObject("CustomerStat")!;
    const origin = proj.fields().find((f) => f.name === "recentOrders")!.children()[0]!;
    // own, sanctioned (ADR-0039): test-only mutation of the origin node's stored attr value.
    const filter = origin.ownAttr("filter") as Record<string, unknown>;
    return { root: result.root, proj, filter };
  }

  test("the unmutated aggregate filter extracts", async () => {
    const { root, proj } = await loadAgg();
    expect(() => extractViewSpec(proj, root, { columnNamingStrategy: "snake_case" })).not.toThrow();
  });

  test("an op-map operand { gte: { now } } throws", async () => {
    const { root, proj, filter } = await loadAgg();
    filter.placedAt = { gte: { now: "-P7D" } };
    expect(() => extractViewSpec(proj, root, { columnNamingStrategy: "snake_case" })).toThrow(
      // The message names the aggregate's filter, not the projection's row-scope one.
      /^origin\.aggregate @filter over Order on "placedAt": a relative-date filter value.*cannot be lowered to a view/,
    );
  });

  test("a shorthand operand { now } throws (read as eq, not as op `now`)", async () => {
    const { root, proj, filter } = await loadAgg();
    filter.placedAt = { now: "-P7D" };
    expect(() => extractViewSpec(proj, root, { columnNamingStrategy: "snake_case" })).toThrow(
      // The message names the aggregate's filter, not the projection's row-scope one.
      /^origin\.aggregate @filter over Order on "placedAt": a relative-date filter value.*cannot be lowered to a view/,
    );
  });
});
