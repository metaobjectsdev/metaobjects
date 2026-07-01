// Task 3 — index.lookup field-resolution validation tests (TDD).
//
// Tests: (1) empty @fields → ERR_INVALID_INDEX
//         (2) unknown field in @fields → ERR_INVALID_INDEX
//         (3) inherited field via extends → loads OK (ADR-0039 resolving accessor)

import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";

async function load(doc: unknown, strict = false) {
  const loader = new MetaDataLoader({ strict });
  return loader.load([
    new InMemoryStringSource(JSON.stringify(doc), { id: "test.json" }),
  ]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errorsWithCode(errors: unknown[], code: string) {
  return errors.filter((e) => (e as { code?: string }).code === code);
}

// ---------------------------------------------------------------------------
// (1) Empty @fields — ERR_INVALID_INDEX
// ---------------------------------------------------------------------------

describe("index.lookup field-resolution — empty @fields", () => {
  it("emits ERR_INVALID_INDEX when @fields is an empty array", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test::index",
        children: [
          {
            "object.entity": {
              name: "Order",
              children: [
                { "field.long": { name: "id" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
                {
                  "index.lookup": {
                    name: "idx_empty",
                    "@fields": [],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const invalidIndex = errorsWithCode(errors, "ERR_INVALID_INDEX");
    expect(invalidIndex.length).toBeGreaterThan(0);
    expect(
      invalidIndex.some((e) =>
        (e as { message?: string }).message?.toLowerCase().includes("idx_empty"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (2) Non-existent field in @fields — ERR_INVALID_INDEX
// ---------------------------------------------------------------------------

describe("index.lookup field-resolution — unknown field", () => {
  it("emits ERR_INVALID_INDEX when @fields names a field not on the entity", async () => {
    const { errors } = await load({
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
                    name: "idx_bad",
                    "@fields": ["customerId", "nonExistentField"],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const invalidIndex = errorsWithCode(errors, "ERR_INVALID_INDEX");
    expect(invalidIndex.length).toBeGreaterThan(0);
    expect(
      invalidIndex.some((e) =>
        (e as { message?: string }).message?.includes("nonExistentField"),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (3) Inherited field via extends — loads OK (ADR-0039)
// ---------------------------------------------------------------------------

describe("index.lookup field-resolution — inherited field via extends", () => {
  it("does NOT emit ERR_INVALID_INDEX when the field is inherited from an abstract base", async () => {
    const { errors } = await load({
      "metadata.root": {
        package: "test::index",
        children: [
          {
            // Abstract base declaring the createdAt field
            "object.entity": {
              name: "BaseEntity",
              abstract: true,
              children: [
                { "field.long": { name: "id" } },
                { "field.timestamp": { name: "createdAt" } },
                { "identity.primary": { name: "pk", "@fields": ["id"] } },
              ],
            },
          },
          {
            // Concrete entity that extends BaseEntity — inherits createdAt
            "object.entity": {
              name: "Order",
              extends: "BaseEntity",
              children: [
                { "field.long": { name: "customerId" } },
                {
                  // The index references 'createdAt' which is inherited, not own
                  "index.lookup": {
                    name: "idx_customer_created",
                    "@fields": ["customerId", "createdAt"],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    const invalidIndex = errorsWithCode(errors, "ERR_INVALID_INDEX");
    expect(invalidIndex).toHaveLength(0);
  });
});
