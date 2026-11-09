// rc.19 fix round, C1: a projection that extends a FILTERED projection keeps the base's row scope.
// Codegen read only the extender's own @filter, so a gated base (a consent or HIPAA gate) became
// an ungated view in the extender, with no error. The effective filter is every level's @filter,
// supers first, ANDed — through any depth of inheritance.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const plan = { "object.entity": { name: "Plan", children: [
  { "source.rdb": { "@table": "plans" } },
  { "field.long": { name: "id" } },
  { "field.string": { name: "name" } },
  { "field.string": { name: "code" } },
  { "field.boolean": { name: "consented" } },
  { "field.boolean": { name: "deleted" } },
  { "field.int": { name: "tier" } },
  { "identity.primary": { name: "id", "@fields": "id" } },
] } };

const gated = (filter: unknown) => ({ "object.projection": { name: "GatedPlans", abstract: true,
  ...(filter !== undefined ? { "@filter": filter } : {}), children: [
    { "field.long": { name: "planId", extends: "Plan.id" } },
    { "field.string": { name: "label", children: [{ "origin.passthrough": { "@from": "Plan.name" } }] } },
    { "identity.primary": { name: "id", extends: "Plan.id" } },
  ] } });

const middle = (filter: unknown) => ({ "object.projection": { name: "LivePlans", abstract: true, extends: "GatedPlans",
  ...(filter !== undefined ? { "@filter": filter } : {}), children: [] } });

const leaf = (superName: string, filter: unknown) => ({ "object.projection": { name: "ExportPlans", extends: superName,
  ...(filter !== undefined ? { "@filter": filter } : {}), children: [
    { "source.rdb": { "@kind": "view", "@table": "v_export_plans" } },
    { "field.string": { name: "code", children: [{ "origin.passthrough": { "@from": "Plan.code" } }] } },
  ] } });

async function sqlOf(projections: unknown[]) {
  const doc = { "metadata.root": { package: "acme", children: [plan, ...projections] } };
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  expect(errors).toEqual([]);
  const views = buildProjectionViews(root, { dialect: "postgres" });
  expect(views.map((v) => v.name)).toEqual(["v_export_plans"]);
  return views[0]!.sql;
}

describe("C1 — an extender keeps its base projection's @filter", () => {
  test("a gated base keeps its gate in an extender that declares no filter", async () => {
    const sql = await sqlOf([gated({ consented: true }), leaf("GatedPlans", undefined)]);
    expect(sql).toContain("WHERE p.consented = TRUE");
  });

  test("the extender's own filter is ANDed with the base's, base first", async () => {
    const sql = await sqlOf([gated({ consented: true }), leaf("GatedPlans", { deleted: false })]);
    expect(sql).toMatch(/WHERE \(p\.consented = TRUE AND p\.deleted = FALSE\)/);
  });

  test("every level of a deeper chain contributes, root-most first", async () => {
    const sql = await sqlOf([gated({ consented: true }), middle({ deleted: false }), leaf("LivePlans", { tier: { gte: 2 } })]);
    expect(sql).toMatch(/WHERE \(p\.consented = TRUE AND p\.deleted = FALSE AND p\.tier >= 2\)/);
  });

  test("a gate two levels up survives an unfiltered middle level", async () => {
    const sql = await sqlOf([gated({ consented: true }), middle(undefined), leaf("LivePlans", undefined)]);
    expect(sql).toContain("WHERE p.consented = TRUE");
  });

  test("an extender of an unfiltered base emits no WHERE (unchanged)", async () => {
    const sql = await sqlOf([gated(undefined), leaf("GatedPlans", undefined)]);
    expect(sql).not.toContain("WHERE");
  });
});
