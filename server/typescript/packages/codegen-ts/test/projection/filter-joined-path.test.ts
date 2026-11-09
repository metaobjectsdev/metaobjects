// Phase 5, bug G7 (joined half): a projection @filter key may be a PATH of to-one hops from the
// base entity, then a field of the entity reached (`caseId.status`). The view joins along the
// path and filters on the reached column without outputting it. A to-many hop is refused.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const model = (filter: unknown, extraField?: unknown) => ({
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Program", children: [
        { "source.rdb": { "@table": "programs" } },
        { "field.long": { name: "id" } },
        { "field.boolean": { name: "active" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.entity": { name: "Case", children: [
        { "source.rdb": { "@table": "cases" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "status" } },
        { "field.long": { name: "programId", "@required": true } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "programId", "@fields": "programId", "@references": "Program" } },
        { "relationship.composition": { name: "tasks", "@objectRef": "Task", "@cardinality": "many" } },
      ] } },
      { "object.entity": { name: "Task", children: [
        { "source.rdb": { "@table": "tasks" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "title" } },
        { "field.long": { name: "caseId" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "caseId", "@fields": "caseId", "@references": "Case" } },
      ] } },
      { "object.projection": { name: "OpenTasks", "@filter": filter, children: [
        { "source.rdb": { "@kind": "view", "@table": "v_open_tasks" } },
        { "field.long": { name: "id", extends: "Task.id" } },
        { "field.string": { name: "title", extends: "Task.title" } },
        ...(extraField !== undefined ? [extraField] : []),
        { "identity.primary": { name: "id", extends: "Task.id" } },
      ] } },
    ],
  },
});

async function load(filter: unknown, extraField?: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model(filter, extraField)))]);
}

describe("G7 — a view @filter on a joined field the view does not output", () => {
  test("one hop: joins the reference and filters on its column", async () => {
    const { root, errors } = await load({ "caseId.status": "open" });
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("LEFT OUTER JOIN public.cases c ON c.id = t.case_id");
    expect(v!.sql).toContain("WHERE c.status = 'open'");
    expect(v!.sql).not.toContain("AS status");
  });

  test("two hops, sharing the join an origin already walks", async () => {
    const { root, errors } = await load(
      { "caseId.programId.active": true },
      { "field.string": { name: "caseStatus", children: [{ "origin.passthrough": { "@from": "Case.status", "@via": "Task.caseId" } }] } },
    );
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql.match(/JOIN public\.cases/g)?.length).toBe(1);
    expect(v!.sql).toContain("JOIN public.programs p ON p.id = c.program_id");
    expect(v!.sql).toContain("WHERE p.active = TRUE");
  });

  test("a to-many hop is refused", async () => {
    const { errors } = await load({ "caseId.tasks.title": "x" });
    expect(errors.map((e) => (e as { code?: string }).code)).toEqual(["ERR_BAD_ATTR_FILTER"]);
    expect(String((errors[0] as Error).message)).toContain("to-many");
  });

  test("a field the reached entity does not declare is refused", async () => {
    const { errors } = await load({ "caseId.nope": "x" });
    expect(errors.map((e) => (e as { code?: string }).code)).toEqual(["ERR_BAD_ATTR_FILTER"]);
  });
});
