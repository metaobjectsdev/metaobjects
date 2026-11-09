// Ruling R54 (rc.19 item 10): on Postgres every relation a generated view reads is
// schema-qualified — its declared `@schema`, else `public`. A bare name binds through the
// `search_path` current when the view is created, so a view in `reporting` over a bare
// `programs` is one `search_path` away from reading itself. SQLite/D1 have no schemas and
// stay bare. Applies to the FROM, every JOIN, an origin.first subquery and a report view.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children } });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

const model = (schemas: boolean) => [
  {
    "object.entity": {
      name: "Program",
      children: [
        { "source.rdb": { "@table": "programs", ...(schemas ? { "@schema": "crm" } : {}) } },
        { "field.int": { name: "id" } },
        { "field.int": { name: "ownerId" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "owner", "@fields": "ownerId", "@references": "Owner" } },
        { "relationship.association": { name: "weeks", "@objectRef": "Week", "@cardinality": "many" } },
      ],
    },
  },
  {
    "object.entity": {
      name: "Owner",
      children: [
        { "source.rdb": { "@table": "owners" } },
        { "field.int": { name: "id" } },
        { "field.string": { name: "label" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
      ],
    },
  },
  {
    "object.entity": {
      name: "Week",
      children: [
        { "source.rdb": { "@table": "weeks" } },
        { "field.int": { name: "id" } },
        { "field.int": { name: "programId" } },
        { "field.int": { name: "ordinal" } },
        { "identity.primary": { name: "id", "@fields": "id" } },
        { "identity.reference": { name: "ref_program", "@fields": "programId", "@references": "Program" } },
      ],
    },
  },
  {
    "object.projection": {
      name: "ProgramSummary",
      children: [
        { "source.rdb": { "@kind": "view", "@table": "v_program_summary", ...(schemas ? { "@schema": "reporting" } : {}) } },
        { "field.int": { name: "id", extends: "Program.id" } },
        { "field.string": { name: "ownerLabel", children: [{ "origin.passthrough": { "@from": "Owner.label", "@via": "Program.owner" } }] } },
        { "field.int": { name: "weekCount", children: [{ "origin.aggregate": { "@agg": "count", "@of": "Week.id", "@via": "Program.weeks" } }] } },
        {
          "field.int": {
            name: "latestOrdinal",
            children: [{ "origin.first": { "@of": "Week.ordinal", "@via": "Program.weeks", "@orderBy": ["ordinal:desc"] } }],
          },
        },
        { "identity.primary": { name: "id", extends: "Program.id" } },
      ],
    },
  },
];

describe("ruling R54 — generated views qualify every relation on Postgres", () => {
  test("postgres: the base, every join and the first subquery carry @schema, else public", async () => {
    const root = await load(model(true));
    const [v] = buildProjectionViews(root, { dialect: "postgres" });
    expect(v!.schema).toBe("reporting");
    expect(v!.sql).toMatch(/FROM crm\.programs [a-z0-9]+/);
    expect(v!.sql).toMatch(/LEFT OUTER JOIN public\.weeks [a-z0-9]+/);
    expect(v!.sql).toMatch(/JOIN public\.owners [a-z0-9]+/);
    expect(v!.sql).toMatch(/\(SELECT [a-z0-9]+\.ordinal FROM public\.weeks [a-z0-9]+ WHERE/);
    // No relation is left bare.
    expect(v!.sql).not.toMatch(/(FROM|JOIN) (programs|weeks|owners) /);
  });

  test("sqlite: relations stay bare", async () => {
    const root = await load(model(false));
    const [v] = buildProjectionViews(root, { dialect: "sqlite" });
    expect(v!.sql).toMatch(/FROM programs [a-z0-9]+/);
    expect(v!.sql).toMatch(/LEFT OUTER JOIN weeks [a-z0-9]+/);
    expect(v!.sql).not.toContain("public.");
  });
});
