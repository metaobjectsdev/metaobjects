import { describe, test, expect } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import type { ParseError } from "../src/errors.js";

// Wraps a list of top-level object/source/field nodes in a minimal metadata
// envelope and loads them through the MetaDataLoader pipeline.
async function load(children: unknown[]) {
  const loader = new MetaDataLoader();
  const json = JSON.stringify({
    "metadata.root": { package: "test", children },
  });
  const result = await loader.load([new InMemoryStringSource(json)]);
  return {
    errors: result.errors.map((e) => e.message),
    warnings: result.warnings,
    root: result.root,
  };
}

// Like `load`, but keeps the full ParseError objects so tests can assert
// error CODES (FR-024 B5: ERR_AMBIGUOUS_PATH / ERR_ORIGIN_CARDINALITY).
async function loadRaw(children: unknown[]) {
  const loader = new MetaDataLoader();
  const json = JSON.stringify({
    "metadata.root": { package: "test", children },
  });
  const result = await loader.load([new InMemoryStringSource(json)]);
  return {
    errors: result.errors as ParseError[],
    warnings: result.warnings,
    root: result.root,
  };
}

describe("MetaDataLoader validates origin.passthrough.from", () => {
  test("from references a real Entity.field → no error", async () => {
    const result = await load([
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "field.string": { name: "email" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
      {
        // FR-024 (B4b): view-PRIMARY = object.projection, anchored to User by
        // the extends-bound identity (the no-@via passthrough is then a
        // base-relation column).
        "object.projection": {
          name: "UserView",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_user" } },
            { "field.int": { name: "id", extends: "User.id" } },
            {
              "field.string": {
                name: "displayName",
                children: [
                  { "origin.passthrough": { "@from": "User.email" } },
                ],
              },
            },
            { "identity.primary": { "name": "id", extends: "User.id" } },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("from references a missing field → error", async () => {
    const result = await load([
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "UserView",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_user" } },
            { "field.int": { name: "id", extends: "User.id" } },
            {
              "field.string": {
                name: "displayName",
                children: [
                  { "origin.passthrough": { "@from": "User.notReal" } },
                ],
              },
            },
            { "identity.primary": { "name": "id", extends: "User.id" } },
          ],
        },
      },
    ]);
    expect(
      result.errors.some((e) => e.includes("notReal") && e.includes("no such field")),
    ).toBe(true);
  });
});

describe("MetaDataLoader validates origin.aggregate.of", () => {
  test("of references a real field → no error", async () => {
    const result = await load([
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.int":  { name: "id" } },
            { "field.int":  { name: "userId" } },
            { "field.long": { name: "amount" } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
            { "identity.reference": { name: "ref_user", "@fields": "userId", "@references": "User" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            {
              "relationship.association": {
                name: "orders",
                "@objectRef": "Order",
                "@cardinality": "many",
              },
            },
          ],
        },
      },
      {
        // FR-024 (B4b): view-PRIMARY = object.projection, anchored to User.
        "object.projection": {
          name: "UserSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_user_summary" } },
            { "field.int": { name: "id", extends: "User.id" } },
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
            { "identity.primary": { "name": "id", extends: "User.id" } },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("aggregate.agg outside the vocab → error", async () => {
    const result = await load([
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
            {
              "relationship.association": {
                name: "orders",
                "@objectRef": "Order",
                "@cardinality": "many",
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
            { "field.int": { name: "userId" } },
            { "identity.primary":   { "name": "id", "@fields": "id" } },
            { "identity.reference": { name: "ref_user", "@fields": "userId", "@references": "User" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "UserStat",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_user_stat" } },
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
            { "identity.primary": { "name": "id", "@fields": "n" } },
          ],
        },
      },
    ]);
    expect(
      result.errors.some((e) => e.includes("median") && e.includes("aggregate")),
    ).toBe(true);
  });
});

describe("MetaDataLoader validates origin.via paths against relationships", () => {
  test("via references missing relationship segment → error", async () => {
    const result = await load([
      {
        "object.entity": {
          name: "User",
          children: [
            { "field.int": { name: "id" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "UserStat",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_user_stat" } },
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
            { "identity.primary": { "name": "id", "@fields": "n" } },
          ],
        },
      },
    ]);
    expect(
      result.errors.some((e) => e.includes("bogus") && e.includes("no such relationship")),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FR-024 B5 — @via single-hop-unique inference + origin cardinality checks
// (spec §5 base-entity anchoring + §6 via rules; ADR-0029 decisions 5–6)
// ---------------------------------------------------------------------------

// Shared building blocks: Country entity + a Customer entity whose
// relationships to Country are parameterized per test.
const countryEntity = {
  "object.entity": {
    name: "Country",
    children: [
      { "field.uuid": { name: "id" } },
      { "field.string": { name: "name" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
    ],
  },
};

function customerEntity(relationships: unknown[], extraChildren: unknown[] = []) {
  return {
    "object.entity": {
      name: "Customer",
      children: [
        { "field.uuid": { name: "id" } },
        { "field.string": { name: "name" } },
        ...extraChildren,
        ...relationships,
        { "identity.primary": { name: "id", "@fields": "id" } },
      ],
    },
  };
}

const oneCountryRel = {
  "relationship.association": {
    name: "country",
    "@objectRef": "Country",
    "@cardinality": "one",
  },
};

// A projection over Customer (FR-024 B3 conventions: extended identity,
// pass-through key field) carrying one derived field from Country.name.
function customerProjection(origin: unknown) {
  return {
    "object.projection": {
      name: "CustomerSummary",
      children: [
        { "field.uuid": { name: "customerId", extends: "Customer.id" } },
        {
          "field.string": {
            name: "countryName",
            children: [origin],
          },
        },
        { "identity.primary": { name: "id", extends: "Customer.id" } },
      ],
    },
  };
}

describe("FR-024 B5 — single-hop-unique @via inference (passthrough)", () => {
  test("projection-hosted passthrough with NO @via infers the single hop (base from extended identity)", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjection({ "origin.passthrough": { "@from": "Country.name" } }),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("entity-hosted derived field with NO @via infers the single hop (base = the entity itself)", async () => {
    const result = await load([
      countryEntity,
      customerEntity(
        [oneCountryRel],
        [
          { "source.rdb": { "@table": "customers" } },
          { "source.rdb": { "@kind": "view", "@view": "v_customers", "@role": "replica" } },
          {
            "field.string": {
              name: "countryName",
              children: [{ "origin.passthrough": { "@from": "Country.name" } }],
            },
          },
        ],
      ),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("two candidate relationships → ERR_AMBIGUOUS_PATH naming both", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity(
        [
          {
            "relationship.association": {
              name: "homeCountry",
              "@objectRef": "Country",
              "@cardinality": "one",
            },
          },
          {
            "relationship.association": {
              name: "billingCountry",
              "@objectRef": "Country",
              "@cardinality": "one",
            },
          },
        ],
        [
          {
            "field.string": {
              name: "countryName",
              children: [{ "origin.passthrough": { "@from": "Country.name" } }],
            },
          },
        ],
      ),
    ]);
    const ambiguous = result.errors.filter((e) => e.code === "ERR_AMBIGUOUS_PATH");
    expect(ambiguous.length).toBe(1);
    expect(ambiguous[0]!.message).toContain("homeCountry");
    expect(ambiguous[0]!.message).toContain("billingCountry");
  });

  test("zero relationships to the @from entity → ERR_INVALID_ORIGIN (cannot infer)", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity(
        [],
        [
          {
            "field.string": {
              name: "countryName",
              children: [{ "origin.passthrough": { "@from": "Country.name" } }],
            },
          },
        ],
      ),
    ]);
    const invalid = result.errors.filter((e) => e.code === "ERR_INVALID_ORIGIN");
    expect(invalid.length).toBe(1);
    expect(invalid[0]!.message).toContain("cannot infer");
  });

  test("@from targeting the base entity itself with no @via = base-relation column, no checks", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjection({ "origin.passthrough": { "@from": "Customer.name" } }),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("projection with NO identity: base falls back to the single field-extends entity", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel]),
      {
        "object.projection": {
          name: "CustomerSlice",
          children: [
            { "field.uuid": { name: "customerId", extends: "Customer.id" } },
            {
              "field.string": {
                name: "countryName",
                children: [{ "origin.passthrough": { "@from": "Country.name" } }],
              },
            },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("projection with NO identity and field-extends to two entities → ERR_AMBIGUOUS_PATH instructing to declare an extended identity", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity([oneCountryRel]),
      {
        "object.entity": {
          name: "Supplier",
          children: [
            { "field.uuid": { name: "id" } },
            { "field.string": { name: "label" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "MixedSlice",
          children: [
            { "field.uuid": { name: "customerId", extends: "Customer.id" } },
            { "field.string": { name: "supplierLabel", extends: "Supplier.label" } },
            {
              "field.string": {
                name: "countryName",
                children: [{ "origin.passthrough": { "@from": "Country.name" } }],
              },
            },
          ],
        },
      },
    ]);
    const ambiguous = result.errors.filter((e) => e.code === "ERR_AMBIGUOUS_PATH");
    expect(ambiguous.length).toBe(1);
    expect(ambiguous[0]!.message).toContain("extended identity");
  });

  test("object.value host (FR-015 parameter lineage) is exempt — no inference, no checks", async () => {
    const result = await load([
      countryEntity,
      {
        "object.value": {
          name: "CountryArgs",
          children: [
            {
              "field.string": {
                name: "countryName",
                children: [{ "origin.passthrough": { "@from": "Country.name" } }],
              },
            },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });
});

describe("FR-024 B5 — single-hop-unique @via inference (aggregate)", () => {
  const orderEntity = {
    "object.entity": {
      name: "Order",
      children: [
        { "field.uuid": { name: "id" } },
        { "field.long": { name: "amount" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ],
    },
  };

  function userEntity(cardinality: string) {
    return {
      "object.entity": {
        name: "User",
        children: [
          { "field.uuid": { name: "id" } },
          {
            "relationship.association": {
              name: "orders",
              "@objectRef": "Order",
              "@cardinality": cardinality,
            },
          },
          { "identity.primary": { name: "id", "@fields": "id" } },
        ],
      },
    };
  }

  function userProjection(origin: unknown) {
    return {
      "object.projection": {
        name: "UserSummary",
        children: [
          { "field.uuid": { name: "userId", extends: "User.id" } },
          { "field.long": { name: "totalSpent", children: [origin] } },
          { "identity.primary": { name: "id", extends: "User.id" } },
        ],
      },
    };
  }

  test("aggregate with NO @via infers the single (to-many) hop", async () => {
    const result = await load([
      orderEntity,
      userEntity("many"),
      userProjection({
        "origin.aggregate": { "@agg": "sum", "@of": "Order.amount" },
      }),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("aggregate inferred over a to-one relationship → ERR_ORIGIN_CARDINALITY (you meant passthrough)", async () => {
    const result = await loadRaw([
      orderEntity,
      userEntity("one"),
      userProjection({
        "origin.aggregate": { "@agg": "sum", "@of": "Order.amount" },
      }),
    ]);
    const cardinality = result.errors.filter((e) => e.code === "ERR_ORIGIN_CARDINALITY");
    expect(cardinality.length).toBe(1);
    expect(cardinality[0]!.message).toContain("you meant passthrough");
  });

  test("aggregate with NO @via and @of targeting the base entity itself → ERR_INVALID_ORIGIN (relationship path required)", async () => {
    const result = await loadRaw([
      orderEntity,
      userEntity("many"),
      userProjection({
        "origin.aggregate": { "@agg": "count", "@of": "User.id" },
      }),
    ]);
    const invalid = result.errors.filter((e) => e.code === "ERR_INVALID_ORIGIN");
    expect(invalid.length).toBe(1);
    expect(invalid[0]!.message).toContain("missing @via");
  });
});

describe("FR-024 B5 — origin cardinality checks on EXPLICIT @via paths", () => {
  test("passthrough via a to-many hop → ERR_ORIGIN_CARDINALITY (row-multiplying — you meant aggregate)", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity([
        {
          "relationship.association": {
            name: "countries",
            "@objectRef": "Country",
            "@cardinality": "many",
          },
        },
      ]),
      customerProjection({
        "origin.passthrough": { "@from": "Country.name", "@via": "Customer.countries" },
      }),
    ]);
    const cardinality = result.errors.filter((e) => e.code === "ERR_ORIGIN_CARDINALITY");
    expect(cardinality.length).toBe(1);
    expect(cardinality[0]!.message).toContain("you meant aggregate");
  });

  test("passthrough inferred over a to-many relationship → ERR_ORIGIN_CARDINALITY", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity([
        {
          "relationship.association": {
            name: "countries",
            "@objectRef": "Country",
            "@cardinality": "many",
          },
        },
      ]),
      customerProjection({ "origin.passthrough": { "@from": "Country.name" } }),
    ]);
    const cardinality = result.errors.filter((e) => e.code === "ERR_ORIGIN_CARDINALITY");
    expect(cardinality.length).toBe(1);
  });

  test("aggregate via a path that is to-one at EVERY hop → ERR_ORIGIN_CARDINALITY (you meant passthrough)", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjection({
        "origin.aggregate": { "@agg": "count", "@of": "Country.id", "@via": "Customer.country" },
      }),
    ]);
    const cardinality = result.errors.filter((e) => e.code === "ERR_ORIGIN_CARDINALITY");
    expect(cardinality.length).toBe(1);
    expect(cardinality[0]!.message).toContain("you meant passthrough");
  });

  test("explicit @via through a to-one hop on a passthrough stays valid (regression)", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjection({
        "origin.passthrough": { "@from": "Country.name", "@via": "Customer.country" },
      }),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("aggregate via an UNDECLARED-cardinality hop is not judged (open @cardinality vocabulary — regression)", async () => {
    const result = await load([
      countryEntity,
      customerEntity([
        {
          "relationship.association": {
            name: "countries",
            "@objectRef": "Country",
          },
        },
      ]),
      customerProjection({
        "origin.aggregate": { "@agg": "count", "@of": "Country.id", "@via": "Customer.countries" },
      }),
    ]);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// FR-024 B6 — extends/origin agreement (ERR_EXTENDS_ORIGIN_MISMATCH)
// (spec §4 coherence check; ADR-0029 decision 7)
// ---------------------------------------------------------------------------

const regionEntity = {
  "object.entity": {
    name: "Region",
    children: [
      { "field.uuid": { name: "id" } },
      { "field.string": { name: "name" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
    ],
  },
};

const oneRegionRel = {
  "relationship.association": {
    name: "region",
    "@objectRef": "Region",
    "@cardinality": "one",
  },
};

// A projection over Customer with ONE configurable field (extends + children).
function customerProjectionWithField(field: Record<string, unknown>) {
  return {
    "object.projection": {
      name: "CustomerSummary",
      children: [
        { "field.uuid": { name: "customerId", extends: "Customer.id" } },
        { "field.string": field },
        { "identity.primary": { name: "id", extends: "Customer.id" } },
      ],
    },
  };
}

describe("FR-024 B6 — extends/origin agreement (ERR_EXTENDS_ORIGIN_MISMATCH)", () => {
  test("field extends Customer.name + passthrough @from Region.name → ERR_EXTENDS_ORIGIN_MISMATCH", async () => {
    const result = await loadRaw([
      regionEntity,
      customerEntity([oneRegionRel]),
      customerProjectionWithField({
        name: "label",
        extends: "Customer.name",
        children: [{ "origin.passthrough": { "@from": "Region.name" } }],
      }),
    ]);
    const mismatch = result.errors.filter((e) => e.code === "ERR_EXTENDS_ORIGIN_MISMATCH");
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]!.message).toContain("Customer.name");
    expect(mismatch[0]!.message).toContain("Region.name");
    // FR5d resolved envelope: referrer = host::field, target = the @from ref.
    const src = mismatch[0]!.source as { format: string; referrer?: string; target?: string };
    expect(src.format).toBe("resolved");
    expect(src.referrer).toContain("CustomerSummary::label");
    expect(src.target).toBe("Region.name");
    // No other error muddies the fixture-shaped scenario.
    expect(result.errors.length).toBe(1);
  });

  test("extends Customer.name + @from a DIFFERENT field of the same entity → ERR_EXTENDS_ORIGIN_MISMATCH", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjectionWithField({
        name: "label",
        extends: "Customer.name",
        children: [{ "origin.passthrough": { "@from": "Customer.id" } }],
      }),
    ]);
    const mismatch = result.errors.filter((e) => e.code === "ERR_EXTENDS_ORIGIN_MISMATCH");
    expect(mismatch.length).toBe(1);
  });

  test("agreeing targets through a joined hop (extends Country.name + @from Country.name) → silent", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjectionWithField({
        name: "countryName",
        extends: "Country.name",
        children: [{ "origin.passthrough": { "@from": "Country.name" } }],
      }),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("agreeing base-relation targets (extends Customer.name + @from Customer.name) → silent", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjectionWithField({
        name: "label",
        extends: "Customer.name",
        children: [{ "origin.passthrough": { "@from": "Customer.name" } }],
      }),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("extends + origin.AGGREGATE is not judged (aggregate computes something new)", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity([
        {
          "relationship.association": {
            name: "countries",
            "@objectRef": "Country",
            "@cardinality": "many",
          },
        },
      ]),
      customerProjectionWithField({
        name: "label",
        extends: "Customer.name",
        children: [{ "origin.aggregate": { "@agg": "count", "@of": "Country.id" } }],
      }),
    ]);
    expect(result.errors.filter((e) => e.code === "ERR_EXTENDS_ORIGIN_MISMATCH")).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test("object.value host: extends + AGREEING @from stays untouched (FR-004 payload protection)", async () => {
    const result = await load([
      countryEntity,
      {
        "object.value": {
          name: "CountryArgs",
          children: [
            {
              "field.string": {
                name: "countryName",
                extends: "Country.name",
                children: [{ "origin.passthrough": { "@from": "Country.name" } }],
              },
            },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("object.value host: extends + MISMATCHED @from is judged too (host-agnostic)", async () => {
    const result = await loadRaw([
      countryEntity,
      regionEntity,
      {
        "object.value": {
          name: "CountryArgs",
          children: [
            {
              "field.string": {
                name: "countryName",
                extends: "Country.name",
                children: [{ "origin.passthrough": { "@from": "Region.name" } }],
              },
            },
          ],
        },
      },
    ]);
    const mismatch = result.errors.filter((e) => e.code === "ERR_EXTENDS_ORIGIN_MISMATCH");
    expect(mismatch.length).toBe(1);
  });

  test("extends of a TOP-LEVEL abstract field + entity-@from is NOT judged (shape-only reuse, no lineage claim)", async () => {
    const result = await load([
      { "field.string": { name: "commonLabel" } },
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjectionWithField({
        name: "countryName",
        extends: "commonLabel",
        children: [{ "origin.passthrough": { "@from": "Country.name" } }],
      }),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("agreement follows the extends CHAIN (extends a projection field that extends Customer.name + @from Customer.name) → silent", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjectionWithField({
        name: "custName",
        extends: "Customer.name",
      }),
      {
        "object.projection": {
          name: "CustomerCard",
          children: [
            { "field.uuid": { name: "customerId", extends: "Customer.id" } },
            {
              "field.string": {
                name: "custName",
                extends: "CustomerSummary.custName",
                children: [{ "origin.passthrough": { "@from": "Customer.name" } }],
              },
            },
            { "identity.primary": { name: "id", extends: "Customer.id" } },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("extends + explicit @via passthrough with a mismatched @from is judged (agreement is via-independent)", async () => {
    const result = await loadRaw([
      countryEntity,
      regionEntity,
      customerEntity([oneCountryRel, oneRegionRel]),
      customerProjectionWithField({
        name: "label",
        extends: "Country.name",
        children: [
          { "origin.passthrough": { "@from": "Region.name", "@via": "Customer.region" } },
        ],
      }),
    ]);
    const mismatch = result.errors.filter((e) => e.code === "ERR_EXTENDS_ORIGIN_MISMATCH");
    expect(mismatch.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// FR-024 B6 — derived-field providability (ERR_DERIVED_FIELD_NO_READ_SOURCE)
// (spec §7 multi-source pattern: a derived field must be providable)
// ---------------------------------------------------------------------------

describe("FR-024 B6 — derived-field providability (ERR_DERIVED_FIELD_NO_READ_SOURCE)", () => {
  const derivedCountryNameField = {
    "field.string": {
      name: "countryName",
      children: [{ "origin.passthrough": { "@from": "Country.name" } }],
    },
  };

  test("entity with ONLY a writable table source + an origin-bearing field → ERR_DERIVED_FIELD_NO_READ_SOURCE", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity(
        [oneCountryRel],
        [{ "source.rdb": { "@table": "customers" } }, derivedCountryNameField],
      ),
    ]);
    const noRead = result.errors.filter((e) => e.code === "ERR_DERIVED_FIELD_NO_READ_SOURCE");
    expect(noRead.length).toBe(1);
    expect(noRead[0]!.message).toContain("countryName");
    expect(noRead[0]!.message).toContain("read-capable");
    expect(result.errors.length).toBe(1);
  });

  test("entity with NO source at all + an origin-bearing field → ERR_DERIVED_FIELD_NO_READ_SOURCE (nothing provides)", async () => {
    const result = await loadRaw([
      countryEntity,
      customerEntity([oneCountryRel], [derivedCountryNameField]),
    ]);
    const noRead = result.errors.filter((e) => e.code === "ERR_DERIVED_FIELD_NO_READ_SOURCE");
    expect(noRead.length).toBe(1);
  });

  test("table-primary + view-replica (spec §7 multi-source pattern) → providable, silent", async () => {
    const result = await load([
      countryEntity,
      customerEntity(
        [oneCountryRel],
        [
          { "source.rdb": { "@table": "customers" } },
          { "source.rdb": { "@kind": "view", "@view": "v_customers", "@role": "replica" } },
          derivedCountryNameField,
        ],
      ),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("view-PRIMARY entity → ERR_ENTITY_PRIMARY_SOURCE_READONLY (the B4b hard cutover)", async () => {
    const result = await load([
      countryEntity,
      customerEntity(
        [oneCountryRel],
        [
          { "source.rdb": { "@kind": "view", "@view": "v_customers" } },
          derivedCountryNameField,
        ],
      ),
    ]);
    // The legacy view-PRIMARY entity spelling is removed outright: an entity's
    // primary source must be writable; a derived read model is an
    // object.projection (FR-024, ADR-0028).
    expect(
      result.errors.some((e) => e.includes("primary source of read-only kind")),
    ).toBe(true);
  });

  test("projection host is EXEMPT (the projection's own source/wire IS the provider)", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel]),
      customerProjection({ "origin.passthrough": { "@from": "Country.name" } }),
    ]);
    expect(result.errors).toEqual([]);
  });

  test("object.value host is EXEMPT (FR-015 lineage; values are constructed, never populated)", async () => {
    const result = await load([
      countryEntity,
      {
        "object.value": {
          name: "CountryArgs",
          children: [
            {
              "field.string": {
                name: "countryName",
                children: [{ "origin.passthrough": { "@from": "Country.name" } }],
              },
            },
          ],
        },
      },
    ]);
    expect(result.errors).toEqual([]);
  });

  test("entity with a read-only-kind source and a field WITHOUT origin → field is not judged", async () => {
    const result = await load([
      countryEntity,
      customerEntity([oneCountryRel], [{ "source.rdb": { "@table": "customers" } }]),
    ]);
    expect(result.errors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #195 — four projection read-model origin capabilities.
// ---------------------------------------------------------------------------

// A Session/Turn graph + a projection carrying one origin field (configurable).
function sessionModel(originField: unknown) {
  return [
    {
      "object.entity": {
        name: "Session",
        children: [
          { "field.long": { name: "id" } },
          { "relationship.association": { name: "turns", "@objectRef": "Turn", "@cardinality": "many" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
    {
      "object.entity": {
        name: "Turn",
        children: [
          { "field.long": { name: "id" } },
          { "field.boolean": { name: "success" } },
          { "field.string": { name: "label" } },
          { "field.timestamp": { name: "createdAt" } },
          { "identity.primary": { "name": "id", "@fields": "id" } },
        ],
      },
    },
    {
      "object.projection": {
        name: "SessionSummary",
        children: [
          { "source.rdb": { "@kind": "view", "@table": "v_session" } },
          { "field.long": { name: "id", extends: "Session.id" } },
          originField,
          { "identity.primary": { "name": "id", extends: "Session.id" } },
        ],
      },
    },
  ];
}

describe("#195 origin.aggregate @agg any|all validation", () => {
  test("any: boolean field + @filter + @via, no @of → no error", async () => {
    const result = await load(sessionModel({
      "field.boolean": { name: "hasError", children: [
        { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { success: false } } },
      ] },
    }));
    expect(result.errors).toEqual([]);
  });

  test("all: vacuous-truth quantifier is likewise valid", async () => {
    const result = await load(sessionModel({
      "field.boolean": { name: "allOk", children: [
        { "origin.aggregate": { "@agg": "all", "@via": "Session.turns", "@filter": { success: true } } },
      ] },
    }));
    expect(result.errors).toEqual([]);
  });

  test("any without @filter → ERR_INVALID_ORIGIN", async () => {
    const result = await loadRaw(sessionModel({
      "field.boolean": { name: "hasError", children: [
        { "origin.aggregate": { "@agg": "any", "@via": "Session.turns" } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /@filter/.test(e.message))).toBe(true);
  });

  test("any WITH @of → ERR_INVALID_ORIGIN (@of forbidden for quantifiers)", async () => {
    const result = await loadRaw(sessionModel({
      "field.boolean": { name: "hasError", children: [
        { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { success: false }, "@of": "Turn.success" } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /@of/.test(e.message))).toBe(true);
  });

  test("any on a non-boolean field → ERR_INVALID_ORIGIN", async () => {
    const result = await loadRaw(sessionModel({
      "field.string": { name: "hasError", children: [
        { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { success: false } } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /boolean/.test(e.message))).toBe(true);
  });

  test("any on an isArray field → ERR_INVALID_ORIGIN (inverse rule)", async () => {
    const result = await loadRaw(sessionModel({
      "field.boolean": { name: "hasError", isArray: true, children: [
        { "origin.aggregate": { "@agg": "any", "@via": "Session.turns", "@filter": { success: false } } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /isArray|array/.test(e.message))).toBe(true);
  });
});

describe("#195 origin.aggregate @agg collect validation", () => {
  test("collect: isArray field + @of + @via → no error", async () => {
    const result = await load(sessionModel({
      "field.string": { name: "labels", isArray: true, children: [
        { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns", "@distinct": true } },
      ] },
    }));
    expect(result.errors).toEqual([]);
  });

  test("collect on a non-array field → ERR_INVALID_ORIGIN", async () => {
    const result = await loadRaw(sessionModel({
      "field.string": { name: "labels", children: [
        { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns" } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /isArray|array/.test(e.message))).toBe(true);
  });

  test("collect element type must match @of subtype → ERR_INVALID_ORIGIN", async () => {
    const result = await loadRaw(sessionModel({
      "field.long": { name: "labels", isArray: true, children: [
        { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns" } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /type|subType|match/i.test(e.message))).toBe(true);
  });

  test("@distinct on a non-collect aggregate → ERR_INVALID_ORIGIN", async () => {
    const result = await loadRaw(sessionModel({
      "field.long": { name: "turnCount", children: [
        { "origin.aggregate": { "@agg": "count", "@of": "Turn.id", "@via": "Session.turns", "@distinct": true } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /distinct/.test(e.message))).toBe(true);
  });

  test("@orderBy WITH @distinct on collect → ERR_INVALID_ORIGIN", async () => {
    const result = await loadRaw(sessionModel({
      "field.string": { name: "labels", isArray: true, children: [
        { "origin.aggregate": { "@agg": "collect", "@of": "Turn.label", "@via": "Session.turns", "@distinct": true, "@orderBy": ["label:asc"] } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /orderBy/.test(e.message))).toBe(true);
  });

  test("non-collect aggregate on an isArray field → ERR_INVALID_ORIGIN (inverse rule)", async () => {
    const result = await loadRaw(sessionModel({
      "field.long": { name: "turnCount", isArray: true, children: [
        { "origin.aggregate": { "@agg": "count", "@of": "Turn.id", "@via": "Session.turns" } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /isArray|array/.test(e.message))).toBe(true);
  });
});

describe("#195 origin.computed validation", () => {
  // A computed field references the base entity's OWN fields (no @via).
  function computedModel(field: unknown) {
    return [
      {
        "object.entity": {
          name: "LlmCall",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "payloadJson" } },
            { "field.long": { name: "durationMs" } },
            { "identity.primary": { "name": "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "LlmCallSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_llm" } },
            { "field.long": { name: "id", extends: "LlmCall.id" } },
            field,
            { "identity.primary": { "name": "id", extends: "LlmCall.id" } },
          ],
        },
      },
    ];
  }

  test("isNotNull over a base field → boolean field, no error", async () => {
    const result = await load(computedModel({
      "field.boolean": { name: "hasPayload", children: [
        { "origin.computed": { "@expr": { op: "isNotNull", arg: { field: "payloadJson" } } } },
      ] },
    }));
    expect(result.errors).toEqual([]);
  });

  test("inferred boolean vs declared string field → ERR_COMPUTED_TYPE_MISMATCH", async () => {
    const result = await loadRaw(computedModel({
      "field.string": { name: "hasPayload", children: [
        { "origin.computed": { "@expr": { op: "isNotNull", arg: { field: "payloadJson" } } } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_COMPUTED_TYPE_MISMATCH")).toBe(true);
  });

  test("field ref to a non-existent base field → error", async () => {
    const result = await loadRaw(computedModel({
      "field.boolean": { name: "hasPayload", children: [
        { "origin.computed": { "@expr": { op: "isNotNull", arg: { field: "nope" } } } },
      ] },
    }));
    expect(result.errors.some((e) => /nope/.test(e.message) && (e.code === "ERR_INVALID_ORIGIN" || e.code === "ERR_UNKNOWN_EXPR_NODE"))).toBe(true);
  });

  test("unknown expression op → ERR_UNKNOWN_EXPR_NODE", async () => {
    const result = await loadRaw(computedModel({
      "field.boolean": { name: "hasPayload", children: [
        { "origin.computed": { "@expr": { op: "regexp", arg: { field: "payloadJson" } } } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_UNKNOWN_EXPR_NODE")).toBe(true);
  });
});

describe("#195 origin.first validation", () => {
  test("first: @of + @via + @orderBy + @filter, non-required field → no error", async () => {
    const result = await load(sessionModel({
      "field.string": { name: "latestLabel", children: [
        { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"], "@filter": { success: true } } },
      ] },
    }));
    expect(result.errors).toEqual([]);
  });

  test("first on a @required field → ERR_INVALID_ORIGIN (empty set → null)", async () => {
    const result = await loadRaw(sessionModel({
      "field.string": { name: "latestLabel", "@required": true, children: [
        { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"] } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /required/.test(e.message))).toBe(true);
  });

  test("first @of type-preservation: field.long vs @of string → ERR_INVALID_ORIGIN", async () => {
    const result = await loadRaw(sessionModel({
      "field.long": { name: "latestLabel", children: [
        { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["createdAt:desc"] } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /type|subType|match/i.test(e.message))).toBe(true);
  });

  test("first @orderBy key that does not resolve on the related entity → ERR_INVALID_ORIGIN", async () => {
    const result = await loadRaw(sessionModel({
      "field.string": { name: "latestLabel", children: [
        { "origin.first": { "@of": "Turn.label", "@via": "Session.turns", "@orderBy": ["nope:desc"] } },
      ] },
    }));
    expect(result.errors.some((e) => e.code === "ERR_INVALID_ORIGIN" && /nope|orderBy/.test(e.message))).toBe(true);
  });
});
