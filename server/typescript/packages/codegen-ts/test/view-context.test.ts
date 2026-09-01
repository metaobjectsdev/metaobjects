// #356 — `viewForContext`, the selector every emitter now reads a field's view through.
//
// The back-compat guarantee is the load-bearing half and is asserted first: a field
// declaring ONE view keeps its exact pre-#356 behaviour whatever that view is named.
// View names are already an `extends` ADDRESS (ADR-0029 `Customer.priceCents.display`),
// so re-reading a single view's name as a surface name would break addressing — the one
// way this fix could have broken every existing model.

import { describe, test, expect } from "bun:test";
import type { MetaField } from "@metaobjectsdev/metadata";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { viewForContext, VIEW_CONTEXT_FORM, VIEW_CONTEXT_GRID } from "../src/view-context.js";

async function fieldWithViews(views: unknown[]): Promise<MetaField> {
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        { "object.entity": { name: "AuditEntry", children: [
          { "field.enum": { name: "outcome", "@values": ["PASS", "FAIL"], children: views } },
        ]}},
      ],
    },
  });
  const { root, errors } = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("\n"));
  return root.objects()[0]!.ownFields()[0]!;
}

describe("viewForContext — one view or none is unambiguous", () => {
  test("no views → undefined (the caller's inferred-default path)", async () => {
    expect(viewForContext(await fieldWithViews([]), VIEW_CONTEXT_FORM)).toBeUndefined();
  });

  test("a single UNNAMED view applies to every surface", async () => {
    const f = await fieldWithViews([{ "view.dropdown": {} }]);
    expect(viewForContext(f, VIEW_CONTEXT_FORM)?.subType).toBe("dropdown");
    expect(viewForContext(f, VIEW_CONTEXT_GRID)?.subType).toBe("dropdown");
  });

  test("a single view named for something else STILL applies to every surface", async () => {
    // "display" is the name real models use, as an `extends` address. Scoping a lone
    // view by its name would silently drop it from every surface.
    const f = await fieldWithViews([{ "view.dropdown": { name: "display" } }]);
    expect(viewForContext(f, VIEW_CONTEXT_FORM)?.subType).toBe("dropdown");
    expect(viewForContext(f, VIEW_CONTEXT_GRID)?.subType).toBe("dropdown");
  });
});

describe("viewForContext — several views select by name", () => {
  const two = [
    { "view.dropdown": { name: "form" } },
    { "view.text": { name: "grid" } },
  ];

  test("each surface gets the view named for it", async () => {
    const f = await fieldWithViews(two);
    expect(viewForContext(f, VIEW_CONTEXT_FORM)?.subType).toBe("dropdown");
    expect(viewForContext(f, VIEW_CONTEXT_GRID)?.subType).toBe("text");
  });

  test("declaration order is not read", async () => {
    const f = await fieldWithViews([...two].reverse());
    expect(viewForContext(f, VIEW_CONTEXT_FORM)?.subType).toBe("dropdown");
    expect(viewForContext(f, VIEW_CONTEXT_GRID)?.subType).toBe("text");
  });

  test("an owned generator may ask for its own surface name", async () => {
    const f = await fieldWithViews([
      { "view.dropdown": { name: "form" } },
      { "view.hidden": { name: "export" } },
    ]);
    expect(viewForContext(f, "export")?.subType).toBe("hidden");
  });

  test("two UNNAMED views are the ambiguous case and throw", async () => {
    // Both load, both carry name "" — exactly the shape `views()[0]` resolved by position.
    const f = await fieldWithViews([{ "view.dropdown": {} }, { "view.text": {} }]);
    expect(() => viewForContext(f, VIEW_CONTEXT_FORM)).toThrow(/none is named "form"/);
  });

  test("the error names the field, every declared view, and the remedy", async () => {
    const f = await fieldWithViews([
      { "view.text": { name: "compact" } },
      { "view.textarea": {} },
    ]);
    let message = "";
    try { viewForContext(f, VIEW_CONTEXT_GRID); } catch (e) { message = (e as Error).message; }
    expect(message).toContain('AuditEntry.outcome');
    expect(message).toContain('view.text name="compact"');
    expect(message).toContain("view.textarea (no name)");
    expect(message).toContain('Name one of them "grid"');
  });
});
