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

// ---------------------------------------------------------------------------
// (4) #342 — the index key is @fields XOR @expr, on BOTH index.lookup and
//     identity.secondary.
//
// @expr has always been registered as "used INSTEAD of @fields" and migrate-ts
// has always keyed off it (`columns: expr ? [] : cols`), but the loader required
// @fields unconditionally — so an expression index could not be declared at all,
// and the one spelling that DID load (@fields AND @expr) had its @fields
// silently discarded downstream.
// ---------------------------------------------------------------------------

function entityWith(child: unknown) {
  return {
    "metadata.root": {
      package: "test::index",
      children: [
        {
          "object.entity": {
            name: "Notification",
            children: [
              { "source.rdb": { "@table": "notifications" } },
              { "field.string": { name: "id", "@required": true } },
              { "field.timestamp": { name: "deliveredAt" } },
              { "field.string": { name: "payload" } },
              { "identity.primary": { name: "pk", "@fields": ["id"] } },
              child,
            ],
          },
        },
      ],
    },
  };
}

describe("#342 — index key is @fields XOR @expr", () => {
  // These two assert the load is CLEAN, not merely free of one error code. Asserting
  // only "no ERR_INVALID_INDEX" would still pass if the child-rule `min` check refused
  // it under a different code — which is precisely how this bug reached an adopter.
  it("index.lookup with @expr and no @fields LOADS (was unreachable)", async () => {
    const { errors } = await load(
      entityWith({
        "index.lookup": {
          name: "pending_device_idx",
          "@expr": "(payload->>'device_id')",
          "@where": "deliveredAt IS NULL",
        },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it("identity.secondary with @expr and no @fields LOADS", async () => {
    const { errors } = await load(
      entityWith({
        "identity.secondary": { name: "lower_id_uk", "@expr": "lower(id)" },
      }),
    );
    expect(errors).toHaveLength(0);
  });

  it("index.lookup declaring BOTH is refused (was accepted, @fields discarded)", async () => {
    const { errors } = await load(
      entityWith({
        "index.lookup": {
          name: "both_idx",
          "@fields": ["deliveredAt"],
          "@expr": "(payload->>'device_id')",
        },
      }),
    );
    const e = errorsWithCode(errors, "ERR_INVALID_INDEX");
    expect(e).toHaveLength(1);
    expect(String((e[0] as { message: string }).message)).toContain("BOTH");
  });

  it("identity.secondary declaring BOTH is refused", async () => {
    const { errors } = await load(
      entityWith({
        "identity.secondary": {
          name: "both_uk",
          "@fields": ["deliveredAt"],
          "@expr": "lower(id)",
        },
      }),
    );
    expect(errorsWithCode(errors, "ERR_INVALID_INDEX")).toHaveLength(1);
  });

  it("declaring NEITHER is still refused, on both node types", async () => {
    const lookup = await load(entityWith({ "index.lookup": { name: "no_key" } }));
    expect(errorsWithCode(lookup.errors, "ERR_INVALID_INDEX")).toHaveLength(1);

    const secondary = await load(
      entityWith({ "identity.secondary": { name: "no_key_uk" } }),
    );
    expect(errorsWithCode(secondary.errors, "ERR_INVALID_INDEX")).toHaveLength(1);
  });

  it("an @expr index resolves nothing against the field set (no false positive)", async () => {
    // @expr is raw SQL over physical columns and is deliberately NOT parsed, so a
    // column named inside it must not be mistaken for an unresolvable @fields entry.
    const { errors } = await load(
      entityWith({
        "index.lookup": { name: "expr_idx", "@expr": "lower(no_such_column)" },
      }),
    );
    expect(errorsWithCode(errors, "ERR_INVALID_INDEX")).toHaveLength(0);
  });
});
