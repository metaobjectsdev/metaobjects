// buildProjectionViews — the single source of expected view DDL. Regression coverage
// for the two own-vs-effective bugs that made a 1:1 contract projection emit only its
// PK (the platform AgentConfigView case):
//   1. `@from` is package-qualified ("pkg::Entity.field") but the joinTree + findObject
//      key on the BARE name — must stripPackage.
//   2. the source field may be INHERITED via `extends` (e.g. an audited base's columns)
//      — must resolve via effective fields(), not ownChildren().
// Also pins the `extends`-base-link PK projecting as an implicit passthrough alongside
// `origin.passthrough` renames, and the bodyOnly emit shape consumed by migrate-ts.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildProjectionViews } from "../../src/projection/build-projection-views.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children } });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

describe("buildProjectionViews — package-qualified @from + inherited source fields", () => {
  test("extends-PK passthrough + renamed origin + INHERITED column all project", async () => {
    const root = await load([
      // Abstract base contributes an inherited column (createdAt → created_at).
      {
        "object.entity": {
          name: "Audited",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "field.timestamp": { name: "createdAt", "@column": "created_at" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Program",
          extends: "acme::Audited",
          children: [
            { "source.rdb": { "@table": "programs" } },
            { "field.string": { name: "rawTitle", "@column": "raw_title" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ProgramView",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_program" } },
            // extends base-link PK → implicit passthrough.
            { "field.long": { name: "id", extends: "acme::Program.id" } },
            // rename via origin.passthrough (FQ @from).
            { "field.string": { name: "title", children: [{ "origin.passthrough": { "@from": "acme::Program.rawTitle" } }] } },
            // INHERITED source column (created_at lives on the Audited base).
            { "field.timestamp": { name: "created_at", children: [{ "origin.passthrough": { "@from": "acme::Program.createdAt" } }] } },
            { "identity.primary": { extends: "acme::Program.pk" } },
          ],
        },
      },
    ]);

    const views = buildProjectionViews(root, { dialect: "postgres", columnNamingStrategy: "snake_case" });
    expect(views.length).toBe(1);
    const v = views[0]!;
    expect(v.name).toBe("v_program");
    // bodyOnly: no CREATE VIEW wrapper, no trailing ';'.
    expect(v.sql).not.toMatch(/CREATE\s+VIEW/i);
    expect(v.sql.trimEnd()).not.toMatch(/;$/);
    // All three columns present (PK passthrough + rename + inherited).
    expect(v.sql).toContain("id AS id");
    expect(v.sql).toContain("raw_title AS title");
    expect(v.sql).toContain("created_at AS created_at");
    expect(v.sql).toContain("FROM programs");
  });
});
