// `@emitForm` was read by formFile's filter (`=== false` ⇒ skip) but was NEVER registered
// metamodel vocabulary: the strict loader `meta verify` runs rejects it with
// ERR_UNKNOWN_ATTR, while `meta gen` loads non-strict and honoured it. Worse, the
// template's own doc comment claimed the opposite polarity — that `@emitForm: true` turned
// form generation ON — so the one value an adopter was told to write was a no-op that
// still failed their drift gate.
//
// The read is gone. This pins both halves: the attribute decides nothing, and `filter` is
// the mechanism that does. A deletion proved only by an absent assertion is not proved.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { formFile } from "../src/form-file.js";
import { formFile as refFormFile } from "../src/reference/form.js";

/** A writable entity carrying the retired attribute with the given value. */
async function rootWith(emitForm: boolean): Promise<MetaRoot> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [{
          "object.entity": {
            name: "Booking",
            "@emitForm": emitForm,
            children: [
              { "source.rdb": { "@table": "bookings" } },
              { "field.long": { name: "id" } },
              { "field.string": { name: "code", "@maxLength": 20 } },
              { "identity.primary": { name: "pk", "@fields": "id", "@generation": "increment" } },
            ],
          },
        }],
      },
    })),
  ]);
  expect(errors).toEqual([]);
  return root;
}

describe("@emitForm is retired", () => {
  // Both halves of the ADR-0034 pair, so an eject leaves the adopter with the same
  // behaviour — the reference template carried its own copy of the read.
  for (const [label, factory] of [["built-in", formFile], ["reference template", refFormFile]] as const) {
    test(`INERT in the ${label} — neither value suppresses the form`, async () => {
      for (const value of [false, true]) {
        const root = await rootWith(value);
        const booking = root.objects().find((o) => o.name === "Booking")!;
        expect(booking.hasAttr("emitForm")).toBe(true);   // the adopter really wrote it …
        expect(factory().filter?.(booking)).toBe(true);   // … and it decides nothing.
      }
    });
  }

  test("`filter` is how you narrow — it AND-composes with the built-in gates", async () => {
    const root = await rootWith(false);
    const booking = root.objects().find((o) => o.name === "Booking")!;
    expect(formFile({ filter: (e) => e.name !== "Booking" }).filter?.(booking)).toBe(false);
    // And it can only NARROW: a filter cannot admit an object the built-in gates reject.
    expect(formFile({ filter: () => true }).filter?.(booking)).toBe(true);
  });
});
