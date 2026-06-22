// Regression: a view-kind projection that MIXES an `extends` base-link field (the PK
// that declares the projection's base entity, FR-024) with `origin.passthrough` renames.
// Two bugs this pins:
//   1. buildView read the view name from `tableName` (the @table slot only) — a @view
//      source has no @table, so it bailed to null before building any column.
//   2. buildView found origins via `f.ownChildren()` (own-only) — an `extends` base-link
//      field carries no own origin (its source is in EXTENDED metadata, superRef /
//      resolveSuper()), so it was flagged "no resolvable origin" and bailed the whole view.
// Both are fixed: the @view name resolves via physicalName, and an extends-base-link field
// projects as an implicit passthrough.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { buildExpectedViews } from "../../src/expected-views.js";

async function load(children: unknown[]) {
  const json = JSON.stringify({ "metadata.root": { package: "acme", children } });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  expect(errors).toEqual([]);
  return root;
}

describe("buildExpectedViews — extends base-link + origin.passthrough", () => {
  test("extends-PK projects as a passthrough alongside an origin rename (@view source)", async () => {
    const root = await load([
      {
        "object.entity": {
          name: "Program",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "title" } },
            { "identity.primary": { name: "pk", "@fields": ["id"] } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ProgramSummary",
          children: [
            { "source.rdb": { "@kind": "view", "@view": "v_program_summary" } },
            { "field.long": { name: "id", extends: "acme::Program.id" } },
            {
              "field.string": {
                name: "displayTitle",
                children: [{ "origin.passthrough": { "@from": "acme::Program.title" } }],
              },
            },
            { "identity.primary": { extends: "acme::Program.pk" } },
          ],
        },
      },
    ]);

    const views = buildExpectedViews(root, "snake_case");
    expect(views.length).toBe(1);
    const sql = views[0]!.sql;
    expect(sql).toContain(`"id" AS "id"`); // extends base-link → implicit passthrough
    expect(sql).toContain(`"title" AS "display_title"`); // origin.passthrough rename
    expect(sql).toContain(`FROM "programs"`);
  });
});
