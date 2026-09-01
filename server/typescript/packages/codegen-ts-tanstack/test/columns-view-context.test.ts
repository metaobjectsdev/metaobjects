// #356 — a grid column reads the view declared for the GRID, not whichever view a field
// happened to declare first.
//
// The reported shape: `AuditEntry.outcome` is a `field.enum` declaring a dropdown for the
// form and a text cell for the grid. Every emitter read `field.views()[0]`, so swapping
// two lines of JSON with no semantic change moved the dropdown onto the grid and the text
// control onto the form. This asserts the grid's half AND that both orderings agree — the
// order-independence is the actual claim, so it is asserted rather than implied.

import { describe, test, expect } from "bun:test";
import { renderColumnsFile } from "../src/templates/columns-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

const FORM_VIEW = { "view.dropdown": { name: "form", "@title": "Outcome control" } };
const GRID_VIEW = { "view.text": { name: "grid", "@title": "Result" } };

function model(views: unknown[]): string {
  return JSON.stringify({
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
}

async function render(views: unknown[]): Promise<string> {
  const { root, errors } = await new MetaDataLoader({ strict: true })
    .load([new InMemoryStringSource(model(views), { id: "audit.json" })]);
  // The fixture must be legal under the strict registry, or this would pin a shape an
  // adopter's `meta verify` rejects.
  expect(errors.map((e) => (e as { code?: string }).code)).toEqual([]);
  const entity = root.objects().find((o) => o.name === "AuditEntry")!;
  return renderColumnsFile(entity, makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  }));
}

describe("#356 grid columns select the view named 'grid'", () => {
  test("the column renders the grid's view, not the form's dropdown", async () => {
    const out = await render([FORM_VIEW, GRID_VIEW]);
    expect(out).toContain('meta: { view: "text"');
    expect(out).not.toContain('view: "dropdown"');
    expect(out).toContain('header: "Result"');
  });

  test("swapping the two view declarations emits byte-identical output", async () => {
    // Two lines of JSON reordered, no semantic change — the generated file must not move.
    expect(await render([GRID_VIEW, FORM_VIEW])).toBe(await render([FORM_VIEW, GRID_VIEW]));
  });

  test("a single view still drives the grid whatever it is named", async () => {
    // Back-compat: a lone view is unambiguous, and "display" is the name real models use
    // (it is an `extends` address, ADR-0029). Scoping it by name would drop it.
    const out = await render([{ "view.dropdown": { name: "display" } }]);
    expect(out).toContain('meta: { view: "dropdown"');
  });

  test("several views and none named 'grid' fails the build", async () => {
    await expect(render([
      { "view.text": { name: "compact" } },
      { "view.textarea": { name: "detail" } },
    ])).rejects.toThrow(/none is named "grid"/);
  });
});
