// #356 — the generated form renders the view declared for the FORM, not whichever view a
// field happened to declare first.
//
// The reported damage, in the reporter's own words: declaring a `view.text` so the GRID
// cell rendered as text silently degraded the generated FORM to an `<input>`. Both
// surfaces read `field.views()[0]`, so one declaration served three readers and
// declaration order decided all of them.

import { describe, test, expect } from "bun:test";
import { renderFormFile } from "../src/index.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";

const FORM_VIEW = { "view.dropdown": { name: "form" } };
const GRID_VIEW = { "view.text": { name: "grid" } };

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
          ],
        },
      }],
    },
  });
  const { root, errors } = await new MetaDataLoader({ strict: true })
    .load([new InMemoryStringSource(json, { id: "audit.json" })]);
  expect(errors.map((e) => (e as { code?: string }).code)).toEqual([]);
  const entity = root.objects().find((o) => o.name === "AuditEntry")!;
  return renderFormFile(entity, makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  }));
}

/** The JSX block the form emits for `outcome` — a `<select>`, `<textarea>` or `<input>`.
 *  Anchored on the field's own <label>, so the slice cannot drift onto a sibling field. */
function outcomeControl(out: string): string {
  const at = out.indexOf("{AuditEntry.outcome.label}</label>");
  expect(at).toBeGreaterThan(-1);
  return out.slice(at, at + 400);
}

describe("#356 the form selects the view named 'form'", () => {
  test("the enum keeps its <select> in EITHER declaration order", async () => {
    // Both orderings are asserted, not just the lucky one: with a positional read the
    // `view.text`-first ordering is the arrangement that loses the <select>, so a test
    // that only declares the dropdown first passes with the defect fully present.
    for (const views of [[FORM_VIEW, GRID_VIEW], [GRID_VIEW, FORM_VIEW]]) {
      const control = outcomeControl(await render(views));
      expect(control).toContain("<select");
      expect(control).toContain('<option value="PASS">');
      expect(control).not.toContain("<input");
    }
  });

  test("declaring the grid view FIRST does not degrade the form to an <input>", async () => {
    // This ordering is the reported bug verbatim: text first, and the <select> vanished.
    expect(await render([GRID_VIEW, FORM_VIEW])).toBe(await render([FORM_VIEW, GRID_VIEW]));
  });

  test("a single view still drives the form whatever it is named", async () => {
    const control = outcomeControl(await render([{ "view.textarea": { name: "display" } }]));
    expect(control).toContain("<textarea");
  });

  test("several views and none named 'form' fails the build", async () => {
    await expect(render([
      { "view.text": { name: "compact" } },
      { "view.textarea": { name: "detail" } },
    ])).rejects.toThrow(/none is named "form"/);
  });
});
