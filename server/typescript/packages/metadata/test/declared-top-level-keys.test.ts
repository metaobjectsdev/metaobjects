// declaredTopLevelKeys — the structural pre-parse walk that reports every
// top-level declaration's (type, resolutionKey, overlay).
//
// It began as the private predicate behind the #160 overlay-only source
// partition. ADR-0055 retired that partition — overlays are applied in a
// post-parse pass, so the loader makes no ordering decision that needs this —
// leaving ONE caller: the `meta verify` overlay authoring lint, which needs
// per-file declaration provenance exactly because the merged tree has already
// lost which file contributed which declaration.
//
// FR-023 §11 (overlay authoring lint) task 17; ADR-0055.

import { describe, test, expect } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  declaredTopLevelKeys, MetaDataLoader, InMemoryStringSource, TYPE_OBJECT, TYPE_FIELD,
} from "../src/index.js";
import { FileSource } from "../src/loader/sources/file-source.js";
import { PACKAGE_SEPARATOR } from "../src/shared/structural.js";

const FIXTURES_DIR = new URL("./fixtures/", import.meta.url).pathname;
function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

describe("declaredTopLevelKeys — JSON", () => {
  test("reports type, resolution key and overlay flag for each top-level child", async () => {
    const content = JSON.stringify({
      "metadata.root": {
        package: "app",
        children: [
          {
            "object.entity": {
              name: "Order",
            },
          },
          {
            "object.entity": {
              name: "Order",
              package: "acme::common",
              overlay: true,
            },
          },
        ],
      },
    });

    const result = await declaredTopLevelKeys(content, "json");

    expect(result).toEqual([
      { type: "object", key: "app::Order", overlay: false },
      { type: "object", key: "acme::common::Order", overlay: true },
    ]);
  });

  test("a source with no package falls back to the bare name as the key", async () => {
    const content = JSON.stringify({
      "metadata.root": {
        children: [{ "object.entity": { name: "Standalone" } }],
      },
    });

    const result = await declaredTopLevelKeys(content, "json");

    expect(result).toEqual([{ type: "object", key: "Standalone", overlay: false }]);
  });

  test("a declaration with no name is skipped — no resolution key can be computed", async () => {
    const content = JSON.stringify({
      "metadata.root": {
        package: "app",
        children: [{ "object.entity": {} }, { "object.entity": { name: "Kept" } }],
      },
    });

    const result = await declaredTopLevelKeys(content, "json");

    expect(result).toEqual([{ type: "object", key: "app::Kept", overlay: false }]);
  });

  test("a malformed root (no metadata.root, children absent) returns an empty list rather than throwing", async () => {
    expect(await declaredTopLevelKeys(JSON.stringify({}), "json")).toEqual([]);
    expect(
      await declaredTopLevelKeys(JSON.stringify({ "metadata.root": { package: "app" } }), "json"),
    ).toEqual([]);
  });
});

describe("declaredTopLevelKeys — YAML (sigil-free authoring)", () => {
  test("a bare `overlay: true` child reports overlay: true, before desugar", async () => {
    const content = [
      "metadata:",
      "  package: app",
      "  children:",
      "    - object.entity:",
      "        name: Base",
      "    - object.entity:",
      "        name: Overlaid",
      "        overlay: true",
      "",
    ].join("\n");

    const result = await declaredTopLevelKeys(content, "yaml");

    expect(result).toEqual([
      { type: "object", key: "app::Base", overlay: false },
      { type: "object", key: "app::Overlaid", overlay: true },
    ]);
  });
});

describe("declaredTopLevelKeys — order-independence of the overlay-only partition", () => {
  // #160's overlay-only-source partition (re-expressed over declaredTopLevelKeys
  // by this task) exists precisely so an overlay-only source presented BEFORE
  // its base still merges. Nothing in the suite pinned that ordering guarantee
  // before this task generalized the walk it depends on — a regression here
  // (e.g. dropping the stable-partition call, or a declaredTopLevelKeys bug
  // that misreports a source as NOT overlay-only) would be silent.
  test("an overlay-only source loaded BEFORE its base still merges into it", async () => {
    const base = new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "acme",
          children: [
            {
              "object.entity": {
                name: "Widget",
                children: [{ "field.string": { name: "sku" } }],
              },
            },
          ],
        },
      }),
      { id: "base.json", format: "json" },
    );
    // Every top-level declaration in this source carries overlay: true, so it
    // is overlay-only — declaredTopLevelKeys is what tells the partition that.
    const overlay = new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "acme",
          children: [
            {
              "object.entity": {
                name: "Widget",
                overlay: true,
                children: [{ "field.string": { name: "warranty" } }],
              },
            },
          ],
        },
      }),
      { id: "overlay.json", format: "json" },
    );

    const loader = new MetaDataLoader({ freeze: false });
    // Overlay source FIRST in the array — the stable-partition must still
    // move it to the end so it merges into `base` rather than raising
    // ERR_OVERLAY_NO_TARGET (no existing "Widget" would be visible yet if the
    // sources were parsed in the array's literal order).
    const { root, errors } = await loader.load([overlay, base]);

    expect(errors).toEqual([]);
    const widget = root.ownChildByTypeAndName(TYPE_OBJECT, "Widget");
    expect(widget).toBeDefined();
    expect(widget!.ownChildByTypeAndName(TYPE_FIELD, "sku")).toBeDefined();
    expect(widget!.ownChildByTypeAndName(TYPE_FIELD, "warranty")).toBeDefined();
  });
});

describe("declaredTopLevelKeys — key agrees with the real loader on a relative package", () => {
  // fix-round-1: this walk used to return "::garage::Garage" for this exact
  // fixture (root package "acme", Garage's own "package": "::garage") — the
  // relative-package expansion `rootChildResolutionKey` (parser-core.ts)
  // performs via `expandPackageForPath` was missing here. The real loader
  // resolves the same declaration to "acme::garage::Garage". Both sides of
  // that comparison were wrong the same way before the fix, which is why
  // nothing in the existing suite caught it — this test computes the
  // expected value from the REAL loader rather than a hand-typed literal, so
  // it cannot pass by both sides encoding the same mistake.
  test("Garage's key (own package '::garage', root package 'acme') matches root.resolutionKey()", async () => {
    const path = fixturePath("acme-vehicle-metadata.json");

    // acme-vehicle-metadata.json's fields extend acme::common bases, so
    // acme-common-metadata.json must load first — same two-file order
    // round-trip.test.ts uses for this fixture pair.
    const loader = new MetaDataLoader({ freeze: false });
    const { root, errors } = await loader.load([
      new FileSource(fixturePath("acme-common-metadata.json")),
      new FileSource(path),
    ]);
    expect(errors).toEqual([]);
    const garage = root.ownChildByTypeAndName(TYPE_OBJECT, "Garage");
    expect(garage).toBeDefined();
    const expectedKey = garage!.resolutionKey();
    // The fixture's relative spelling means a bug here still lands "some
    // string" that ends in "::Garage" — assert the real loader actually
    // performed the expansion too (i.e. this isn't vacuously comparing two
    // wrong-but-equal strings), then compare declaredTopLevelKeys against it.
    expect(expectedKey).toBe(`acme${PACKAGE_SEPARATOR}garage${PACKAGE_SEPARATOR}Garage`);

    const content = await readFile(path, "utf-8");
    const declared = await declaredTopLevelKeys(content, "json");
    // Located by the AUTHORED name (independent of the key-computation this
    // test exists to check), not by re-deriving the expected key.
    const garageDecl = declared.find(
      (d) => d.type === TYPE_OBJECT && d.key.endsWith(`${PACKAGE_SEPARATOR}Garage`),
    );
    expect(garageDecl).toBeDefined();
    expect(garageDecl!.key).toBe(expectedKey);
  });
});
