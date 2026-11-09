// Phase 5, bug G7: a projection @filter may name a field of the BASE entity the view does not
// output (`deleted: false` with no `deleted` column in the view). The loader refused it ("not a
// declared field of the projection"). A projection field of the same name still wins.

import { describe, test, expect } from "bun:test";
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
    expect(errors.map((e) => e.code)).toEqual(["ERR_BAD_ATTR_FILTER"]);
  });
});
