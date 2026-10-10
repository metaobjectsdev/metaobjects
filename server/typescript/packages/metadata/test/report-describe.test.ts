// The reporting vocabulary in words (FR-044): the one home of the sentences `meta docs`
// prints on the markdown model pages and on the HTML site.

import { describe, expect, test } from "bun:test";
import {
  InMemoryStringSource,
  MetaDataLoader,
  describeDimension,
  describeDimensionColumn,
  describeFilter,
  describeMeasure,
  describeReportField,
  describeReportRowScope,
  describeReportRows,
  describeRowScope,
  describeSegment,
  reportFieldTypeName,
  reportNotServedReason,
  reportShape,
  reportingDescribedAttrs,
  type MetaData,
  type MetaObject,
  type MetaRoot,
} from "../src/index.js";

const view = (name: string, kind = "view") => ({ "source.rdb": { "@kind": kind, "@table": name } });

const MODEL = {
  "metadata.root": {
    package: "acme::billing",
    children: [
      { "object.entity": { name: "Customer", children: [
        { "source.rdb": { "@table": "customers" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "region" } },
        { "field.timestamp": { name: "joinedAt" } },
        { "identity.primary": { name: "id", "@fields": ["id"] } },
      ] } },
      { "object.entity": { name: "Invoice", children: [
        { "source.rdb": { "@table": "invoices" } },
        { "field.long": { name: "id" } },
        { "field.long": { name: "customerId" } },
        { "field.currency": { name: "amountCents" } },
        { "field.string": { name: "status" } },
        { "field.string": { name: "tags", isArray: true } },
        { "field.boolean": { name: "voided" } },
        { "field.date": { name: "issuedOn" } },
        { "identity.primary": { name: "id", "@fields": ["id"] } },
        { "identity.reference": { name: "customerRef", "@references": "Customer", "@fields": ["customerId"] } },
        { "relationship.association": { name: "customer", "@objectRef": "Customer", "@cardinality": "one" } },
        { "dimension.attribute": { name: "status", "@of": "Invoice.status" } },
        { "dimension.attribute": { name: "tags", "@of": "Invoice.tags" } },
        { "dimension.attribute": { name: "region", "@of": "Customer.region", "@via": "Invoice.customer" } },
        { "dimension.time": { name: "issuedOn", "@of": "Invoice.issuedOn", "@grains": ["day", "month"] } },
        { "dimension.time": { name: "customerJoinedAt", "@of": "Customer.joinedAt", "@via": "Invoice.customer", "@grains": ["hour", "month"] } },
        { "measure.aggregate": { name: "invoices", "@agg": "count", "@of": "Invoice.id" } },
        { "measure.aggregate": { name: "customers", "@agg": "count", "@distinct": true, "@of": ["Invoice.customerId", "Invoice.status"] } },
        { "measure.aggregate": { name: "paidInvoices", "@agg": "count", "@of": "Invoice.id", "@segment": "paid" } },
        { "measure.aggregate": { name: "liveCents", "@agg": "sum", "@of": "Invoice.amountCents", "@filter": { voided: false } } },
        { "measure.aggregate": { name: "paidLiveCents", "@agg": "sum", "@of": "Invoice.amountCents", "@segment": "paid", "@filter": { voided: false } } },
        { "measure.ratio": { name: "paidShare", "@numerator": "paidInvoices", "@denominator": "invoices" } },
        { "segment.filter": { name: "paid", "@filter": { status: "paid" } } },
        { "measure.aggregate": { name: "liveCentsOrZero", "@agg": "sum", "@of": "Invoice.amountCents", "@filter": { voided: false }, "@default": 0 } },
        { "measure.ratio": { name: "paidShareOrNone", "@numerator": "paidInvoices", "@denominator": "invoices", "@default": -1 } },
      ] } },
      { "object.report": { name: "ByMonth", "@from": "Invoice",
        "@dimensions": ["issuedOn:month", "customerJoinedAt:month", "region", "tags"],
        "@measures": ["invoices", "paidShare"], children: [view("v_by_month")] } },
      { "object.report": { name: "Sourceless", "@from": "Invoice", "@measures": ["invoices"] } },
      { "object.report": { name: "Materialized", "@from": "Invoice", "@measures": ["invoices"],
        children: [view("mv_invoices", "materializedView")] } },
      { "object.report": { name: "AbstractReport", abstract: true, "@from": "Invoice", "@measures": ["invoices"],
        children: [view("v_abstract")] } },
      { "object.report": { name: "PaidTotals", "@from": "Invoice", "@measures": ["invoices"], "@segment": "paid" } },
      { "object.report": { name: "PaidByRegion", "@from": "Invoice", "@spine": "Invoice.customer",
        "@dimensions": ["region"], "@measures": ["invoices", "liveCentsOrZero"], "@segment": "paid" } },
      { "object.report": { name: "CustomerRoster", "@from": "Invoice", "@spine": "Invoice.customer",
        "@dimensions": ["region"], "@measures": ["invoices"] } },
    ],
  },
};

async function load(): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL), { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return res.root;
}
const object = (root: MetaRoot, name: string): MetaObject => {
  const found = root.objects().find((o) => o.name === name);
  if (found === undefined) throw new Error(`no object ${name}`);
  return found;
};
const member = (root: MetaRoot, type: string, name: string): MetaData => {
  const found = object(root, "Invoice").children().find((c) => c.type === type && c.name === name);
  if (found === undefined) throw new Error(`no ${type} ${name}`);
  return found;
};

describe("describing a dimension", () => {
  test("an attribute dimension is its column; @via is appended", async () => {
    const root = await load();
    expect(describeDimension(member(root, "dimension", "status"))).toBe("`Invoice.status`");
    expect(describeDimension(member(root, "dimension", "region"))).toBe("`Customer.region` via `Invoice.customer`");
  });

  test("a time dimension lists its grains", async () => {
    const root = await load();
    expect(describeDimension(member(root, "dimension", "issuedOn"))).toBe("`Invoice.issuedOn`; grains: day, month");
    expect(describeDimension(member(root, "dimension", "customerJoinedAt")))
      .toBe("`Customer.joinedAt` via `Invoice.customer`; grains: hour, month");
  });

  test("as a report column: truncated to the grain, UTC; a comma sets it off after @via", async () => {
    const root = await load();
    expect(describeDimensionColumn(member(root, "dimension", "issuedOn"), "month"))
      .toBe("`Invoice.issuedOn` truncated to month, UTC");
    expect(describeDimensionColumn(member(root, "dimension", "customerJoinedAt"), "month"))
      .toBe("`Customer.joinedAt` via `Invoice.customer`, truncated to month, UTC");
    // No grain (an attribute dimension): the column alone.
    expect(describeDimensionColumn(member(root, "dimension", "region"))).toBe("`Customer.region` via `Invoice.customer`");
  });
});

describe("describing a measure, a segment and a row scope", () => {
  test("an aggregate: plain, distinct over a tuple, by segment, by filter, by both", async () => {
    const root = await load();
    const m = (name: string): string => describeMeasure(member(root, "measure", name));
    expect(m("invoices")).toBe("count of `Invoice.id`");
    expect(m("customers")).toBe("count of distinct (`Invoice.customerId`, `Invoice.status`)");
    expect(m("paidInvoices")).toBe("count of `Invoice.id` where segment `paid`");
    // A filter prints in the canonical form the loader holds (a bare value is `eq`).
    expect(m("liveCents")).toBe('sum of `Invoice.amountCents` where filter `{"voided":{"eq":false}}`');
    expect(m("paidLiveCents")).toBe('sum of `Invoice.amountCents` where segment `paid` and filter `{"voided":{"eq":false}}`');
  });

  test("a ratio names both sides and its null rule", async () => {
    const root = await load();
    expect(describeMeasure(member(root, "measure", "paidShare")))
      .toBe("`paidInvoices` / `invoices`, null when the denominator is 0");
  });

  test("a segment is its filter", async () => {
    const root = await load();
    expect(describeSegment(member(root, "segment", "paid"))).toBe('`{"status":{"eq":"paid"}}`');
  });

  test("a row scope: segment, filter, both, neither", () => {
    expect(describeRowScope("paid", undefined)).toBe("segment `paid`");
    expect(describeRowScope(undefined, { a: 1 })).toBe('filter `{"a":1}`');
    expect(describeRowScope("paid", { a: 1 })).toBe('segment `paid` and filter `{"a":1}`');
    expect(describeRowScope(undefined, undefined)).toBeUndefined();
    expect(describeRowScope("", null)).toBeUndefined();
  });

  test("a backtick in a value cannot break out of the code span", () => {
    expect(describeFilter({ note: "a`b" })).toBe('`{"note":"ab"}`');
  });
});

describe("describing a report's columns", () => {
  test("each derived field is described from its dimension or measure, with its type", async () => {
    const root = await load();
    const rows = reportShape(object(root, "ByMonth"), root).fields
      .map((f) => [f.name, reportFieldTypeName(f), describeReportField(f)]);
    expect(rows).toEqual([
      ["issuedOnMonth", "date", "`Invoice.issuedOn` truncated to month, UTC"],
      ["customerJoinedAtMonth", "date", "`Customer.joinedAt` via `Invoice.customer`, truncated to month, UTC"],
      ["region", "string", "`Customer.region` via `Invoice.customer`"],
      ["tags", "string[]", "`Invoice.tags`"],
      ["invoices", "long", "count of `Invoice.id`"],
      ["paidShare", "decimal", "`paidInvoices` / `invoices`, null when the denominator is 0"],
    ]);
  });
});

describe("describing a measure @default and a report @spine", () => {
  test("a defaulted aggregate keeps its sentence and ends with the declared integer", async () => {
    const root = await load();
    expect(describeMeasure(member(root, "measure", "liveCentsOrZero")))
      .toBe('sum of `Invoice.amountCents` where filter `{"voided":{"eq":false}}`; `0` when there is nothing to aggregate');
  });

  test("a defaulted ratio is never null, so its null rule gives way to the default", async () => {
    const root = await load();
    expect(describeMeasure(member(root, "measure", "paidShareOrNone")))
      .toBe("`paidInvoices` / `invoices`; `-1` when there is nothing to aggregate");
  });

  test("a report with @spine: its rows come from the spine entity, and its row scope aggregates only", async () => {
    const root = await load();
    const report = object(root, "PaidByRegion");
    expect(describeReportRows(reportShape(report, root), root)).toBe(
      "one row per distinct dimension tuple among the rows of `Customer`, reached by `Invoice.customer`, " +
        "including those no `Invoice` refers to",
    );
    expect(describeReportRowScope(report)).toBe("aggregating only segment `paid`");
    // The column table describes a defaulted measure as the entity's page does.
    const column = reportShape(report, root).fields.find((f) => f.name === "liveCentsOrZero")!;
    expect(describeReportField(column)).toBe(describeMeasure(member(root, "measure", "liveCentsOrZero")));
  });

  test("a @spine report with no row scope has none to describe", async () => {
    const root = await load();
    const report = object(root, "CustomerRoster");
    expect(describeReportRows(reportShape(report, root), root)).toContain("among the rows of `Customer`");
    expect(describeReportRowScope(report)).toBeUndefined();
  });

  test("a report without @spine: no rows sentence, and the row scope reads as it always did", async () => {
    const root = await load();
    expect(describeReportRows(reportShape(object(root, "ByMonth"), root), root)).toBeUndefined();
    expect(describeReportRows(reportShape(object(root, "PaidTotals"), root), root)).toBeUndefined();
    expect(describeReportRowScope(object(root, "PaidTotals"))).toBe("segment `paid`");
    expect(describeReportRowScope(object(root, "ByMonth"))).toBeUndefined();
  });
});

describe("why a report is not served (Plan 3 Table A)", () => {
  test("a view-backed report is served", async () => {
    const root = await load();
    expect(reportNotServedReason(object(root, "ByMonth"))).toBeUndefined();
  });

  test("no source, a source that is not a view, and an abstract report each say why", async () => {
    const root = await load();
    expect(reportNotServedReason(object(root, "Sourceless"))).toBe("Not served: declares no view source");
    expect(reportNotServedReason(object(root, "Materialized")))
      .toBe("Not served: its source is a materializedView, not a view");
    // Abstract wins over the source it declares.
    expect(reportNotServedReason(object(root, "AbstractReport"))).toBe("Not served: the report is abstract");
  });
});

describe("the attrs a describer reads", () => {
  test("per node kind, and nothing for any other node", async () => {
    const root = await load();
    expect(reportingDescribedAttrs(member(root, "dimension", "status"))).toEqual(["of", "via"]);
    expect(reportingDescribedAttrs(member(root, "dimension", "issuedOn"))).toEqual(["of", "via", "grains"]);
    expect(reportingDescribedAttrs(member(root, "measure", "invoices"))).toEqual(["agg", "of", "distinct", "segment", "filter", "default"]);
    expect(reportingDescribedAttrs(member(root, "measure", "paidShare"))).toEqual(["numerator", "denominator", "default"]);
    expect(reportingDescribedAttrs(member(root, "segment", "paid"))).toEqual(["filter"]);
    expect(reportingDescribedAttrs(object(root, "Invoice"))).toEqual([]);
  });

  test("every attr the vocabulary lets an author set on these nodes is one a describer reads", async () => {
    // If a new reporting attr is registered and no describer prints it, this fails here
    // rather than surfacing as a silent gap on a docs page.
    const root = await load();
    for (const node of object(root, "Invoice").children()) {
      const described = reportingDescribedAttrs(node);
      if (described.length === 0) continue;
      // ADR-0039: own — the assertion is about what THIS node declares.
      for (const [name] of node.ownAttrs()) expect({ node: node.name, name, read: described.includes(name) }).toEqual({ node: node.name, name, read: true });
    }
  });
});
