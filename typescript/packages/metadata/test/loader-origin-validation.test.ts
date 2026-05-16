import { describe, test, expect } from "bun:test";
import { Loader } from "../src/loader.js";

// Wraps a list of top-level object/source/field nodes in a minimal metadata
// envelope and loads them through the Loader pipeline.
function load(children: unknown[]) {
  const loader = new Loader();
  const json = JSON.stringify({
    "metadata.root": { package: "test", children },
  });
  const result = loader.loadJson(json);
  return {
    errors: result.errors.map((e) => e.message),
    warnings: result.warnings,
    root: result.root,
  };
}

describe("Loader validates origin.passthrough.from", () => {
  test("from references a real Entity.field → no error", () => {
    const result = load([
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "field.string": { name: "email" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "UserView",
          children: [
            { "source.dbView": { "@name": "v_user" } },
            {
              "field.string": {
                name: "displayName",
                children: [
                  { "origin.passthrough": { "@from": "User.email" } },
                ],
              },
            },
            { "identity.primary": { "@fields": "displayName" } },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("from references a missing field → error", () => {
    const result = load([
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "UserView",
          children: [
            { "source.dbView": { "@name": "v_user" } },
            {
              "field.string": {
                name: "displayName",
                children: [
                  { "origin.passthrough": { "@from": "User.notReal" } },
                ],
              },
            },
            { "identity.primary": { "@fields": "displayName" } },
          ],
        },
      },
    ]);
    expect(
      result.errors.some((e) => e.includes("notReal") && e.includes("no such field")),
    ).toBe(true);
  });
});

describe("Loader validates origin.aggregate.of", () => {
  test("of references a real field → no error", () => {
    const result = load([
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.int": { name: "id" } },
            { "field.long": { name: "amount" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
            {
              "relationship.association": {
                name: "orders",
                "@objectRef": "Order",
                "@cardinality": "many",
                "@fkField": "userId",
              },
            },
          ],
        },
      },
      {
        "object.entity": {
          name: "UserSummary",
          children: [
            { "source.dbView": { "@name": "v_user_summary" } },
            {
              "field.long": {
                name: "totalSpent",
                children: [
                  {
                    "origin.aggregate": {
                      "@agg": "sum",
                      "@of": "Order.amount",
                      "@via": "User.orders",
                    },
                  },
                ],
              },
            },
            { "identity.primary": { "@fields": "totalSpent" } },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("aggregate.agg outside the vocab → error", () => {
    const result = load([
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
            {
              "relationship.association": {
                name: "orders",
                "@objectRef": "Order",
                "@cardinality": "many",
                "@fkField": "userId",
              },
            },
          ],
        },
      },
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "UserStat",
          children: [
            { "source.dbView": { "@name": "v_user_stat" } },
            {
              "field.int": {
                name: "n",
                children: [
                  {
                    "origin.aggregate": {
                      "@agg": "median", // not in AGGREGATE_FUNCTIONS
                      "@of": "Order.id",
                      "@via": "User.orders",
                    },
                  },
                ],
              },
            },
            { "identity.primary": { "@fields": "n" } },
          ],
        },
      },
    ]);
    expect(
      result.errors.some((e) => e.includes("median") && e.includes("aggregate")),
    ).toBe(true);
  });
});

describe("Loader validates origin.via paths against relationships", () => {
  test("via references missing relationship segment → error", () => {
    const result = load([
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "UserStat",
          children: [
            { "source.dbView": { "@name": "v_user_stat" } },
            {
              "field.int": {
                name: "n",
                children: [
                  {
                    "origin.aggregate": {
                      "@agg": "count",
                      "@of": "User.id",
                      "@via": "User.bogus",
                    },
                  },
                ],
              },
            },
            { "identity.primary": { "@fields": "n" } },
          ],
        },
      },
    ]);
    expect(
      result.errors.some((e) => e.includes("bogus") && e.includes("no such relationship")),
    ).toBe(true);
  });
});
