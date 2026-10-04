// FR-044: ObjectManager reads a view-backed `object.report`.
//
// A report has no field children: its read shape is DERIVED (Table B). The runtime
// reads it through a detached read model built by `reportReadModel`, so the query
// builder and the type coercer see ordinary fields. These tests pin the contract:
// list + count work, filter and sort work on any derived field, by-id and every
// write are refused, a sourceless report is not served, and the loaded model is
// never touched.

import { describe, test, expect } from "bun:test";
import { join, resolve } from "node:path";
import {
  MetaDataLoader,
  InMemoryStringSource,
  canonicalSerialize,
  isMetaRoot,
  reportReadModel,
} from "@metaobjectsdev/metadata";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { ObjectManager } from "../src/object-manager.js";
import { inMemoryDriver } from "../src/drivers/in-memory-driver.js";
import { MetadataError } from "../src/errors.js";
import { buildSelectSpec } from "../src/query-builder.js";
import type { Row } from "../src/persistence-driver.js";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const CANONICAL = join(REPO_ROOT, "fixtures", "persistence-conformance", "canonical", "meta.fitness.json");

async function loadCanonical(): Promise<MetaRoot> {
  const result = await new MetaDataLoader().load([new FileSource(CANONICAL)]);
  expect(result.errors).toEqual([]);
  if (!isMetaRoot(result.root)) throw new Error("not a root");
  return result.root;
}

// The view's columns, under the default snake_case strategy applied to the DERIVED names.
const PROGRAM_MINUTES_ROWS: Row[] = [
  { program: 1, program_title: "Alpha", weeks: 3, long_weeks: 1, labels: 3, slots: 3,
    total_minutes: 150, avg_minutes: "50.0000", min_minutes: 30, max_minutes: 75, long_share: "0.3333" },
  { program: 2, program_title: "Bravo", weeks: 2, long_weeks: 2, labels: 2, slots: 2,
    total_minutes: 140, avg_minutes: "70.0000", min_minutes: 60, max_minutes: 80, long_share: "1.0000" },
  { program: 3, program_title: "Charlie", weeks: 1, long_weeks: 0, labels: 1, slots: 1,
    total_minutes: 20, avg_minutes: "20.0000", min_minutes: 20, max_minutes: 20, long_share: "0.0000" },
];

async function canonicalOm(): Promise<{ om: ObjectManager; root: MetaRoot }> {
  const root = await loadCanonical();
  const driver = inMemoryDriver({
    seed: { v_program_minutes: PROGRAM_MINUTES_ROWS },
    pkFields: { v_program_minutes: ["program"] },
  });
  return { om: new ObjectManager({ metadata: root, driver }), root };
}

// An inline model for the cases the canonical corpus does not carry: an int-backed enum
// dimension (the derived field must carry @values + @intValueMap from its type source),
// an @unmanaged view, an @sql view, and a sourceless report.
const SALES = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Sale", children: [
        { "source.rdb": { "@table": "sales" } },
        { "field.long": { name: "id" } },
        { "field.enum": { name: "status", "@required": true, "@values": ["OPEN", "CLOSED"],
          "@intValueMap": { OPEN: 1, CLOSED: 2 } } },
        { "field.currency": { name: "amountCents", "@required": true, "@currency": "EUR" } },
        { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
        { "dimension.attribute": { name: "status", "@of": "Sale.status" } },
        { "measure.aggregate": { name: "sales", "@agg": "count", "@of": "Sale.id" } },
        { "measure.aggregate": { name: "revenue", "@agg": "sum", "@of": "Sale.amountCents" } },
      ] } },
      { "object.report": { name: "SalesByStatus", "@from": "Sale", "@dimensions": ["status"],
        "@measures": ["sales", "revenue"], children: [
          { "source.rdb": { "@kind": "view", "@view": "v_sales_by_status" } },
        ] } },
      { "object.report": { name: "UnmanagedSales", "@from": "Sale", "@dimensions": ["status"],
        "@measures": ["sales"], children: [
          { "source.rdb": { "@kind": "view", "@view": "v_unmanaged_sales", "@unmanaged": true } },
        ] } },
      { "object.report": { name: "AuthoredSales", "@from": "Sale", "@measures": ["sales"], children: [
        { "source.rdb": { "@kind": "view", "@view": "v_authored_sales",
          "@sql": "SELECT COUNT(id) AS sales FROM sales" } },
      ] } },
      // Loads clean: a report may declare a replica read-only source beside its primary view.
      { "object.report": { name: "ReplicatedSales", "@from": "Sale", "@measures": ["sales"], children: [
        { "source.rdb": { name: "rep", "@kind": "view", "@view": "v_replicated_sales_replica", "@role": "replica" } },
        { "source.rdb": { name: "pri", "@kind": "view", "@view": "v_replicated_sales", "@role": "primary" } },
      ] } },
      { "object.report": { name: "InertSales", "@from": "Sale", "@measures": ["sales"] } },
    ],
  },
};

async function salesOm(): Promise<{ om: ObjectManager; root: MetaRoot }> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(SALES))]);
  expect(result.errors.map((e) => e.message)).toEqual([]);
  if (!isMetaRoot(result.root)) throw new Error("not a root");
  const driver = inMemoryDriver({
    seed: {
      v_sales_by_status: [
        { status: 1, sales: 4, revenue: 4000 },
        { status: 2, sales: 6, revenue: 9000 },
      ],
      v_unmanaged_sales: [
        { status: 1, sales: 4 },
        { status: 2, sales: 6 },
      ],
      v_authored_sales: [{ sales: 10 }],
      v_replicated_sales: [{ sales: 10 }],
      // Decoys: the replica view, and the default table name a model with no primary
      // source would fall back to.
      v_replicated_sales_replica: [{ sales: 77 }],
      replicated_sales: [{ sales: 88 }],
      // A decoy: if a report read ever fell back to the entity-name default table
      // ("inert_sales") or to the @from table, these rows would surface.
      sales: [{ id: 1, status: 1, amount_cents: 1000 }],
      inert_sales: [{ sales: 99 }],
    },
    pkFields: {
      v_sales_by_status: ["status"], v_unmanaged_sales: ["status"],
      v_authored_sales: ["sales"], inert_sales: ["sales"],
      v_replicated_sales: ["sales"], v_replicated_sales_replica: ["sales"], replicated_sales: ["sales"],
    },
  });
  return { om: new ObjectManager({ metadata: result.root, driver }), root: result.root };
}

describe("ObjectManager reads a view-backed report (FR-044)", () => {
  test("findMany returns the view's rows keyed by derived field name", async () => {
    const { om } = await canonicalOm();
    const rows = await om.findMany("ProgramMinutes", undefined, { orderBy: ["program", "asc"] });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      program: 1, programTitle: "Alpha", weeks: 3, longWeeks: 1, labels: 3, slots: 3,
      totalMinutes: 150, avgMinutes: "50.0000", minMinutes: 30, maxMinutes: 75, longShare: "0.3333",
    });
  });

  test("count works with and without a filter", async () => {
    const { om } = await canonicalOm();
    expect(await om.count("ProgramMinutes")).toBe(3);
    expect(await om.count("ProgramMinutes", { totalMinutes: { $gte: 100 } })).toBe(2);
    expect(await om.count("ProgramMinutes", { programTitle: "Charlie" })).toBe(1);
  });

  test("filters on a dimension and on a measure", async () => {
    const { om } = await canonicalOm();
    const byDimension = await om.findMany("ProgramMinutes", { programTitle: { $like: "B%" } });
    expect(byDimension.map((r) => r.program)).toEqual([2]);
    const byMeasure = await om.findMany("ProgramMinutes", { minMinutes: { $lt: 60 } }, { orderBy: ["program", "asc"] });
    expect(byMeasure.map((r) => r.programTitle)).toEqual(["Alpha", "Charlie"]);
    const both = await om.findMany("ProgramMinutes", { $and: [{ weeks: { $gte: 2 } }, { longWeeks: { $gte: 2 } }] });
    expect(both.map((r) => r.programTitle)).toEqual(["Bravo"]);
  });

  test("sorts on a measure, with limit and offset", async () => {
    const { om } = await canonicalOm();
    const desc = await om.findMany("ProgramMinutes", undefined, { orderBy: ["totalMinutes", "desc"] });
    expect(desc.map((r) => r.programTitle)).toEqual(["Alpha", "Bravo", "Charlie"]);
    const page = await om.findMany("ProgramMinutes", undefined, {
      orderBy: ["maxMinutes", "asc"], limit: 1, offset: 1,
    });
    expect(page.map((r) => r.programTitle)).toEqual(["Alpha"]);
  });

  test("findFirst reads one row", async () => {
    const { om } = await canonicalOm();
    const row = await om.findFirst("ProgramMinutes", { program: 2 });
    expect(row?.programTitle).toBe("Bravo");
  });

  test("the literal naming strategy addresses the view by the derived names as written", async () => {
    const root = await loadCanonical();
    const driver = inMemoryDriver({
      seed: { v_fitness_totals: [{ weeks: 6, totalMinutes: 310, longShare: "0.5000" }] },
      pkFields: { v_fitness_totals: ["weeks"] },
    });
    const om = new ObjectManager({ metadata: root, driver, columnNamingStrategy: "literal" });
    expect(await om.findMany("FitnessTotals")).toEqual([{ weeks: 6, totalMinutes: 310, longShare: "0.5000" }]);
  });

  test("rows are coerced by derived subtype: an int-backed enum dimension reads and filters as its symbol", async () => {
    const { om } = await salesOm();
    const rows = await om.findMany("SalesByStatus", undefined, { orderBy: ["revenue", "desc"] });
    expect(rows).toEqual([
      { status: "CLOSED", sales: 6, revenue: 9000 },
      { status: "OPEN", sales: 4, revenue: 4000 },
    ]);
    expect(await om.findMany("SalesByStatus", { status: "OPEN" })).toEqual([{ status: "OPEN", sales: 4, revenue: 4000 }]);
    expect(await om.count("SalesByStatus", { status: { $in: ["OPEN", "CLOSED"] } })).toBe(2);
  });

  test("an @unmanaged report is served: findMany and count read its view", async () => {
    const { om } = await salesOm();
    const rows = await om.findMany("UnmanagedSales", undefined, { orderBy: ["sales", "asc"] });
    expect(rows).toEqual([{ status: "OPEN", sales: 4 }, { status: "CLOSED", sales: 6 }]);
    expect(await om.count("UnmanagedSales")).toBe(2);
    expect(await om.count("UnmanagedSales", { sales: { $gt: 4 } })).toBe(1);
  });

  test("an @sql report is served from its view", async () => {
    const { om } = await salesOm();
    expect(await om.findMany("AuthoredSales")).toEqual([{ sales: 10 }]);
    expect(await om.count("AuthoredSales")).toBe(1);
  });

  test("a replica read-only source declared before the primary view: reads come from the primary view", async () => {
    const { om } = await salesOm();
    expect(await om.findMany("ReplicatedSales")).toEqual([{ sales: 10 }]);
    expect(await om.count("ReplicatedSales")).toBe(1);
    expect(await om.count("ReplicatedSales", { sales: 10 })).toBe(1);
  });

  test("a report whose only read-only source has no explicit @role is read from it", async () => {
    // SalesByStatus, UnmanagedSales and AuthoredSales all declare no @role.
    const { om, root } = await salesOm();
    const report = root.objects().find((o) => o.name === "SalesByStatus")!;
    expect(buildSelectSpec(reportReadModel(report, root), undefined, {}).table).toBe("v_sales_by_status");
    expect(await om.count("SalesByStatus")).toBe(2);
  });

  test("the select spec: the view as the table, the derived columns in Table B order, no key column", async () => {
    const root = await loadCanonical();
    const report = root.objects().find((o) => o.name === "ProgramMinutes")!;
    const spec = buildSelectSpec(reportReadModel(report, root), undefined, {});
    expect(spec.table).toBe("v_program_minutes");
    expect(spec.columns).toEqual([
      "program", "program_title", "weeks", "long_weeks", "labels", "slots",
      "total_minutes", "avg_minutes", "min_minutes", "max_minutes", "long_share",
    ]);
    expect(spec.where).toBeUndefined();
    const literal = buildSelectSpec(reportReadModel(report, root), undefined, {}, undefined, "literal");
    expect(literal.columns).toEqual([
      "program", "programTitle", "weeks", "longWeeks", "labels", "slots",
      "totalMinutes", "avgMinutes", "minMinutes", "maxMinutes", "longShare",
    ]);
  });

  test("the declared report node, passed straight to buildSelectSpec, is refused by name", async () => {
    const root = await loadCanonical();
    const report = root.objects().find((o) => o.name === "ProgramMinutes")!;
    let err: unknown;
    try {
      buildSelectSpec(report, undefined, {});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MetadataError);
    expect((err as MetadataError).message).toContain("ProgramMinutes");
    expect((err as MetadataError).message).toContain("no fields");
  });

  test("a sourceless report is not served", async () => {
    const { om } = await salesOm();
    for (const read of [
      () => om.findMany("InertSales"),
      () => om.count("InertSales"),
      () => om.findFirst("InertSales", {}),
    ]) {
      const err = await read().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(MetadataError);
      expect((err as MetadataError).message).toContain("InertSales");
      expect((err as MetadataError).message).toContain("not served");
      expect((err as MetadataError).message).toContain("no view");
    }
  });

  test("by-id and every write on a report throw: read-only, no identity", async () => {
    const { om } = await canonicalOm();
    const attempts: Array<[string, () => unknown]> = [
      ["findById", () => om.findById("ProgramMinutes", 1)],
      ["create", () => om.create("ProgramMinutes", { program: 9 })],
      ["update", () => om.update("ProgramMinutes", 1, { weeks: 9 })],
      ["delete", () => om.delete("ProgramMinutes", 1)],
      ["createMany", () => om.createMany("ProgramMinutes", [{ program: 9 }])],
      ["updateMany", () => om.updateMany("ProgramMinutes", { program: 1 }, { weeks: 9 })],
      ["deleteMany", () => om.deleteMany("ProgramMinutes", { program: 1 })],
      ["load", () => om.load("ProgramMinutes:1")],
      ["refOf", () => om.refOf("ProgramMinutes", { program: 1 })],
    ];
    for (const [op, attempt] of attempts) {
      let err: unknown;
      try {
        await attempt();
      } catch (e) {
        err = e;
      }
      expect(err, op).toBeInstanceOf(MetadataError);
      const message = (err as MetadataError).message;
      expect(message, op).toContain("ProgramMinutes");
      expect(message, op).toContain("read-only");
      expect(message, op).toContain("no identity");
      expect(message, op).toContain(op);
      expect((err as MetadataError).entity, op).toBe("ProgramMinutes");
    }
    // Nothing was written.
    expect(await om.count("ProgramMinutes")).toBe(3);
  });

  test("a write on a sourceless report is refused as read-only, not as unserved", async () => {
    const { om } = await salesOm();
    const err = await om.create("InertSales", { sales: 1 }).then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(MetadataError);
    expect((err as MetadataError).message).toContain("read-only");
  });

  test("an unknown field in a report filter or sort is refused by name", async () => {
    const { om } = await canonicalOm();
    // `durationMinutes` is a Week field, not a derived field of the report.
    await expect(om.findMany("ProgramMinutes", { durationMinutes: 60 })).rejects.toThrow(
      "Unknown field 'durationMinutes' on entity 'ProgramMinutes'",
    );
    await expect(om.findMany("ProgramMinutes", undefined, { orderBy: ["title", "asc"] })).rejects.toThrow(
      "Unknown field 'title'",
    );
  });

  test("reading reports leaves the loaded model untouched", async () => {
    const { om, root } = await canonicalOm();
    const before = canonicalSerialize(root);
    const objects = root.objects().length;
    await om.findMany("ProgramMinutes", { weeks: { $gte: 1 } }, { orderBy: ["weeks", "desc"] });
    await om.count("FitnessTotals");
    await om.findMany("ProgramsByMonth");
    await om.findMany("AssetActivity");
    expect(root.objects().length).toBe(objects);
    expect(canonicalSerialize(root)).toBe(before);
  });

  test("the runtime reads through the cached read model", async () => {
    const { om, root } = await canonicalOm();
    const report = root.objects().find((o) => o.name === "ProgramMinutes")!;
    const model = reportReadModel(report, root);
    await om.findMany("ProgramMinutes");
    expect(reportReadModel(report, root)).toBe(model);
  });

  test("entities in the same model are read and written as before", async () => {
    const { om } = await salesOm();
    expect(await om.count("Sale")).toBe(1);
    const created = await om.create("Sale", { status: "CLOSED", amountCents: 2500 });
    expect(created.status).toBe("CLOSED");
    expect((await om.findById("Sale", created.id))?.amountCents).toBe(2500);
    expect(await om.count("Sale")).toBe(2);
  });
});
