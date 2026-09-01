// #356 — the `<Entity>.meta.ts` descriptor reads the view declared for the FORM.
//
// The descriptor is the form's surface, not a third one: every key beside `view`
// (`htmlType`, `placeholder`, `helpText`, `rules`) is a form-input attribute, and
// `useEntityForm` is its only consumer — the grid tiers compute their own view kind at
// codegen time and never read it. So the descriptor and the generated `<Entity>.form.tsx`
// resolve the SAME view, which is what keeps the two from disagreeing.
//
// In the reported repro this file flipped from `view: "dropdown"` to `view: "text"` when
// two lines of JSON were swapped with no semantic change.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderEntityMetaFile } from "../../src/templates/entity-meta-file.js";

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
          ],
        },
      }],
    },
  });
  const { root, errors } = await new MetaDataLoader({ strict: true })
    .load([new InMemoryStringSource(json, { id: "audit.json" })]);
  expect(errors.map((e) => (e as { code?: string }).code)).toEqual([]);
  return renderEntityMetaFile(root.objects().find((o) => o.name === "AuditEntry")!);
}

describe("#356 the descriptor selects the view named 'form'", () => {
  test("emits the form's view and the form's @title in EITHER declaration order", async () => {
    // Both orderings are asserted, not just the lucky one: with a positional read the
    // `view.text`-first ordering is the arrangement the issue reports flipping this file
    // to `view: "text"`, so declaring the dropdown first would pass with the defect present.
    for (const views of [[FORM_VIEW, GRID_VIEW], [GRID_VIEW, FORM_VIEW]]) {
      const out = await render(views);
      expect(out).toContain('view: "dropdown"');
      expect(out).toContain('label: "Outcome control"');
      expect(out).not.toContain('view: "text"');
    }
  });

  test("swapping the two view declarations emits byte-identical output", async () => {
    expect(await render([GRID_VIEW, FORM_VIEW])).toBe(await render([FORM_VIEW, GRID_VIEW]));
  });

  test("a single view still drives the descriptor whatever it is named", async () => {
    expect(await render([{ "view.textarea": { name: "display" } }])).toContain('view: "textarea"');
  });

  test("several views and none named 'form' fails the build", async () => {
    await expect(render([
      { "view.text": { name: "compact" } },
      { "view.textarea": { name: "detail" } },
    ])).rejects.toThrow(/none is named "form"/);
  });
});
