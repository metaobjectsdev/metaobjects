// #356 — the Angular grid reads the view declared for the GRID, the same surface name the
// TanStack tier asks for.
//
// Angular is source-only (ADR-0048) but builds in-repo, so it is fixed in lockstep: the
// issue's blast radius listed four emitters and missed this one, and an unfixed copy here
// would drift from the tier it is explicitly modelled on.

import { describe, test, expect } from "bun:test";
import { angularGridFile } from "../src/index.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

const FORM_VIEW = { "view.dropdown": { name: "form", "@title": "Outcome control" } };
const GRID_VIEW = { "view.text": { name: "grid", "@title": "Result" } };

async function render(views: unknown[]): Promise<string> {
  const json = JSON.stringify({
    "metadata.root": {
      children: [{
        "object.entity": {
          name: "AuditEntry",
          children: [
            { "source.rdb": { "@table": "audit_entry" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.enum": { name: "outcome", "@values": ["PASS", "FAIL"], children: views } },
            { "layout.dataGrid": { name: "default", "@columns": ["outcome"] } },
          ],
        },
      }],
    },
  });
  const { root, errors } = await new MetaDataLoader({ strict: true })
    .load([new InMemoryStringSource(json, { id: "audit.json" })]);
  expect(errors.map((e) => (e as { code?: string }).code)).toEqual([]);
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  const ctx: GenContext = {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
  const files = await angularGridFile().generate(ctx);
  const grid = files.find((f) => f.path.includes("AuditEntry"));
  if (grid === undefined) throw new Error(`no grid emitted; got ${files.map((f) => f.path).join(", ")}`);
  return grid.content;
}

describe("#356 the Angular grid selects the view named 'grid'", () => {
  test("the column renders the grid's view and header, not the form's", async () => {
    const out = await render([FORM_VIEW, GRID_VIEW]);
    expect(out).toContain('view: "text"');
    expect(out).toContain('header: "Result"');
    expect(out).not.toContain('view: "dropdown"');
  });

  test("swapping the two view declarations emits byte-identical output", async () => {
    expect(await render([GRID_VIEW, FORM_VIEW])).toBe(await render([FORM_VIEW, GRID_VIEW]));
  });

  test("several views and none named 'grid' fails the build", async () => {
    await expect(render([
      { "view.text": { name: "compact" } },
      { "view.textarea": { name: "detail" } },
    ])).rejects.toThrow(/none is named "grid"/);
  });
});

// #355 residue — the Angular tier renders the same surface as the TanStack one, so it
// applies the same rule: `view.hidden` means "not rendered", and a column that exists but
// is blank still holds a header and a sort target.
describe("#355 a view.hidden field is not a grid column", () => {
  test("the column is dropped, not emitted blank", async () => {
    const out = await render([{ "view.hidden": {} }]);
    expect(out).not.toContain("outcome");
    expect(out).not.toContain('view: "hidden"');
  });
});
