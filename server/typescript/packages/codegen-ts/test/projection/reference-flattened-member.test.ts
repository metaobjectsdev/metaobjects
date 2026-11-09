// Phase 5, bug G6 (reference half): an identity.reference whose @fields names a member of a
// FLATTENED value object (`address.countryId`). The member's column lives on the owning table
// under the embedding's prefix (`address_country_id`), so a @via hop over the reference must
// join on that column, and `meta migrate` must put the foreign key on it.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "@metaobjectsdev/migrate-ts/expected";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const model = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Country",
          children: [
            { "source.rdb": { "@table": "countries" } },
            { "field.long": { name: "id" } },
            { "field.string": { name: "name" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
          ],
        },
      },
      {
        "object.value": {
          name: "Address",
          children: [{ "field.string": { name: "city" } }, { "field.long": { name: "countryId" } }],
        },
      },
      {
        "object.entity": {
          name: "Plan",
          children: [
            { "source.rdb": { "@table": "plans" } },
            { "field.long": { name: "id" } },
            { "field.object": { name: "address", "@objectRef": "Address", "@storage": "flattened" } },
            { "identity.primary": { name: "id", "@fields": "id" } },
            { "identity.reference": { name: "countryId", "@fields": "address.countryId", "@references": "Country" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "PlanExtract",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_plan_extract" } },
            { "field.long": { name: "id", extends: "Plan.id" } },
            {
              "field.string": {
                name: "countryName",
                children: [{ "origin.passthrough": { "@from": "Country.name", "@via": "Plan.countryId" } }],
              },
            },
            { "identity.primary": { name: "id", extends: "Plan.id" } },
          ],
        },
      },
    ],
  },
};

async function load() {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(model))]);
}

describe("G6 — an identity.reference over a flattened value-object member", () => {
  test("loads", async () => {
    const { errors } = await load();
    expect(errors).toEqual([]);
  });

  test("a @via hop over it joins on the member's prefixed column", async () => {
    const { root } = await load();
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.sql).toContain("public.countries c ON c.id = p.address_country_id");
  });

  test("meta migrate puts the foreign key on the member's column", async () => {
    const { root } = await load();
    const plans = buildExpectedSchema(root).tables.find((t) => t.name === "plans")!;
    expect(plans.foreignKeys.map((fk) => [fk.columns, fk.refTable, fk.refColumns])).toEqual([
      [["address_country_id"], "countries", ["id"]],
    ]);
  });
});
