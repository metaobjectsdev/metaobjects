// A Postgres view qualifies a relation with its schema only when that relation's entity declares
// @schema; an entity with none stays a bare name (never `public.`). SQLite views are always bare.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

const MODEL = { "metadata.root": { package: "acme", children: [
  { "object.entity": { name: "Owner", children: [
    { "source.rdb": { "@table": "owners", "@schema": "crm" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "name" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
  ] } },
  { "object.entity": { name: "Note", children: [
    { "source.rdb": { "@table": "notes" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "ownerId" } },
    { "field.string": { name: "body" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "owner", "@fields": "ownerId", "@references": "Owner" } },
  ] } },
  { "object.projection": { name: "NoteView", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_notes" } },
    { "field.long": { name: "id", extends: "Note.id" } },
    { "field.string": { name: "ownerName", children: [{ "origin.passthrough": { "@from": "Owner.name", "@via": "Note.owner" } }] } },
    { "identity.primary": { name: "id", extends: "Note.id" } },
  ] } },
  { "object.projection": { name: "OwnerView", children: [
    { "source.rdb": { "@kind": "view", "@table": "v_owners" } },
    { "field.long": { name: "id", extends: "Owner.id" } },
    { "field.string": { name: "latestBody", children: [{ "origin.first": { "@of": "Note.body", "@via": "Owner.notes", "@orderBy": ["id:desc"] } }] } },
    { "identity.primary": { name: "id", extends: "Owner.id" } },
  ] } },
] } };

async function sql(dialect: "postgres" | "sqlite", view = "v_notes") {
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(errors).toEqual([]);
  return buildProjectionViews(root, { dialect }).find((v) => v.name === view)!.sql;
}

describe("view relation qualification", () => {
  test("Postgres qualifies a relation whose entity declares @schema, and no other", async () => {
    const s = await sql("postgres");
    expect(s).toContain("FROM notes n");
    expect(s).toContain("LEFT OUTER JOIN crm.owners o");
    expect(s).not.toContain("public.");
  });

  test("a schema-declaring base and a bare correlated subquery", async () => {
    const s = await sql("postgres", "v_owners");
    expect(s).toContain("FROM crm.owners o");
    expect(s).toMatch(/FROM notes \w+ WHERE/);
    expect(s).not.toContain("public.");
  });

  test("SQLite stays bare", async () => {
    expect(await sql("sqlite")).not.toContain("crm.");
  });
});
