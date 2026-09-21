// The load-bearing test of FR-029: the browser read-model must behave like the
// real one. `buildGrid` runs, unmodified, over BOTH a real `MetaObject` loaded
// by the Node loader AND a browser model built by `loadMetaModel` from that
// same object's EFFECTIVE canonical JSON. Any divergence between the two —
// a dropped inherited field, a missed view, a mis-split child type — shows up
// as a failing `toEqual` below, not as a silent runtime bug in some consumer.
//
// Test code may import the metadata package ROOT (MetaDataLoader,
// canonicalSerializeEffective), including values: the #287 browser-bundling
// restriction applies only to `src/`, never to tests, which are not bundled.
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { MetaDataLoader, canonicalSerializeEffective, type MetaObject } from "@metaobjectsdev/metadata";
import { TYPE_OBJECT } from "@metaobjectsdev/metadata/constants";
import { buildGrid } from "../src/grid-from-metadata.js";
import { loadMetaModel } from "../src/load-meta-model.js";

const FIXTURES = join(import.meta.dir, "..", "..", "..", "..", "..", "fixtures", "conformance");

/**
 * Fixtures whose models exercise inheritance — the case where an own-vs-resolving
 * mistake would diverge (ADR-0039). All three carry real OBJECT-level `extends`
 * (not just field-level), which is what would go missing if the browser reader
 * mis-split a node type or a server-side accessor read own-only:
 *   - extends-abstract-base: object.entity Subscriber extends acme::BaseEntity.
 *   - extends-abstract-field-inheritance: object-level inheritance (Contact
 *     extends BaseEntity) PLUS field-level `extends` on individual fields.
 *   - extends-view-triple-nest: field- AND view-level extends; views drive
 *     buildGrid's header and renderer hint directly.
 */
const CASES = [
  "extends-abstract-base",
  "extends-abstract-field-inheritance",
  "extends-view-triple-nest",
];

describe("browser read-model parity", () => {
  for (const name of CASES) {
    test(`buildGrid agrees for ${name}`, async () => {
      // fromDirectory is awaited directly — not a builder with a .load().
      const result = await MetaDataLoader.fromDirectory(join(FIXTURES, name, "input"));
      expect(result.errors).toEqual([]);

      const browser = loadMetaModel(canonicalSerializeEffective(result.root));

      // children(), not ownChildren() (ADR-0039): a root's object children are
      // resolving reads too, even though the root itself never extends.
      // TYPE_OBJECT, not the literal "object": named constants for every
      // metamodel string. The type predicate narrows to MetaObject so `real`
      // below needs no cast to satisfy MetaRead.
      const realObjects = result.root
        .children()
        .filter((c): c is MetaObject => c.type === TYPE_OBJECT);
      expect(realObjects.length).toBeGreaterThan(0);

      for (const real of realObjects) {
        const mirrored = browser.object(real.name);
        expect(mirrored, `${real.name} missing from the browser model`).toBeDefined();
        // The SAME function over both models, no cast on either side: a real
        // MetaObject satisfies MetaRead structurally. Any divergence — a
        // dropped inherited view, a missed attr, a mis-split child type —
        // shows up right here.
        expect(buildGrid(mirrored!)).toEqual(buildGrid(real));
      }
    });
  }

  // Fix round 1: the three CASES above all carry a view, but none of them
  // actually exercises grid-from-metadata.ts's view-derived outputs — a
  // mutation test proved it (dropping every field's views() to `[]` still
  // passed all three). `extends-view-triple-nest`'s view.currency sits on a
  // field.currency, so `viewKind` (`view.subType ?? field.subType`) resolves
  // to "currency" either way, and its view carries `@locale`, not `@title`,
  // so `header` falls back to the same humanized name either way. Built from
  // a string, not a fixture, so the divergence this case needs is explicit
  // and visible right here rather than incidental to some other fixture's
  // shape.
  test("buildGrid agrees when a view changes both header and renderer hint", async () => {
    const json = JSON.stringify({
      "metadata.root": {
        package: "demo",
        children: [
          {
            "object.value": {
              name: "ViewKindProbe",
              children: [
                {
                  "field.string": {
                    name: "fullName",
                    children: [
                      // view.text on field.string: subtypes DIFFER ("text" vs
                      // "string"), so viewKind changes. @title differs from
                      // humanize("fullName") ("Full Name"), so header changes.
                      { "view.text": { name: "display", "@title": "Preferred Display Name" } },
                    ],
                  },
                },
              ],
            },
          },
        ],
      },
    });

    // fromString is awaited directly, same shape as fromDirectory.
    const result = await MetaDataLoader.fromString(json, "json");
    expect(result.errors).toEqual([]);

    const browser = loadMetaModel(canonicalSerializeEffective(result.root));
    const realObjects = result.root
      .children()
      .filter((c): c is MetaObject => c.type === TYPE_OBJECT);
    expect(realObjects).toHaveLength(1);
    const real = realObjects[0]!;
    const mirrored = browser.object(real.name);
    expect(mirrored, `${real.name} missing from the browser model`).toBeDefined();

    const realGrid = buildGrid(real);
    // Sanity: prove this fixture actually exercises the view path — a failure
    // here means the fixture itself has the same blind spot as the fixture
    // this case was added to cover for, not that the parity check is broken.
    expect(realGrid.columns[0]!.viewKind).toBe("text");
    expect(realGrid.columns[0]!.header).toBe("Preferred Display Name");

    expect(buildGrid(mirrored!)).toEqual(realGrid);
  });
});
