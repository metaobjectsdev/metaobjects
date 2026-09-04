// The generated FORM and the descriptor it ships must name the same control.
//
// They did not, for `field.enum` specifically. `codegen-ts-react`'s `viewKindFor` has
// returned `dropdown` for an enum declaring no view since the form-control dispatch
// landed, and emits a `<select>` with an `<option>` per member. The shared
// `defaultViewForSubType` had no enum branch at all, so the `<Entity>` descriptor —
// which `useEntityForm` reads at RUNTIME — fell through to `text` and told every
// consumer the control was a free-text input, for the ONE field subtype where free text
// is what the model forbids.
//
// Nothing caught it because no golden fixture carried an enum field with a descriptor:
// the `view: "text"` lines in the snapshots are all string fields, so the branch could
// be wrong indefinitely and every gate stayed green. This test exists to make the
// agreement checkable rather than coincidental, which is why it asserts BOTH tiers
// against ONE loaded field rather than pinning a constant on each side.

import { describe, test, expect } from "bun:test";
import type { MetaField, MetaObject } from "@metaobjectsdev/metadata";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { inferViewKind } from "../src/templates/field-meta.js";
import { VIEW_CONTEXT_FORM } from "../src/view-context.js";
import { buildEntityUiDescriptor } from "../src/templates/entity-ui-descriptor.js";
import { renderEntityConstants } from "../src/templates/entity-constants.js";

const MODEL = {
  "metadata.root": {
    package: "acme",
    children: [
      {
        "object.entity": {
          name: "Ticket",
          children: [
            { "source.rdb": { "@kind": "table", "@table": "tickets" } },
            { "field.long": { name: "id", "@required": true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            {
              "field.enum": {
                name: "status",
                "@values": ["open", "closed"],
              },
            },
            // The control case: a plain string beside it must STILL be `text`, so a
            // green result cannot come from the default having moved wholesale.
            { "field.string": { name: "title" } },
          ],
        },
      },
    ],
  },
};

async function loadTicket(): Promise<MetaObject> {
  const result = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify(MODEL)),
  ]);
  if (result.errors.length > 0) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  return result.root.objects()[0]!;
}

function fieldNamed(obj: MetaObject, name: string): MetaField {
  const f = obj.fields().find((x) => x.name === name);
  if (f === undefined) throw new Error(`no field ${name}`);
  return f;
}

describe("field.enum form control", () => {
  test("the shared resolver says dropdown, and a plain string still says text", async () => {
    const ticket = await loadTicket();
    expect(inferViewKind(fieldNamed(ticket, "status"), VIEW_CONTEXT_FORM)).toBe("dropdown");
    expect(inferViewKind(fieldNamed(ticket, "title"), VIEW_CONTEXT_FORM)).toBe("text");
  });

  test("the UI descriptor carries it, and drops the htmlType a <select> has no use for", async () => {
    const ticket = await loadTicket();
    const descriptor = buildEntityUiDescriptor(ticket);
    const status = descriptor.fields.find((f) => f.name === "status");
    expect(status?.view).toBe("dropdown");
    // `dropdown` maps to no `<input type=…>`: a consumer keying an `<input>` off this
    // would render the wrong element, so the absence is the correct answer, not a gap.
    expect(status?.htmlType).toBeUndefined();
    expect(descriptor.fields.find((f) => f.name === "title")?.htmlType).toBe("text");
  });

  test("the EMITTED <Entity> const says dropdown — this is what useEntityForm reads", async () => {
    const ticket = await loadTicket();
    const out = renderEntityConstants(ticket).toString();
    // Anchored on the field entry, not a bare substring: `view: "text"` appears for
    // `title` in the same file, so an unanchored match would pass either way.
    expect(out).toMatch(/status: \{[^}]*view: "dropdown"/s);
    expect(out).toMatch(/title: \{[^}]*view: "text"/s);
  });
});
