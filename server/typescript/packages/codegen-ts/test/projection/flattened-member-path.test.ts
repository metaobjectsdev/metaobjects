// Phase 5, bug G6: an origin @from may name a member of a FLATTENED value object
// (`Plan.address.city`), whose column lives on the owning table under the embedding field's
// prefix (`address_city`; `@flattenedColumnPrefix: ""` gives the bare member column). The
// loader refused the path ("no such field") and codegen could not lower it.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const model = (from: string) => ({
  "metadata.root": {
    package: "acme",
    children: [
      { "object.value": { name: "Address", children: [{ "field.string": { name: "city" } }] } },
      { "object.value": { name: "ReferenceIds", children: [{ "field.string": { name: "externalReferenceId" } }] } },
      {
        "object.entity": {
          name: "Plan",
          children: [
            { "source.rdb": { "@table": "plans" } },
            { "field.long": { name: "id" } },
            { "field.object": { name: "address", "@objectRef": "Address", "@storage": "flattened" } },
            { "field.object": { name: "referenceIds", "@objectRef": "ReferenceIds", "@storage": "flattened", "@flattenedColumnPrefix": "" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "PlanExtract",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_plan_extract" } },
            { "field.long": { name: "id", extends: "Plan.id" } },
            { "field.string": { name: "picked", children: [{ "origin.passthrough": { "@from": from } }] } },
            { "identity.primary": { name: "id", extends: "Plan.id" } },
          ],
        },
      },
    ],
  },
});

async function load(from: string) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model(from)))]);
}

describe("G6 — a passthrough from a flattened value-object member", () => {
  test("Plan.address.city reads the prefixed column of the owning table", async () => {
    const { root, errors } = await load("Plan.address.city");
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("p.address_city AS picked");
  });

  test("an empty @flattenedColumnPrefix reads the bare member column", async () => {
    const { root, errors } = await load("Plan.referenceIds.externalReferenceId");
    expect(errors).toEqual([]);
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("p.external_reference_id AS picked");
  });

  test("a member the value object does not declare is refused", async () => {
    const { errors } = await load("Plan.address.zip");
    expect(errors.map((e) => (e as { code?: string }).code)).toEqual(["ERR_INVALID_ORIGIN"]);
  });
});
