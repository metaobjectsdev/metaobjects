// A descriptor that says `view: "dropdown"` must carry what a dropdown needs.
//
// 0.25.0 moved a `field.enum`'s FORM view from "text" to "dropdown". The descriptor kept
// emitting no member list, so the generated `<Entity>` const told a consumer to render a
// `<select>` and handed it nothing to fill one with — while the metadata had `@values` all
// along. Every consumer then restated the members by hand; on the public reference app the
// same four symbols appeared as literals across five hand-written files.
//
// Nothing caught it: the whole codegen suite passed unchanged when `options` was added,
// because not one fixture asserted an enum field's descriptor output at all. This is that
// assertion.
import { describe, test, expect } from "bun:test";
import type { MetaObject } from "@metaobjectsdev/metadata";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderEntityConstants } from "../src/templates/entity-constants.js";
import { buildUiFieldDescriptor } from "../src/templates/entity-ui-descriptor.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      // An abstract enum a concrete field inherits its members from, so the resolving
      // read (ADR-0039) is exercised rather than an own-only one.
      { "field.enum": { name: "orderState", abstract: true, "@values": ["open", "closed"] } },
      {
        "object.entity": {
          name: "Order",
          children: [
            { "source.rdb": { "@kind": "table", "@table": "orders" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.enum": { name: "status", "@values": ["pending", "shipped", "cancelled"] } },
            { "field.enum": { name: "state", extends: "orderState" } },
            { "field.string": { name: "note" } },
          ],
        },
      },
    ],
  },
};

async function loadOrder(): Promise<MetaObject> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  if (result.errors.length > 0) throw new Error(result.errors.map((e) => e.message).join("\n"));
  return result.root.objects().find((o) => o.name === "Order")!;
}

describe("an enum field's descriptor carries its members", () => {
  test("a declared enum reports view dropdown AND its options", async () => {
    const order = await loadOrder();
    const status = order.fields().find((f) => f.name === "status")!;
    const d = buildUiFieldDescriptor(status);
    expect(d.view).toBe("dropdown");
    expect(d.options).toEqual(["pending", "shipped", "cancelled"]);
  });

  test("members inherited through extends resolve too", async () => {
    const order = await loadOrder();
    const state = order.fields().find((f) => f.name === "state")!;
    // An own-only read would return undefined here and the dropdown would be empty.
    expect(buildUiFieldDescriptor(state).options).toEqual(["open", "closed"]);
  });

  test("a non-enum field carries no options key", async () => {
    const order = await loadOrder();
    const note = order.fields().find((f) => f.name === "note")!;
    expect(buildUiFieldDescriptor(note).options).toBeUndefined();
  });

  test("the emitted const spells the members, and only for the enums", async () => {
    const out = renderEntityConstants(await loadOrder()).toString();
    expect(out).toContain(`options: ["pending", "shipped", "cancelled"] as const`);
    expect(out).toContain(`options: ["open", "closed"] as const`);
    // Exactly two option lists — the string field must not grow one.
    expect(out.match(/options:/g)?.length).toBe(2);
  });
});
