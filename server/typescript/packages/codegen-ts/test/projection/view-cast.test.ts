// A view column whose declared type differs from what its expression yields carries the declared
// type's cast on Postgres: a bare NULL in a view is text, and an @convert passthrough reads the
// source column unconverted. The cast spells the type meta migrate gives the field's column.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      { "object.entity": { name: "Physician", children: [
        { "source.rdb": { "@table": "physicians" } },
        { "field.long": { name: "id" } },
        { "field.string": { name: "externalReferenceId", "@maxLength": 100 } },
        { "field.int": { name: "rank" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ] } },
      { "object.projection": { name: "PhysicianExtract", children: [
        { "source.rdb": { "@kind": "view", "@table": "v_physician_extract" } },
        { "field.long": { name: "id", extends: "Physician.id" } },
        { "field.int": { name: "locationType", children: [{ "origin.computed": { "@expr": { value: null } } }] } },
        { "field.string": { name: "territoryName", children: [{ "origin.computed": { "@expr": { value: null } } }] } },
        { "field.timestamp": { name: "removedAt", children: [{ "origin.computed": { "@expr": { value: null } } }] } },
        { "field.string": { name: "externalRef", children: [{ "origin.passthrough": { "@from": "Physician.externalReferenceId", "@convert": true } }] } },
        { "field.long": { name: "rankWide", children: [{ "origin.passthrough": { "@from": "Physician.rank", "@convert": true } }] } },
        { "identity.primary": { name: "id", extends: "Physician.id" } },
      ] } },
    ],
  },
};

async function views(dialect: "postgres" | "sqlite") {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(errors).toEqual([]);
  return buildProjectionViews(root, { dialect })[0]!.sql;
}

describe("view cast — the declared type wins in a generated Postgres view", () => {
  test("a typed null is cast; a text null stays bare", async () => {
    const sql = await views("postgres");
    expect(sql).toContain("CAST(NULL AS INTEGER) AS location_type");
    expect(sql).toContain("CAST(NULL AS TIMESTAMPTZ) AS removed_at");
    expect(sql).toContain("NULL AS territory_name");
  });

  test("an @convert passthrough is cast to the declared type", async () => {
    const sql = await views("postgres");
    expect(sql).toContain("CAST(p.external_reference_id AS TEXT) AS external_ref");
    expect(sql).toContain("CAST(p.rank AS BIGINT) AS rank_wide");
  });

  test("SQLite views are untyped: no cast", async () => {
    const sql = await views("sqlite");
    expect(sql).not.toContain("CAST(");
  });
});
