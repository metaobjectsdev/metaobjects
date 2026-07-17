// #207 — END-TO-END: author a projection with a row-scope `@filter`, run the real
// loader → extractViewSpec → emitViewDdl pipeline, and assert the outer WHERE. This
// complements view-level-filter-emit.test.ts (which tests the emitter with hand-built
// ViewSpecs) by exercising the extraction that resolves each filter ref against the
// projection's declared SelectColumns (passthrough base/joined, computed, fail-closed).

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { extractViewSpec } from "../../src/projection/extract-view-spec.js";
import { emitViewDdl } from "../../src/projection/view-ddl-emit.js";

/** Loader errors carry a stable `.code` (ParseError), but LoadResult types them as
 *  plain Error — narrow to read the code in assertions. */
type CodedError = Error & { readonly code?: string };
const codeOf = (e: Error): string | undefined => (e as CodedError).code;

async function loadResult(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "test", children } });
  return new MetaDataLoader().load([new InMemoryStringSource(json)]);
}

async function load(children: unknown[]) {
  const result = await loadResult(children);
  if (result.errors.length > 0) {
    throw new Error(`Loader errors:\n${result.errors.map((e) => `${codeOf(e)}: ${e.message}`).join("\n")}`);
  }
  return result.root;
}

// A belongs-to model: Order → Customer (FK customerId on Order). Order also carries a
// computed flag `hasNote`. Projections filter on base / joined / computed fields.
const CUSTOMER = {
  "object.entity": {
    name: "Customer",
    children: [
      { "source.rdb": { "@table": "customers" } },
      { "field.int": { name: "id" } },
      { "field.string": { name: "region" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
    ],
  },
};

const ORDER = {
  "object.entity": {
    name: "Order",
    children: [
      { "source.rdb": { "@table": "orders" } },
      { "field.int": { name: "id" } },
      { "field.string": { name: "status" } },
      { "field.string": { name: "note" } },
      { "field.int": { name: "customerId" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
      { "identity.reference": { name: "ref_customer", "@fields": "customerId", "@references": "Customer" } },
      { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
    ],
  },
};

/** A projection over Order surfacing base `status`, joined `region`, and a computed
 *  `hasNote`, plus whatever @filter the test supplies. */
function orderProjection(filter: unknown, extraFields: unknown[] = []) {
  return {
    "object.projection": {
      name: "OrderView",
      children: [
        { "source.rdb": { "@kind": "view", "@table": "v_order_view" } },
        { "field.int": { name: "id", extends: "Order.id" } },
        { "field.string": { name: "status", extends: "Order.status" } },
        {
          "field.string": {
            name: "region",
            children: [{ "origin.passthrough": { "@from": "Customer.region", "@via": "Order.customer" } }],
          },
        },
        {
          "field.boolean": {
            name: "hasNote",
            children: [{ "origin.computed": { "@expr": { op: "isNotNull", arg: { field: "note" } } } }],
          },
        },
        ...extraFields,
        { "identity.primary": { name: "id", extends: "Order.id" } },
      ],
      ...(filter !== undefined ? { "@filter": filter } : {}),
    },
  };
}

const OPTS = {
  dialect: "postgres",
  baseTableName: "orders",
  joinTables: { Customer: "customers" },
  bodyOnly: true,
} as const;

async function emit(filter: unknown, extraFields: unknown[] = []): Promise<string> {
  const root = await load([CUSTOMER, ORDER, orderProjection(filter, extraFields)]);
  const proj = root.findObject("OrderView")!;
  const spec = extractViewSpec(proj, root, { columnNamingStrategy: "snake_case" });
  return emitViewDdl(spec, OPTS);
}

describe("#207 extraction — base-field @filter", () => {
  test("no @filter → no WHERE (byte-identical to before)", async () => {
    const sql = await emit(undefined);
    expect(sql).not.toContain("WHERE");
  });

  test("base-field eq → WHERE on the base alias column", async () => {
    const sql = await emit({ status: { eq: "active" } });
    expect(sql).toContain("WHERE o.status = 'active'");
  });

  test("base-field ne (shorthand desugars to canonical) → WHERE", async () => {
    const sql = await emit({ status: { ne: "archived" } });
    expect(sql).toContain("WHERE o.status <> 'archived'");
  });

  test("base-field `in` → WHERE ... IN (...)", async () => {
    const sql = await emit({ status: { in: ["active", "pending"] } });
    expect(sql).toContain("WHERE o.status IN ('active', 'pending')");
  });
});

describe("#207 extraction — joined-field @filter (the crux)", () => {
  test("passthrough joined column resolves to joinAlias.column", async () => {
    const sql = await emit({ region: { eq: "US" } });
    // region passes through Customer.region reached via the `customer` join (alias c).
    expect(sql).toContain("WHERE c.region = 'US'");
    // the join is present
    expect(sql).toContain("customers c");
  });
});

describe("#207 extraction — soft-delete isNull-OR-eq shape", () => {
  test("or[ isNull, eq ] composes to a parenthesized OR on the resolved columns", async () => {
    const sql = await emit({ or: [{ status: { isNull: true } }, { status: { eq: "active" } }] });
    expect(sql).toContain("WHERE (o.status IS NULL OR o.status = 'active')");
  });
});

describe("#207 extraction — computed-field @filter (inlined expression)", () => {
  test("a computed boolean field filters via the inlined expression (exprCmp)", async () => {
    const sql = await emit({ hasNote: true });
    // hasNote = (note IS NOT NULL); `hasNote: true` desugars to { eq: true }.
    expect(sql).toContain("WHERE (o.note IS NOT NULL) = TRUE");
  });
});

describe("#207 extraction — fail-closed: aggregate-derived & dangling refs", () => {
  const AGG_FIELD = {
    "field.int": {
      name: "lineCount",
      children: [{ "origin.aggregate": { "@agg": "count", "@of": "Customer.id", "@via": "Order.customer" } }],
    },
  };

  test("a @filter over an aggregate-derived field is a load error (ERR_BAD_ATTR_FILTER)", async () => {
    const result = await loadResult([CUSTOMER, ORDER, orderProjection({ lineCount: { gt: 0 } }, [AGG_FIELD])]);
    const badFilter = result.errors.find((e) => codeOf(e) === "ERR_BAD_ATTR_FILTER");
    expect(badFilter).toBeDefined();
    expect(badFilter!.message).toContain("aggregate-derived");
  });

  test("a @filter over a non-declared (dangling) field is a load error (ERR_BAD_ATTR_FILTER)", async () => {
    const result = await loadResult([CUSTOMER, ORDER, orderProjection({ nope: { eq: 1 } })]);
    const badFilter = result.errors.find((e) => codeOf(e) === "ERR_BAD_ATTR_FILTER");
    expect(badFilter).toBeDefined();
    expect(badFilter!.message).toContain("not a declared field");
  });
});

describe("#207 extraction — multi-op field clause (range)", () => {
  test("a { gte, lte } range keeps BOTH ops, AND-composed (never drops all-but-first)", async () => {
    const sql = await emit({ id: { gte: 5, lte: 10 } });
    expect(sql).toContain("WHERE (o.id >= 5 AND o.id <= 10)");
  });

  test("a string `like` op renders LIKE (string op-band)", async () => {
    const sql = await emit({ status: { like: "%active%" } });
    expect(sql).toContain("WHERE o.status LIKE '%active%'");
  });
});

// The loader must fail CLOSED on a malformed @filter — the review found several
// malformations that previously failed OPEN (silently no WHERE) or crashed the view
// synthesizer downstream instead of erroring at load. Each must be ERR_BAD_ATTR_FILTER.
describe("#207 validation — malformed @filter fails closed at load", () => {
  async function loadErr(filter: unknown, extra: unknown[] = []): Promise<string | undefined> {
    const result = await loadResult([CUSTOMER, ORDER, orderProjection(filter, extra)]);
    return result.errors.find((e) => codeOf(e) === "ERR_BAD_ATTR_FILTER")?.message;
  }

  test("a non-array `and`/`or` compose key (object-vs-array slip) → load error, not a silent no-WHERE", async () => {
    const msg = await loadErr({ and: { status: { eq: "x" } } });
    expect(msg).toBeDefined();
    expect(msg).toContain("must be an array");
  });

  test("an empty op-object → load error", async () => {
    const msg = await loadErr({ status: {} });
    expect(msg).toBeDefined();
    expect(msg).toContain("no operator");
  });

  test("an unknown op (typo) → load error, not a mid-migrate crash", async () => {
    const msg = await loadErr({ status: { contains: "x" } });
    expect(msg).toBeDefined();
    expect(msg).toContain("not allowed for its type");
  });

  test("a subtype-illegal op (`like` on a boolean computed field) → load error", async () => {
    const msg = await loadErr({ hasNote: { like: "x" } });
    expect(msg).toBeDefined();
    expect(msg).toContain("not allowed for its type");
  });

  test("a range with a mix of a legal and an illegal op reports the illegal one", async () => {
    // `gte` is legal for int `id`; `like` is not — the legal one must not mask the illegal.
    const msg = await loadErr({ id: { gte: 5, like: "x" } });
    expect(msg).toBeDefined();
    expect(msg).toContain("like");
  });
});
