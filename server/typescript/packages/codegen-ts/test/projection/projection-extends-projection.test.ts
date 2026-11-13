// A projection that extends another projection assembles its effective fields and origins
// (base first) into its view.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const base = (abstract: boolean) => ({ "object.projection": { name: "PlanExtract", abstract, children: [
  ...(abstract ? [] : [{ "source.rdb": { "@kind": "view", "@table": "v_plan_extract" } }]),
  { "field.long": { name: "planId", extends: "Plan.id" } },
  { "field.string": { name: "label", children: [{ "origin.passthrough": { "@from": "Plan.name" } }] } },
  { "field.int": { name: "weekCount", children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Plan.weeks" } }] } },
  { "identity.primary": { name: "id", extends: "Plan.id" } },
] } });

const extender = (ownSource: boolean) => ({ "object.projection": { name: "DataAggregationPlans", extends: "PlanExtract", children: [
  ...(ownSource ? [{ "source.rdb": { "@kind": "view", "@table": "v_da_plans", "@schema": "data_aggregation" } }] : []),
  { "field.string": { name: "code", children: [{ "origin.passthrough": { "@from": "Plan.code" } }] } },
] } });

const model = (projections: unknown[]) => ({ "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Plan", children: [
    { "source.rdb": { "@table": "plans" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name" } },
    { "field.string": { name: "code" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "Week", children: [
    { "source.rdb": { "@table": "weeks" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "planId" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "plan", "@fields": "planId", "@references": "Plan" } },
  ] } },
  ...projections,
] } });

async function load(projections: unknown[]) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model(projections)))]);
}

describe("a projection extending a projection", () => {
  test("the extender's view carries the inherited fields and origins, base first", async () => {
    const { root, errors } = await load([base(true), extender(true)]);
    expect(errors).toEqual([]);
    const views = buildProjectionViews(root, { dialect: "postgres" });
    expect(views.map((v) => v.name)).toEqual(["v_da_plans"]);
    const sql = views[0]!.sql;
    expect(sql).toMatch(/p\.id AS plan_id,\s+p\.name AS label,\s+COUNT\(DISTINCT w\.id\) AS week_count,\s+p\.code AS code/);
    expect(sql).toContain("LEFT OUTER JOIN weeks w ON w.plan_id = p.id");
  });

  test("a concrete base keeps its own view beside the extender's", async () => {
    const { root, errors } = await load([base(false), extender(true)]);
    expect(errors).toEqual([]);
    expect(buildProjectionViews(root, { dialect: "postgres" }).map((v) => v.name).sort()).toEqual(["v_da_plans", "v_plan_extract"]);
  });

  test("an extender without its own source is refused, never emitted under the base's name", async () => {
    const { errors } = await load([base(false), extender(false)]);
    expect(errors.map((e) => String(e.message)).join("\n")).toMatch(/DataAggregationPlans' inherits a source/);
  });
});
