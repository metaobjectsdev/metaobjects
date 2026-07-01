// Task 2 — index.lookup type registration tests.
//
// TDD: written BEFORE implementation. These tests verify the TS reference
// vocabulary for the new index.lookup type.

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { MetaIndex } from "../src/core/index/meta-index.js";

async function load(doc: unknown, strict = false) {
  const loader = new MetaDataLoader({ strict });
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

// ---------------------------------------------------------------------------
// Baseline: index.lookup loads and resolves fields
// ---------------------------------------------------------------------------

describe("index.lookup — basic load and accessor", () => {
  it("loads an entity with an index.lookup child and resolves fields", async () => {
    const { root, errors } = await load({
      "metadata.root": {
        package: "test::index",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "field.long": { name: "customerId" } },
                { "field.timestamp": { name: "placedAt" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
                {
                  "index.lookup": {
                    name: "idx_customer_placed",
                    "@fields": ["customerId", "placedAt"],
                    "@orders": ["asc", "desc"],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    // No errors (warnings only are OK)
    const nonWarnErrors = errors.filter(
      (e) => !("severity" in e && (e as { severity?: string }).severity === "warn"),
    );
    expect(nonWarnErrors).toHaveLength(0);

    const order = root.findObject("Order");
    expect(order).toBeDefined();

    const idx = order!.children().find((c) => c.type === "index");
    expect(idx).toBeDefined();
    expect(idx).toBeInstanceOf(MetaIndex);

    const metaIdx = idx as MetaIndex;
    expect(metaIdx.fields()).toEqual(["customerId", "placedAt"]);
  });
});

// ---------------------------------------------------------------------------
// @unique is rejected on index.lookup (ERR_UNKNOWN_ATTR, strict mode)
// ---------------------------------------------------------------------------

describe("index.lookup — @unique is not a registered attr", () => {
  it("emits ERR_UNKNOWN_ATTR when @unique appears on index.lookup (strict)", async () => {
    const { errors } = await load(
      {
        "metadata.root": {
          package: "test::index",
          children: [
            {
              "object.entity": {
                name: "Order",
                children: [
                  { "field.long": { name: "id" } },
                  { "field.long": { name: "customerId" } },
                  { "identity.primary": { name: "pk", "@fields": ["id"] } },
                  {
                    "index.lookup": {
                      name: "idx_customer",
                      "@fields": ["customerId"],
                      "@unique": true,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      true, // strict
    );

    const unknownAttrErrors = errors.filter(
      (e) => (e as { code?: string }).code === "ERR_UNKNOWN_ATTR",
    );
    expect(unknownAttrErrors.length).toBeGreaterThan(0);
    expect(
      unknownAttrErrors.some((e) =>
        (e as { message?: string }).message?.includes("@unique"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// @unique is rejected on identity.secondary (ERR_UNKNOWN_ATTR, strict mode)
// ---------------------------------------------------------------------------

describe("identity.secondary — @unique is no longer registered", () => {
  it("emits ERR_UNKNOWN_ATTR when @unique appears on identity.secondary (strict)", async () => {
    const { errors } = await load(
      {
        "metadata.root": {
          package: "test::index",
          children: [
            {
              "object.entity": {
                name: "Order",
                children: [
                  { "field.long": { name: "id" } },
                  { "field.string": { name: "email" } },
                  { "identity.primary": { name: "pk", "@fields": ["id"] } },
                  {
                    "identity.secondary": {
                      name: "idx_email",
                      "@fields": ["email"],
                      "@unique": true,
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      true, // strict
    );

    const unknownAttrErrors = errors.filter(
      (e) => (e as { code?: string }).code === "ERR_UNKNOWN_ATTR",
    );
    expect(unknownAttrErrors.length).toBeGreaterThan(0);
    expect(
      unknownAttrErrors.some((e) =>
        (e as { message?: string }).message?.includes("@unique"),
      ),
    ).toBe(true);
  });
});
