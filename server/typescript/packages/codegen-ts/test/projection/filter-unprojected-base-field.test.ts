// Phase 5, bug G7: a projection @filter may name a field of the BASE entity the view does not
// output (`deleted: false` with no `deleted` column in the view). The loader refused it ("not a
// declared field of the projection"). A projection field of the same name still wins.

import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const model = (filter: unknown) => ({
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Task", children: [
        { "source.rdb": { "@table": "tasks" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "title" } },
        { "field.boolean": { name: "deleted" } },
        { "field.enum": { name: "kind", "@values": ["A", "B"], "@intValueMap": { A: 1, B: 2 } } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.projection": { name: "LiveTasks", "@filter": filter, children: [
        { "source.rdb": { "@kind": "view", "@table": "v_live_tasks" } },
        { "field.long": { name: "id", extends: "Task.id" } },
        { "field.string": { name: "title", extends: "Task.title" } },
        { "identity.primary": { name: "id", extends: "Task.id" } },
      ] } },
    ],
  },
});

async function load(filter: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model(filter)))]);
}

describe("G7 — a view @filter on a base field the view does not output", () => {
  test("loads and lowers to a WHERE on the base column", async () => {
    const { root, errors } = await load({ deleted: false, kind: "B" });
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("WHERE (t.deleted = FALSE AND t.kind = 2)");
    expect(v!.sql).not.toContain("AS deleted");
  });

  test("a name neither the projection nor its base declares is still refused", async () => {
    const { errors } = await load({ archived: false });
    expect(errors.map((e) => (e as { code?: string }).code)).toEqual(["ERR_BAD_ATTR_FILTER"]);
  });

  // rc.19 fix round, I1: the fallback reached EVERY unprojected base field eagerly, inlining each
  // derived one — so a base entity with a derived passthrough (which a view cannot inline) made
  // any @filter fail codegen, even one that never named it. Only the named keys are reached.
  test("a base entity's derived passthrough the filter never names does not fail codegen", async () => {
    const fixture = join(import.meta.dir, "../../../../../../fixtures/conformance/entity-derived-fields-multi-source/input/meta.demo.json");
    const doc = JSON.parse(readFileSync(fixture, "utf8"));
    doc["metadata.root"].children.push({ "object.projection": { name: "NamedCustomers", "@filter": { name: { isNull: false } }, children: [
      { "source.rdb": { "@kind": "view", "@view": "v_named_customers" } },
      { "field.uuid": { name: "id", extends: "demo::Customer.id" } },
      { "identity.primary": { name: "id", extends: "demo::Customer.id" } },
    ] } });
    const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
    expect(errors).toEqual([]);
    const view = buildProjectionViews(root, { dialect: "postgres" }).find((v) => v.name === "v_named_customers");
    expect(view!.sql).toContain("WHERE c.name IS NOT NULL");
  });
});
