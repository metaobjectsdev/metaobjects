import { describe, test, expect } from "bun:test";
import { Loader } from "../src/loader.js";

// Wraps a list of top-level object/source/field nodes in a minimal metadata
// envelope and loads them through the Loader pipeline.
function load(children: unknown[]) {
  const loader = new Loader();
  const json = JSON.stringify({
    metadata: { package: "test", children },
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
        object: {
          name: "User",
          subType: "entity",
          children: [
            { field: { name: "id", subType: "int" } },
            { field: { name: "email", subType: "string" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "UserView",
          subType: "entity",
          children: [
            { source: { subType: "dbView", "@name": "v_user" } },
            {
              field: {
                name: "displayName",
                subType: "string",
                children: [
                  { origin: { subType: "passthrough", "@from": "User.email" } },
                ],
              },
            },
            { identity: { subType: "primary", "@fields": "displayName" } },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("from references a missing field → error", () => {
    const result = load([
      {
        object: {
          name: "User",
          subType: "entity",
          children: [
            { field: { name: "id", subType: "int" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "UserView",
          subType: "entity",
          children: [
            { source: { subType: "dbView", "@name": "v_user" } },
            {
              field: {
                name: "displayName",
                subType: "string",
                children: [
                  { origin: { subType: "passthrough", "@from": "User.notReal" } },
                ],
              },
            },
            { identity: { subType: "primary", "@fields": "displayName" } },
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
        object: {
          name: "Order",
          subType: "entity",
          children: [
            { field: { name: "id", subType: "int" } },
            { field: { name: "amount", subType: "long" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "User",
          subType: "entity",
          children: [
            { field: { name: "id", subType: "int" } },
            { identity: { subType: "primary", "@fields": "id" } },
            {
              relationship: {
                subType: "association",
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
        object: {
          name: "UserSummary",
          subType: "entity",
          children: [
            { source: { subType: "dbView", "@name": "v_user_summary" } },
            {
              field: {
                name: "totalSpent",
                subType: "long",
                children: [
                  {
                    origin: {
                      subType: "aggregate",
                      "@agg": "sum",
                      "@of": "Order.amount",
                      "@via": "User.orders",
                    },
                  },
                ],
              },
            },
            { identity: { subType: "primary", "@fields": "totalSpent" } },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("aggregate.agg outside the vocab → error", () => {
    const result = load([
      {
        object: {
          name: "User",
          subType: "entity",
          children: [
            { field: { name: "id", subType: "int" } },
            { identity: { subType: "primary", "@fields": "id" } },
            {
              relationship: {
                subType: "association",
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
        object: {
          name: "Order",
          subType: "entity",
          children: [
            { field: { name: "id", subType: "int" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "UserStat",
          subType: "entity",
          children: [
            { source: { subType: "dbView", "@name": "v_user_stat" } },
            {
              field: {
                name: "n",
                subType: "int",
                children: [
                  {
                    origin: {
                      subType: "aggregate",
                      "@agg": "median", // not in AGGREGATE_FUNCTIONS
                      "@of": "Order.id",
                      "@via": "User.orders",
                    },
                  },
                ],
              },
            },
            { identity: { subType: "primary", "@fields": "n" } },
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
        object: {
          name: "User",
          subType: "entity",
          children: [
            { field: { name: "id", subType: "int" } },
            { identity: { subType: "primary", "@fields": "id" } },
          ],
        },
      },
      {
        object: {
          name: "UserStat",
          subType: "entity",
          children: [
            { source: { subType: "dbView", "@name": "v_user_stat" } },
            {
              field: {
                name: "n",
                subType: "int",
                children: [
                  {
                    origin: {
                      subType: "aggregate",
                      "@agg": "count",
                      "@of": "User.id",
                      "@via": "User.bogus",
                    },
                  },
                ],
              },
            },
            { identity: { subType: "primary", "@fields": "n" } },
          ],
        },
      },
    ]);
    expect(
      result.errors.some((e) => e.includes("bogus") && e.includes("no such relationship")),
    ).toBe(true);
  });
});
