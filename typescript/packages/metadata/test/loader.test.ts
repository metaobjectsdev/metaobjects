// Loader orchestration tests — Task 10 of v0.2 SP1
//
// Covers: single-file load, multi-file overlays, super resolution, freeze,
// custom registry, missing files, parse errors, strict mode, round-trip
// integration on real fixtures, and the loadJson convenience method.

import { describe, it, test, expect } from "bun:test";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Loader } from "../src/loader.js";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { TypeId } from "../src/registry.js";
import { MetaObject } from "../src/meta/meta-object.js";
import { ParseError } from "../src/errors.js";
import {
  TYPE_METADATA,
  TYPE_OBJECT,
  TYPE_FIELD,
  TYPE_SOURCE,
  SUBTYPE_ROOT,
  FIELD_SUBTYPE_STRING,
} from "../src/constants.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = join(import.meta.dir, "fixtures");

function fixturePath(name: string): string {
  return join(FIXTURES_DIR, name);
}

function makeRegistry(): TypeRegistry {
  const r = new TypeRegistry();
  registerCoreTypes(r);
  return r;
}

// ---------------------------------------------------------------------------
// 1. Single file load — minimal JSON
// ---------------------------------------------------------------------------

describe("Loader.loadJson — minimal metadata", () => {
  it('loadJson(\'{"metadata.root":{}}\') → root is metadata.root, no warnings, no errors', () => {
    const loader = new Loader();
    const result = loader.loadJson('{"metadata.root":{}}');
    expect(result.root.type).toBe(TYPE_METADATA);
    expect(result.root.subType).toBe(SUBTYPE_ROOT);
    expect(result.warnings.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it("result.root is defined", () => {
    const loader = new Loader();
    const { root } = loader.loadJson('{"metadata.root":{}}');
    expect(root).toBeDefined();
  });

  it("returns the root name when set", () => {
    const loader = new Loader();
    const { root } = loader.loadJson('{"metadata.root":{"name":"myRoot"}}');
    expect(root.name).toBe("myRoot");
  });
});

// ---------------------------------------------------------------------------
// 2. Single file with package + entities
// ---------------------------------------------------------------------------

describe("Loader.loadJson — with package and entity children", () => {
  const json = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [{ "object.base": { name: "Product" } }],
    },
  });

  it("root has the package set", () => {
    const loader = new Loader();
    const { root } = loader.loadJson(json);
    expect(root.package).toBe("acme");
  });

  it("root has one object child named Product", () => {
    const loader = new Loader();
    const { root } = loader.loadJson(json);
    expect(root.children().length).toBe(1);
    expect(root.childByTypeAndName(TYPE_OBJECT, "Product")).toBeDefined();
  });

  it("no warnings or errors", () => {
    const loader = new Loader();
    const { warnings, errors } = loader.loadJson(json);
    expect(warnings.length).toBe(0);
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Two-file load: base + overlay
// ---------------------------------------------------------------------------

describe("Loader.loadJsonStrings — base + overlay", () => {
  const baseJson = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [{ "object.base": { name: "Store" } }],
    },
  });

  const overlayJson = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [{ "object.base": { name: "Product" } }],
    },
  });

  it("result root has both entities after overlay merge", () => {
    const loader = new Loader();
    const { root, errors } = loader.loadJsonStrings([
      { content: baseJson, sourceName: "base.json" },
      { content: overlayJson, sourceName: "overlay.json" },
    ]);
    expect(errors.length).toBe(0);
    expect(root.childByTypeAndName(TYPE_OBJECT, "Store")).toBeDefined();
    expect(root.childByTypeAndName(TYPE_OBJECT, "Product")).toBeDefined();
  });

  it("result has exactly two children", () => {
    const loader = new Loader();
    const { root } = loader.loadJsonStrings([
      { content: baseJson, sourceName: "base.json" },
      { content: overlayJson, sourceName: "overlay.json" },
    ]);
    expect(root.children().length).toBe(2);
  });

  it("no errors from well-formed base + overlay", () => {
    const loader = new Loader();
    const { errors } = loader.loadJsonStrings([
      { content: baseJson, sourceName: "base.json" },
      { content: overlayJson, sourceName: "overlay.json" },
    ]);
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Override scenario
// ---------------------------------------------------------------------------

describe("Loader.loadJsonStrings — override attr in overlay", () => {
  const baseJson = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [{ "object.base": { name: "Store", "@dbTable": "t" } }],
    },
  });

  const overlayJson = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [
        { "object.base": { name: "Store", overlay: true, "@dbTable": "t2" } },
      ],
    },
  });

  it("Store.dbTable is overridden to t2 after overlay merge", () => {
    const loader = new Loader();
    const { root, errors } = loader.loadJsonStrings([
      { content: baseJson, sourceName: "base.json" },
      { content: overlayJson, sourceName: "overlay.json" },
    ]);
    expect(errors.length).toBe(0);
    const store = root.childByTypeAndName(TYPE_OBJECT, "Store")!;
    expect(store).toBeDefined();
    expect(store.attr("dbTable")).toBe("t2");
  });

  it("still only one Store child (not duplicated)", () => {
    const loader = new Loader();
    const { root } = loader.loadJsonStrings([
      { content: baseJson, sourceName: "base.json" },
      { content: overlayJson, sourceName: "overlay.json" },
    ]);
    const stores = root.children().filter((c) => c.name === "Store");
    expect(stores.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Super resolution across files
// ---------------------------------------------------------------------------

describe("Loader — super resolution after overlay merge", () => {
  // The abstract field "id" is a direct child of metadata (no package).
  // Fish is also a direct child. fishId uses a bare-name super ref "id"
  // which resolves to the top-level abstract field via root-level fallback.
  const json = JSON.stringify({
    "metadata.root": {
      children: [
        {
          "field.string": {
            name: "id",
            abstract: true,
          },
        },
        {
          "object.base": {
            name: "Fish",
            children: [{ "field.string": { name: "fishId", extends: "id" } }],
          },
        },
      ],
    },
  });

  it("Fish.fishId.superResolved points to the abstract id field", () => {
    const loader = new Loader({ freeze: false });
    const { root } = loader.loadJson(json);
    const fish = root.childByTypeAndName(TYPE_OBJECT, "Fish")!;
    expect(fish).toBeDefined();
    const fishId = fish.childByTypeAndName(TYPE_FIELD, "fishId")!;
    expect(fishId).toBeDefined();
    expect(fishId.superResolved).toBeDefined();
    expect(fishId.superResolved!.name).toBe("id");
  });

  it("no unresolved super warnings when ref is resolvable", () => {
    const loader = new Loader({ freeze: false });
    const { warnings } = loader.loadJson(json);
    const unresolvedWarnings = warnings.filter((w) => w.includes("Could not resolve"));
    expect(unresolvedWarnings.length).toBe(0);
  });

  it("abstract id field is still a child of metadata root", () => {
    const loader = new Loader({ freeze: false });
    const { root } = loader.loadJson(json);
    const idField = root.childByTypeAndName(TYPE_FIELD, "id")!;
    expect(idField).toBeDefined();
    expect(idField.isAbstract).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. Freeze applied by default
// ---------------------------------------------------------------------------

describe("Loader — freeze applied by default", () => {
  it("root.isFrozen() === true after loadJson", () => {
    const loader = new Loader();
    const { root } = loader.loadJson('{"metadata.root":{}}');
    expect(root.isFrozen()).toBe(true);
  });

  it("mutations throw after default load", () => {
    const loader = new Loader();
    const { root } = loader.loadJson(
      JSON.stringify({
        "metadata.root": {
          children: [{ "object.base": { name: "A" } }],
        },
      }),
    );
    expect(() => root.setAttr("x", "y")).toThrow();
  });

  it("child nodes are also frozen", () => {
    const loader = new Loader();
    const { root } = loader.loadJson(
      JSON.stringify({
        "metadata.root": {
          children: [{ "object.base": { name: "A" } }],
        },
      }),
    );
    const child = root.childByTypeAndName(TYPE_OBJECT, "A")!;
    expect(child.isFrozen()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. freeze: false option
// ---------------------------------------------------------------------------

describe("Loader — freeze: false", () => {
  it("root.isFrozen() === false when freeze: false passed to constructor", () => {
    const loader = new Loader({ freeze: false });
    const { root } = loader.loadJson('{"metadata.root":{}}');
    expect(root.isFrozen()).toBe(false);
  });

  it("can mutate root after load with freeze: false", () => {
    const loader = new Loader({ freeze: false });
    const { root } = loader.loadJson('{"metadata.root":{}}');
    expect(() => root.setAttr("key", "val")).not.toThrow();
    expect(root.attr("key")).toBe("val");
  });

  it("freeze: true is the same as default", () => {
    const loader = new Loader({ freeze: true });
    const { root } = loader.loadJson('{"metadata.root":{}}');
    expect(root.isFrozen()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Custom registry
// ---------------------------------------------------------------------------

describe("Loader — custom registry", () => {
  it("passing an empty registry causes parse to fail with errors (metadata type unknown)", () => {
    const emptyRegistry = new TypeRegistry();
    const loader = new Loader({ registry: emptyRegistry });
    // In non-strict mode, unknown ROOT type still throws (per parser spec for root type).
    const { errors } = loader.loadJson('{"metadata.root":{}}');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBeInstanceOf(ParseError);
  });

  it("custom registry with extra type recognizes that type in JSON", () => {
    // Register only metadata + a custom 'widget' type.
    const registry = new TypeRegistry();
    registerCoreTypes(registry);
    registry.register({
      typeId: new TypeId("widget", "base"),
      description: "A widget",
      factory: (typeId, name) => new MetaObject(typeId, name),
      childRules: [],
    });

    const json = JSON.stringify({
      "metadata.root": {
        children: [{ "widget.base": { name: "MyWidget" } }],
      },
    });

    const loader = new Loader({ registry });
    const { root, errors, warnings } = loader.loadJson(json);
    expect(errors.length).toBe(0);
    // No warnings about unknown widget type
    const unknownWarnings = warnings.filter((w) => w.includes("Unknown"));
    expect(unknownWarnings.length).toBe(0);
    expect(root.childByTypeAndName("widget", "MyWidget")).toBeDefined();
  });

  it("using the default registry pre-populates core types", () => {
    const loader = new Loader(); // no opts — uses default registry with core types
    const json = JSON.stringify({
      "metadata.root": {
        children: [{ "object.base": { name: "Entity" } }],
      },
    });
    const { errors, warnings } = loader.loadJson(json);
    expect(errors.length).toBe(0);
    const unknownWarnings = warnings.filter((w) => w.includes("Unknown"));
    expect(unknownWarnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. Missing file handling
// ---------------------------------------------------------------------------

describe("Loader.load — missing file", () => {
  it("errors[] contains the read failure; does not throw", async () => {
    const loader = new Loader();
    const result = await loader.load(["/nonexistent/totally/missing.json"]);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("result has a synthetic root when all files fail", async () => {
    const loader = new Loader();
    const result = await loader.load(["/nonexistent/totally/missing.json"]);
    expect(result.root).toBeDefined();
    expect(result.root.type).toBe(TYPE_METADATA);
    expect(result.root.subType).toBe(SUBTYPE_ROOT);
  });

  it("warnings is empty when no files could be read", async () => {
    const loader = new Loader();
    const result = await loader.load(["/nonexistent/totally/missing.json"]);
    expect(result.warnings.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 10. Multiple-file load with mid-file error
// ---------------------------------------------------------------------------

describe("Loader.loadJsonStrings — mid-source parse error", () => {
  const validJson = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [{ "object.base": { name: "Store" } }],
    },
  });

  const invalidJson = "{ this is not valid json !!";

  it("errors[] has a ParseError from the invalid second source", () => {
    const loader = new Loader();
    const { errors } = loader.loadJsonStrings([
      { content: validJson, sourceName: "valid.json" },
      { content: invalidJson, sourceName: "invalid.json" },
    ]);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toBeInstanceOf(ParseError);
  });

  it("first file still parsed; Store is in the result", () => {
    const loader = new Loader();
    const { root } = loader.loadJsonStrings([
      { content: validJson, sourceName: "valid.json" },
      { content: invalidJson, sourceName: "invalid.json" },
    ]);
    expect(root.childByTypeAndName(TYPE_OBJECT, "Store")).toBeDefined();
  });

  it("partial result is returned (root from valid first file)", () => {
    const loader = new Loader();
    const { root } = loader.loadJsonStrings([
      { content: validJson, sourceName: "valid.json" },
      { content: invalidJson, sourceName: "invalid.json" },
    ]);
    expect(root.type).toBe(TYPE_METADATA);
  });
});

// ---------------------------------------------------------------------------
// 11. Strict mode
// ---------------------------------------------------------------------------

describe("Loader — strict mode", () => {
  it("strict: true + unknown non-@-prefixed key → error collected (not thrown)", () => {
    const loader = new Loader({ strict: true });
    // "unknownKey" is not reserved and not @-prefixed — strict rejects it
    const json = JSON.stringify({
      "metadata.root": { package: "test", unknownKey: "value" },
    });
    const { errors } = loader.loadJson(json);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("strict: true + unknown @-prefixed attr is fine (attrs are always accepted)", () => {
    const loader = new Loader({ strict: true });
    // @-prefixed keys are inline attrs and are always accepted
    const json = JSON.stringify({
      "metadata.root": { package: "test", "@myAttr": "value" },
    });
    const { errors } = loader.loadJson(json);
    expect(errors.length).toBe(0);
  });

  it("strict: false (default) + unknown key → warning, not error", () => {
    const loader = new Loader({ strict: false });
    const json = JSON.stringify({
      "metadata.root": { package: "test", unknownKey: "value" },
    });
    const { errors, warnings } = loader.loadJson(json);
    expect(errors.length).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 12. Round-trip integration on real fixtures
// ---------------------------------------------------------------------------

describe("Loader — round-trip integration: acme-vehicle base + overlay", () => {
  it("loads all three fixture files in dependency order without errors", async () => {
    const loader = new Loader({ freeze: false }); // freeze:false so we can inspect
    const result = await loader.load([
      fixturePath("acme-common-metadata.json"),
      fixturePath("acme-vehicle-metadata.json"),
      fixturePath("acme-vehicle-overlay-metadata.json"),
    ]);
    expect(result.errors.length).toBe(0);
  });

  it("base entity (Car) is present in merged result", async () => {
    const loader = new Loader({ freeze: false });
    const { root } = await loader.load([
      fixturePath("acme-common-metadata.json"),
      fixturePath("acme-vehicle-metadata.json"),
      fixturePath("acme-vehicle-overlay-metadata.json"),
    ]);
    expect(root.childByTypeAndName(TYPE_OBJECT, "Car")).toBeDefined();
  });

  it("overlay entity (Porsche) still present after merge", async () => {
    const loader = new Loader({ freeze: false });
    const { root } = await loader.load([
      fixturePath("acme-common-metadata.json"),
      fixturePath("acme-vehicle-metadata.json"),
      fixturePath("acme-vehicle-overlay-metadata.json"),
    ]);
    // Porsche is in the base; the overlay adds to it
    expect(root.childByTypeAndName(TYPE_OBJECT, "Porsche")).toBeDefined();
  });

  it("overlay adds new field (premiumLocation) to Garage entity", async () => {
    const loader = new Loader({ freeze: false });
    const { root } = await loader.load([
      fixturePath("acme-common-metadata.json"),
      fixturePath("acme-vehicle-metadata.json"),
      fixturePath("acme-vehicle-overlay-metadata.json"),
    ]);
    const garage = root.childByTypeAndName(TYPE_OBJECT, "Garage")!;
    expect(garage).toBeDefined();
    expect(garage.childByTypeAndName(TYPE_FIELD, "premiumLocation")).toBeDefined();
  });

  it("overlay adds new field (warranty) to Vehicle entity", async () => {
    const loader = new Loader({ freeze: false });
    const { root } = await loader.load([
      fixturePath("acme-common-metadata.json"),
      fixturePath("acme-vehicle-metadata.json"),
      fixturePath("acme-vehicle-overlay-metadata.json"),
    ]);
    const vehicle = root.childByTypeAndName(TYPE_OBJECT, "Vehicle")!;
    expect(vehicle.childByTypeAndName(TYPE_FIELD, "warranty")).toBeDefined();
  });

  it("overlay adds certifiedPreOwned to Porsche entity", async () => {
    const loader = new Loader({ freeze: false });
    const { root } = await loader.load([
      fixturePath("acme-common-metadata.json"),
      fixturePath("acme-vehicle-metadata.json"),
      fixturePath("acme-vehicle-overlay-metadata.json"),
    ]);
    const porsche = root.childByTypeAndName(TYPE_OBJECT, "Porsche")!;
    expect(porsche.childByTypeAndName(TYPE_FIELD, "certifiedPreOwned")).toBeDefined();
  });

  it("no warnings about duplicate children (overlay uses merge: true)", async () => {
    const loader = new Loader({ freeze: false });
    const { warnings } = await loader.load([
      fixturePath("acme-common-metadata.json"),
      fixturePath("acme-vehicle-metadata.json"),
      fixturePath("acme-vehicle-overlay-metadata.json"),
    ]);
    const duplicateWarnings = warnings.filter((w) => w.includes("merge: true"));
    expect(duplicateWarnings.length).toBe(0);
  });

  it("root is frozen after default load", async () => {
    const loader = new Loader(); // freeze: true (default)
    const { root } = await loader.load([
      fixturePath("acme-common-metadata.json"),
      fixturePath("acme-vehicle-metadata.json"),
      fixturePath("acme-vehicle-overlay-metadata.json"),
    ]);
    expect(root.isFrozen()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 13. loadJson convenience vs loadJsonStrings
// ---------------------------------------------------------------------------

describe("Loader.loadJson — convenience vs loadJsonStrings", () => {
  const json = JSON.stringify({
    "metadata.root": {
      package: "demo",
      children: [{ "object.base": { name: "Widget", "@color": "red" } }],
    },
  });

  it("loadJson produces same root type as loadJsonStrings", () => {
    // One-shot Loader contract: use separate instances per load
    const r1 = new Loader({ freeze: false }).loadJson(json, "demo.json");
    const r2 = new Loader({ freeze: false }).loadJsonStrings([{ content: json, sourceName: "demo.json" }]);
    expect(r1.root.type).toBe(r2.root.type);
    expect(r1.root.subType).toBe(r2.root.subType);
    expect(r1.root.package).toBe(r2.root.package);
  });

  it("loadJson produces same children as loadJsonStrings", () => {
    const r1 = new Loader({ freeze: false }).loadJson(json, "demo.json");
    const r2 = new Loader({ freeze: false }).loadJsonStrings([{ content: json, sourceName: "demo.json" }]);
    expect(r1.root.children().length).toBe(r2.root.children().length);
    expect(r1.root.childByTypeAndName(TYPE_OBJECT, "Widget")).toBeDefined();
    expect(r2.root.childByTypeAndName(TYPE_OBJECT, "Widget")).toBeDefined();
  });

  it("Loader rejects re-use after a load completes", () => {
    const loader = new Loader({ freeze: false });
    loader.loadJson(json, "first.json");
    expect(() => loader.loadJson(json, "second.json")).toThrow(/cannot be reused/);
    expect(() => loader.loadJsonStrings([{ content: json }])).toThrow(/cannot be reused/);
  });

  it("Loader rejects re-use after a failed (error state) load", () => {
    const loader = new Loader({ freeze: false });
    loader.loadJson("not json"); // → "error" state
    expect(() => loader.loadJson(json)).toThrow(/cannot be reused/);
  });

  it("Synthetic root from failed load is frozen when freeze: true (default)", () => {
    const loader = new Loader();
    const result = loader.loadJsonStrings([{ content: "bad json" }]);
    expect(result.root.isFrozen()).toBe(true);
    expect(() => result.root.setAttr("x", "y")).toThrow();
  });

  it("Synthetic root from failed load is mutable when freeze: false", () => {
    const loader = new Loader({ freeze: false });
    const result = loader.loadJsonStrings([{ content: "bad json" }]);
    expect(result.root.isFrozen()).toBe(false);
    result.root.setAttr("x", "y");
    expect(result.root.attr("x")).toBe("y");
  });

  it("loadJson with no sourceName works fine", () => {
    const loader = new Loader({ freeze: false });
    const { root, errors } = loader.loadJson(json);
    expect(errors.length).toBe(0);
    expect(root).toBeDefined();
  });

  it("loadJson passes sourceName through (appears in errors when parse fails)", () => {
    const loader = new Loader();
    const { errors } = loader.loadJson("not json", "my-source.json");
    expect(errors.length).toBeGreaterThan(0);
    // The ParseError should reference the source name
    const pe = errors[0] as ParseError;
    expect(pe.source).toBe("my-source.json");
  });
});

// ---------------------------------------------------------------------------
// 14. First file NOT marked overlay; subsequent file also NOT marked overlay
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 14. Multi-file load: second file merged into first (no merge: true concept)
// ---------------------------------------------------------------------------
//
// Java has no "overlay file" marker. Each file is parsed into the accumulating
// root sequentially. The per-node overlay/override flags control merge behavior
// at the node level, not at the file level.

describe("Loader.loadJsonStrings — multiple sources always merged sequentially", () => {
  const baseJson = JSON.stringify({
    "metadata.root": {
      package: "acme",
      children: [{ "object.base": { name: "Alpha" } }],
    },
  });

  const secondJson = JSON.stringify({
    "metadata.root": {
      package: "acme",
      // No merge: true — Java has no such file-level marker
      children: [{ "object.base": { name: "Beta" } }],
    },
  });

  it("merges the second source into the first (no special marker needed)", () => {
    const loader = new Loader({ freeze: false });
    const { root } = loader.loadJsonStrings([
      { content: baseJson, sourceName: "base.json" },
      { content: secondJson, sourceName: "second.json" },
    ]);
    expect(root.childByTypeAndName(TYPE_OBJECT, "Alpha")).toBeDefined();
    expect(root.childByTypeAndName(TYPE_OBJECT, "Beta")).toBeDefined();
  });

  it("no errors for well-formed JSON when loading multiple sources", () => {
    const loader = new Loader({ freeze: false });
    const { errors } = loader.loadJsonStrings([
      { content: baseJson, sourceName: "base.json" },
      { content: secondJson, sourceName: "second.json" },
    ]);
    expect(errors.length).toBe(0);
  });

  it("result has exactly two children after two-source load", () => {
    const loader = new Loader({ freeze: false });
    const { root } = loader.loadJsonStrings([
      { content: baseJson, sourceName: "base.json" },
      { content: secondJson, sourceName: "second.json" },
    ]);
    expect(root.children().length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases
// ---------------------------------------------------------------------------

describe("Loader — additional edge cases", () => {
  it("BOM-prefixed JSON parses correctly", () => {
    const loader = new Loader();
    // Prepend UTF-8 BOM (U+FEFF)
    const jsonWithBOM = "﻿" + JSON.stringify({ "metadata.root": { package: "bom-test" } });
    const { root, errors } = loader.loadJson(jsonWithBOM, "bom.json");
    expect(errors.length).toBe(0);
    expect(root.package).toBe("bom-test");
  });

  it("loadJsonStrings with empty sources array returns synthetic root", () => {
    const loader = new Loader();
    const { root, errors, warnings } = loader.loadJsonStrings([]);
    expect(root.type).toBe(TYPE_METADATA);
    expect(root.subType).toBe(SUBTYPE_ROOT);
    expect(errors.length).toBe(0);
    expect(warnings.length).toBe(0);
  });

  it("load with empty paths array returns synthetic root without errors", async () => {
    const loader = new Loader();
    const { root, errors } = await loader.load([]);
    expect(root.type).toBe(TYPE_METADATA);
    expect(errors.length).toBe(0);
  });

  it("multiple missing files all get errors collected", async () => {
    const loader = new Loader();
    const result = await loader.load([
      "/nonexistent/a.json",
      "/nonexistent/b.json",
    ]);
    expect(result.errors.length).toBe(2);
    expect(result.root.type).toBe(TYPE_METADATA);
  });

  it("one valid file + one missing file: valid file is parsed, missing file adds error", async () => {
    const loader = new Loader({ freeze: false });
    const result = await loader.load([
      fixturePath("fruitbasket-metadata.json"),
      "/nonexistent/missing.json",
    ]);
    // The one successful read + the one missing
    expect(result.errors.length).toBe(1);
    expect(result.root.children().length).toBeGreaterThan(0);
  });

  it("warnings are propagated from the parser", () => {
    const loader = new Loader({ strict: false }); // non-strict: warnings not errors
    const json = JSON.stringify({
      "metadata.root": { package: "x", unknownKey: "val" },
    });
    const { warnings, errors } = loader.loadJson(json);
    expect(errors.length).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain("unknownKey");
  });

  it("unresolvable super ref produces a ParseError in errors[] (not a warning)", () => {
    const loader = new Loader({ freeze: false });
    const json = JSON.stringify({
      "metadata.root": {
        children: [{ "object.base": { name: "Widget", extends: "NonExistentBase" } }],
      },
    });
    // Java throws on missing super — the loader catches it and puts it in errors[].
    const { errors, warnings } = loader.loadJson(json);
    expect(errors.length).toBeGreaterThan(0);
    const parseErrors = errors.filter((e) => e.name === "ParseError");
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(parseErrors[0]!.message).toContain("NonExistentBase");
    // No "Could not resolve" warning — super resolution now throws
    const superWarnings = warnings.filter((w) => w.includes("Could not resolve"));
    expect(superWarnings.length).toBe(0);
  });

  it("Loader instances are independent (separate registries)", () => {
    const loader1 = new Loader();
    const loader2 = new Loader();
    const json = '{"metadata.root":{}}';
    const r1 = loader1.loadJson(json);
    const r2 = loader2.loadJson(json);
    expect(r1.root.type).toBe(r2.root.type);
    // Each has its own registry — no cross-contamination
    expect(r1.errors.length).toBe(0);
    expect(r2.errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Loader lifecycle state machine and convenience accessors
// ---------------------------------------------------------------------------

describe("Loader — lifecycle state machine", () => {
  it("state is 'uninitialized' before any load call", () => {
    const loader = new Loader();
    expect(loader.state).toBe("uninitialized");
  });

  it("state is 'loaded' after loadJson", () => {
    const loader = new Loader();
    loader.loadJson('{"metadata.root":{}}');
    expect(loader.state).toBe("loaded");
  });

  it("state is 'loaded' after loadJsonStrings", () => {
    const loader = new Loader();
    loader.loadJsonStrings([{ content: '{"metadata.root":{}}' }]);
    expect(loader.state).toBe("loaded");
  });

  it("state is 'loaded' after load() resolves", async () => {
    const loader = new Loader();
    await loader.load([]);
    expect(loader.state).toBe("loaded");
  });

  it("root getter returns the loaded root after loading", () => {
    const loader = new Loader();
    const { root: result } = loader.loadJson('{"metadata.root":{"package":"demo"}}');
    expect(loader.root).toBe(result);
    expect(loader.root.package).toBe("demo");
  });

  it("root getter throws before loading (checkState guard)", () => {
    const loader = new Loader();
    expect(() => loader.root).toThrow();
  });
});

describe("Loader — convenience accessors (findByName, findByTypeAndName, childrenOfType)", () => {
  it("findByName returns the child with that name", () => {
    const loader = new Loader({ freeze: false });
    loader.loadJson(
      JSON.stringify({
        "metadata.root": {
          children: [{ "object.entity": { name: "Store" } }],
        },
      }),
    );
    expect(loader.findByName("Store")).toBeDefined();
    expect(loader.findByName("Store")!.name).toBe("Store");
  });

  it("findByName returns undefined when not found", () => {
    const loader = new Loader({ freeze: false });
    loader.loadJson('{"metadata.root":{}}');
    expect(loader.findByName("Missing")).toBeUndefined();
  });

  it("findByTypeAndName returns the child with that (type, name)", () => {
    const loader = new Loader({ freeze: false });
    loader.loadJson(
      JSON.stringify({
        "metadata.root": {
          children: [{ "object.entity": { name: "Widget" } }],
        },
      }),
    );
    expect(loader.findByTypeAndName(TYPE_OBJECT, "Widget")).toBeDefined();
  });

  it("childrenOfType returns all children of that type", () => {
    const loader = new Loader({ freeze: false });
    loader.loadJson(
      JSON.stringify({
        "metadata.root": {
          children: [
            { "object.entity": { name: "A" } },
            { "object.entity": { name: "B" } },
            { [`field.${FIELD_SUBTYPE_STRING}`]: { name: "x" } },
          ],
        },
      }),
    );
    const objects = loader.childrenOfType(TYPE_OBJECT);
    expect(objects.length).toBe(2);
    expect(objects.map((o) => o.name)).toContain("A");
    expect(objects.map((o) => o.name)).toContain("B");
  });

  it("findByName throws when called before loading", () => {
    const loader = new Loader();
    expect(() => loader.findByName("X")).toThrow();
  });

  it("findByTypeAndName throws when called before loading", () => {
    const loader = new Loader();
    expect(() => loader.findByTypeAndName(TYPE_OBJECT, "X")).toThrow();
  });

  it("childrenOfType throws when called before loading", () => {
    const loader = new Loader();
    expect(() => loader.childrenOfType(TYPE_OBJECT)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Loader.registry getter
// ---------------------------------------------------------------------------

describe("Loader.registry getter", () => {
  it("returns the registry passed in via constructor", () => {
    const customRegistry = new TypeRegistry();
    registerCoreTypes(customRegistry);
    const loader = new Loader({ registry: customRegistry });
    expect(loader.registry).toBe(customRegistry);
  });

  it("returns the default registry when none was passed", () => {
    const loader = new Loader();
    expect(loader.registry).toBeInstanceOf(TypeRegistry);
    // Default should have core types pre-registered
    expect(loader.registry.has("object", "base")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadFromDirectory
// ---------------------------------------------------------------------------

describe("loadFromDirectory", () => {
  test("loads all .json files in a directory and merges them into one MetaModel", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metadata-loaddir-"));
    try {
      writeFileSync(
        join(dir, "common.json"),
        JSON.stringify({
          "metadata.root": {
            package: "test::common",
            children: [
              { "field.long": { name: "id", abstract: true } },
            ],
          },
        }),
      );
      writeFileSync(
        join(dir, "domain.json"),
        JSON.stringify({
          "metadata.root": {
            package: "test",
            children: [
              {
                "object.entity": {
                  name: "User",
                  children: [{ "field.long": { name: "id", extends: "::test::common::id" } }],
                },
              },
            ],
          },
        }),
      );

      const loader = new Loader();
      const result = await loader.loadFromDirectory(dir);

      expect(result.errors).toHaveLength(0);
      const user = result.root.children().find((c) => c.name === "User");
      expect(user).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("excludes filenames matching exclude glob", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metadata-loaddir-exclude-"));
    try {
      writeFileSync(
        join(dir, "main.json"),
        JSON.stringify({
          "metadata.root": {
            package: "test",
            children: [
              { "object.entity": { name: "Main", children: [] } },
            ],
          },
        }),
      );
      writeFileSync(
        join(dir, "draft.json"),
        JSON.stringify({
          "metadata.root": {
            package: "test::draft",
            children: [
              { "object.entity": { name: "Draft", children: [] } },
            ],
          },
        }),
      );

      const loader = new Loader();
      const result = await loader.loadFromDirectory(dir, { exclude: ["draft*"] });

      expect(result.errors).toHaveLength(0);
      // Main loaded, Draft excluded
      const names = result.root.children().map((c) => c.name);
      expect(names).toContain("Main");
      expect(names).not.toContain("Draft");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns empty root when directory has no .json files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metadata-loaddir-empty-"));
    try {
      const loader = new Loader();
      const result = await loader.loadFromDirectory(dir);
      expect(result.errors).toHaveLength(0);
      expect(result.root.children()).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Regression: legacy @dbTable attr is no longer promoted
// ---------------------------------------------------------------------------

describe("Loader — legacy @dbTable attr is NOT promoted (dropped in v0.3)", () => {
  test("@dbTable attr on an entity does not synthesize a source[dbTable] child", () => {
    const result = new Loader().loadJson(JSON.stringify({
      "metadata.root": { children: [
        { "object.entity": { name: "Program", "@dbTable": "programs",
          children: [
            { "field.long": { name: "id" } },
            { "identity.primary": { "@fields": "id" } },
          ],
        }},
      ]},
    }));
    const program = result.root.children().find((o) => o.name === "Program");
    const sources = program?.children().filter((c) => c.type === TYPE_SOURCE) ?? [];
    expect(sources.length).toBe(0);  // NO source[dbTable] synthesized
  });
});
