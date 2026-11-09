// rc.19 Phase 6 Tier 2 view vocabulary (R58), one block per item: computed-over-joined, case,
// now (as an expression leaf and in a projection @filter), correlated-filter and origin-segment
// on an aggregate. entity-derived is pinned end to end in hipaa-gate-entity-derived.test.ts.

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const ENTITIES = [
  { "object.entity": { name: "Status", children: [
    { "source.rdb": { "@table": "statuses" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name" } },
    { "field.string": { name: "displayName" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "Case", children: [
    { "source.rdb": { "@table": "cases" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "statusId" } },
    { "field.int": { name: "priorType" } },
    { "field.int": { name: "cumulativeStatus" } },
    { "field.int": { name: "status" } },
    { "field.date": { name: "effectiveFrom" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "statusId", "@fields": "statusId", "@references": "Status" } },
  ] } },
  { "object.entity": { name: "CaseHistory", "@collectionName": "CaseHistory", children: [
    { "source.rdb": { "@table": "case_history" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "caseId", "@required": true } },
    { "field.long": { name: "statusId" } },
    { "field.timestamp": { name: "createdDate" } },
    { "field.boolean": { name: "active" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "caseId", "@fields": "caseId", "@references": "Case" } },
    { "segment.filter": { name: "live", "@filter": { active: true } } },
  ] } },
];

const view = (name: string, fields: unknown[], extra: Record<string, unknown> = {}) => ({
  "object.projection": { name, ...extra, children: [
    { "source.rdb": { "@kind": "view", "@table": `v_${name.toLowerCase()}` } },
    { "field.long": { name: "id", extends: "Case.id" } },
    ...fields,
    { "identity.primary": { name: "id", extends: "Case.id" } },
  ] },
});

async function sqlOf(projection: unknown, dialect: "postgres" | "sqlite" = "postgres"): Promise<string> {
  const doc = { "metadata.root": { package: "acme", children: [...ENTITIES, projection] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors).toEqual([]);
  return buildProjectionViews(root, { dialect })[0]!.sql;
}

async function errorsOf(projection: unknown): Promise<string[]> {
  const doc = { "metadata.root": { package: "acme", children: [...ENTITIES, projection] } };
  const { errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  return errors.map((e) => `${(e as { code?: string }).code}: ${(e as Error).message}`);
}

const joinedName = { "field.string": { name: "statusName", children: [{ "origin.passthrough": { "@from": "Status.name", "@via": "Case.statusId" } }] } };
const joinedDisplay = { "field.string": { name: "statusDisplay", children: [{ "origin.passthrough": { "@from": "Status.displayName", "@via": "Case.statusId" } }] } };

describe("computed-over-joined — an expression reads other projection fields", () => {
  test("COALESCE over two joined passthroughs", async () => {
    const sql = await sqlOf(view("Labels", [joinedName, joinedDisplay,
      { "field.string": { name: "label", children: [{ "origin.computed": { "@expr": { fn: "coalesce", args: [{ field: "statusDisplay" }, { field: "statusName" }] } } }] } },
    ]));
    expect(sql).toContain("COALESCE(s.display_name, s.name) AS label");
  });

  test("an expression over another computed field inlines it; a cycle is refused", async () => {
    const sql = await sqlOf(view("Chain", [joinedName,
      { "field.boolean": { name: "named", children: [{ "origin.computed": { "@expr": { op: "isNotNull", arg: { field: "statusName" } } } }] } },
      { "field.boolean": { name: "unnamed", children: [{ "origin.computed": { "@expr": { op: "not", arg: { field: "named" } } } }] } },
    ]));
    expect(sql).toContain("NOT (s.name IS NOT NULL) AS unnamed");
  });

  test("an aggregate is not readable from an expression", async () => {
    const errors = await errorsOf(view("Agg", [
      { "field.long": { name: "entries", children: [{ "origin.aggregate": { "@agg": "count", "@of": "CaseHistory.id", "@via": "Case.caseHistory" } }] } },
      { "field.boolean": { name: "busy", children: [{ "origin.computed": { "@expr": { op: "gt", left: { field: "entries" }, right: { value: 3 } } } }] } },
    ]));
    expect(errors.some((e) => e.includes("entries"))).toBe(true);
  });
});

describe("case — searched and simple CASE in an expression", () => {
  test("searched: CASE WHEN cumulativeStatus = 0 THEN status ELSE cumulativeStatus END", async () => {
    const sql = await sqlOf(view("Outcome", [
      { "field.int": { name: "outcome", children: [{ "origin.computed": { "@expr": {
        case: [{ when: { op: "eq", left: { field: "cumulativeStatus" }, right: { value: 0 } }, then: { field: "status" } }],
        else: { field: "cumulativeStatus" },
      } } }] } },
    ]));
    expect(sql).toContain("(CASE WHEN c.cumulative_status = 0 THEN c.status ELSE c.cumulative_status END) AS outcome");
  });

  test("simple: CASE priorType WHEN 1 THEN 'Medical' WHEN 2 THEN 'Pharmacy' END, and it runs", async () => {
    const projection = view("Benefit", [
      { "field.string": { name: "benefitTypeName", children: [{ "origin.computed": { "@expr": {
        operand: { field: "priorType" },
        case: [{ when: { value: 1 }, then: { value: "Medical" } }, { when: { value: 2 }, then: { value: "Pharmacy" } }],
      } } }] } },
    ]);
    expect(await sqlOf(projection)).toContain("(CASE c.prior_type WHEN 1 THEN 'Medical' WHEN 2 THEN 'Pharmacy' END) AS benefit_type_name");
    const db = new Database(":memory:");
    db.exec("CREATE TABLE cases (id INTEGER PRIMARY KEY, prior_type INTEGER); INSERT INTO cases VALUES (1, 1), (2, 2), (3, 0);");
    db.exec(`CREATE VIEW v AS ${await sqlOf(projection, "sqlite")}`);
    expect(db.query("SELECT id, benefit_type_name AS t FROM v ORDER BY id").all()).toEqual([
      { id: 1, t: "Medical" }, { id: 2, t: "Pharmacy" }, { id: 3, t: null },
    ]);
  });

  test("results of differing types are refused", async () => {
    const errors = await errorsOf(view("Bad", [
      { "field.string": { name: "x", children: [{ "origin.computed": { "@expr": {
        case: [{ when: { op: "eq", left: { field: "status" }, right: { value: 0 } }, then: { value: "a" } }], else: { value: 1 },
      } } }] } },
    ]));
    expect(errors.some((e) => e.includes("differing types"))).toBe(true);
  });
});

describe("now — as an expression leaf and in a projection @filter", () => {
  test("a leaf compared with a date field takes the date kind", async () => {
    const sql = await sqlOf(view("Active", [
      { "field.boolean": { name: "started", children: [{ "origin.computed": { "@expr": {
        op: "gte", left: { now: "P0D" }, right: { field: "effectiveFrom" },
      } } }] } },
    ]));
    expect(sql).toContain("CAST(((now() AT TIME ZONE 'UTC') + INTERVAL 'P0D') AS DATE) >= c.effective_from AS started");
  });

  test("a projection @filter takes a relative date", async () => {
    const sql = await sqlOf(view("Recent", [], { "@filter": { effectiveFrom: { gte: { now: "-P30D" } } } }));
    expect(sql).toContain("WHERE c.effective_from >= CAST(((now() AT TIME ZONE 'UTC') - INTERVAL 'P30D') AS DATE)");
  });
});

describe("correlated-filter — an origin @filter compares with the base row", () => {
  test("MIN(createdDate) of the histories in the case's own status", async () => {
    const sql = await sqlOf(view("Placed", [
      { "field.timestamp": { name: "statusPlaced", children: [{ "origin.aggregate": {
        "@agg": "min", "@of": "CaseHistory.createdDate", "@via": "Case.caseHistory",
        "@filter": { statusId: { eq: { field: "statusId" } } },
      } }] } },
    ]));
    expect(sql).toContain("MIN(c0.created_date) FILTER (WHERE c0.status_id = c.status_id) AS status_placed");
  });

  test("the null-safe comparison, in an origin.first subquery", async () => {
    const sql = await sqlOf(view("Other", [
      { "field.long": { name: "otherStatus", children: [{ "origin.first": {
        "@of": "CaseHistory.statusId", "@via": "Case.caseHistory", "@orderBy": ["statusId"],
        "@filter": { statusId: { isDistinctFrom: { field: "statusId" } } },
      } }] } },
    ]));
    expect(sql).toMatch(/WHERE (\w+)\.case_id = c\.id AND \1\.status_id IS DISTINCT FROM c\.status_id ORDER BY/);
    expect(await sqlOf(view("Other2", [
      { "field.long": { name: "otherStatus", children: [{ "origin.first": {
        "@of": "CaseHistory.statusId", "@via": "Case.caseHistory", "@orderBy": ["statusId"],
        "@filter": { statusId: { isDistinctFrom: { field: "statusId" } } },
      } }] } },
    ]), "sqlite")).toMatch(/\.status_id IS NOT c\.status_id/);
  });

  test("a base field the base row lacks, and a null-safe op without a field, are refused", async () => {
    const bad = await errorsOf(view("Bad", [
      { "field.timestamp": { name: "x", children: [{ "origin.aggregate": {
        "@agg": "min", "@of": "CaseHistory.createdDate", "@via": "Case.caseHistory",
        "@filter": { statusId: { eq: { field: "nope" } } },
      } }] } },
      { "field.timestamp": { name: "y", children: [{ "origin.aggregate": {
        "@agg": "min", "@of": "CaseHistory.createdDate", "@via": "Case.caseHistory",
        "@filter": { statusId: { isDistinctFrom: 3 } },
      } }] } },
    ]));
    expect(bad.filter((e) => e.startsWith("ERR_BAD_ATTR_FILTER")).length).toBe(2);
  });
});

describe("origin-segment — @segment on origin.aggregate and origin.first", () => {
  test("the related entity's segment scopes the aggregate, ANDed with @filter", async () => {
    const sql = await sqlOf(view("LiveCount", [
      { "field.long": { name: "live", children: [{ "origin.aggregate": {
        "@agg": "count", "@of": "CaseHistory.id", "@via": "Case.caseHistory", "@segment": "live",
        "@filter": { statusId: { eq: { field: "statusId" } } },
      } }] } },
    ]));
    expect(sql).toContain("COUNT(DISTINCT c0.id) FILTER (WHERE (c0.active = TRUE AND c0.status_id = c.status_id)) AS live");
  });

  test("a segment the related entity does not declare is refused", async () => {
    const errors = await errorsOf(view("NoSeg", [
      { "field.long": { name: "live", children: [{ "origin.aggregate": {
        "@agg": "count", "@of": "CaseHistory.id", "@via": "Case.caseHistory", "@segment": "dead",
      } }] } },
    ]));
    expect(errors.some((e) => e.startsWith("ERR_INVALID_ORIGIN") && e.includes('@segment "dead"'))).toBe(true);
  });
});
