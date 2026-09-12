// declaredTopLevelKeys — the structural pre-parse walk `_isOverlayOnlySource`
// used to perform privately (#160), generalized to report every top-level
// declaration's (type, resolutionKey, overlay) rather than just a single
// "is this source overlay-only" boolean.
//
// Two callers exist post-generalization: the loader's own overlay-only-source
// partition (re-expressed over this function — see meta-data-loader.ts) and
// the `meta verify` overlay authoring lint (cli package, Task 17).
//
// FR-023 §11 (overlay authoring lint) task 17.

import { describe, test, expect } from "bun:test";
import {
  declaredTopLevelKeys, MetaDataLoader, InMemoryStringSource, TYPE_OBJECT, TYPE_FIELD,
} from "../src/index.js";

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
