import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { InMemorySource, FileSource } from "../../src/loader/meta-data-source.js";
import { MetaRoot } from "../../src/meta/meta-root.js";
import { TypeRegistry } from "../../src/registry.js";
import { ParseError } from "../../src/errors.js";
import {
  TYPE_METADATA, SUBTYPE_ROOT,
  TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY,
} from "../../src/constants.js";

// ---------------------------------------------------------------------------
// Lifecycle skeleton (pre-load)
// ---------------------------------------------------------------------------

describe("MetaDataLoader — lifecycle skeleton", () => {
  it("starts in 'uninitialized' state", () => {
    const loader = new MetaDataLoader();
    expect(loader.state).toBe("uninitialized");
  });

  it("accessing .root before load throws", () => {
    const loader = new MetaDataLoader();
    expect(() => loader.root).toThrow();
  });

  it(".registry returns a TypeRegistry populated with core types", () => {
    const loader = new MetaDataLoader();
    expect(loader.registry).toBeInstanceOf(TypeRegistry);
    expect(loader.registry.has(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)).toBe(true);
  });

  it("custom registry passed via constructor is returned by .registry", () => {
    const registry = new TypeRegistry();
    const loader = new MetaDataLoader({ registry });
    expect(loader.registry).toBe(registry);
  });
});

// ---------------------------------------------------------------------------
// load() — happy path
// ---------------------------------------------------------------------------

describe("MetaDataLoader.load() — happy path", () => {
  it("minimal metadata.root → state 'loaded', root is MetaRoot, no errors, no warnings", async () => {
    const loader = new MetaDataLoader();
    const result = await loader.load([
      new InMemorySource('{"metadata.root":{"children":[]}}'),
    ]);
    expect(loader.state).toBe("loaded");
    expect(result.root).toBeInstanceOf(MetaRoot);
    expect(result.root.type).toBe(TYPE_METADATA);
    expect(result.root.subType).toBe(SUBTYPE_ROOT);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("returns the root name when set", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([
      new InMemorySource('{"metadata.root":{"name":"myRoot"}}'),
    ]);
    expect(root.name).toBe("myRoot");
  });

  it("root is frozen by default", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([
      new InMemorySource('{"metadata.root":{}}'),
    ]);
    expect(root.isFrozen()).toBe(true);
  });

  it("freeze: false leaves the root mutable", async () => {
    const loader = new MetaDataLoader({ freeze: false });
    const { root } = await loader.load([
      new InMemorySource('{"metadata.root":{}}'),
    ]);
    expect(root.isFrozen()).toBe(false);
  });

  it("entity child is accessible via findByName after load", async () => {
    const loader = new MetaDataLoader();
    const json = JSON.stringify({
      "metadata.root": {
        package: "test",
        children: [{ "object.entity": { name: "Product" } }],
      },
    });
    await loader.load([new InMemorySource(json)]);
    const found = loader.findByName("Product");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Product");
    expect(found!.type).toBe(TYPE_OBJECT);
    expect(found!.subType).toBe(OBJECT_SUBTYPE_ENTITY);
  });
});

// ---------------------------------------------------------------------------
// load() — error handling
// ---------------------------------------------------------------------------

describe("MetaDataLoader.load() — error handling", () => {
  it("malformed JSON source → errors non-empty, still returns a result", async () => {
    const loader = new MetaDataLoader();
    const result = await loader.load([
      new InMemorySource("this is not json at all"),
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.root).toBeInstanceOf(MetaRoot);
  });

  it("source whose read() rejects → error collected, pipeline still completes", async () => {
    const loader = new MetaDataLoader();
    const badSource = new FileSource("/nonexistent/path/that/does/not/exist.json");
    const result = await loader.load([badSource]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.root).toBeInstanceOf(MetaRoot);
  });

  it("failing source + valid source → error collected, valid content still loads", async () => {
    const loader = new MetaDataLoader();
    const badSource = new FileSource("/nonexistent/path/that/does/not/exist.json");
    const goodJson = JSON.stringify({
      "metadata.root": {
        package: "test",
        children: [{ "object.entity": { name: "Widget" } }],
      },
    });
    const goodSource = new InMemorySource(goodJson, { id: "good.json" });
    const result = await loader.load([badSource, goodSource]);
    // The read error is collected
    expect(result.errors.length).toBeGreaterThan(0);
    // But the valid source still parsed
    expect(loader.state).toBe("loaded");
    const found = loader.findByName("Widget");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Widget");
  });
});

// ---------------------------------------------------------------------------
// load() — one-shot guard
// ---------------------------------------------------------------------------

describe("MetaDataLoader.load() — one-shot guard", () => {
  it("calling load() twice throws on the second call", async () => {
    const loader = new MetaDataLoader();
    await loader.load([new InMemorySource('{"metadata.root":{}}')]);
    expect(loader.state).toBe("loaded");
    await expect(
      loader.load([new InMemorySource('{"metadata.root":{}}')]),
    ).rejects.toThrow();
  });

  it("one-shot guard fires even after error state", async () => {
    const loader = new MetaDataLoader();
    // Load with a single bad source — all sources fail → synthetic root → "error"
    await loader.load([new FileSource("/does/not/exist.json")]);
    // Single failing source: read error collected, synthetic root created → state is deterministically "error"
    expect(loader.state).toBe("error");
    await expect(
      loader.load([new InMemorySource('{"metadata.root":{}}')]),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// load() — multi-source merge
// ---------------------------------------------------------------------------

describe("MetaDataLoader.load() — multi-source merge", () => {
  it("two sources with different entities are both present after load", async () => {
    const loader = new MetaDataLoader();
    const src1 = new InMemorySource(
      JSON.stringify({
        "metadata.root": {
          package: "test",
          children: [{ "object.entity": { name: "Alpha" } }],
        },
      }),
      { id: "src1.json" },
    );
    const src2 = new InMemorySource(
      JSON.stringify({
        "metadata.root": {
          package: "test",
          children: [{ "object.entity": { name: "Beta" } }],
        },
      }),
      { id: "src2.json" },
    );
    const result = await loader.load([src1, src2]);
    expect(result.errors).toHaveLength(0);
    expect(loader.findByName("Alpha")).toBeDefined();
    expect(loader.findByName("Beta")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Accessor methods throw when not yet loaded
// ---------------------------------------------------------------------------

describe("MetaDataLoader — accessor guards", () => {
  it("findByName throws before load", () => {
    const loader = new MetaDataLoader();
    expect(() => loader.findByName("Foo")).toThrow();
  });

  it("findByTypeAndName throws before load", () => {
    const loader = new MetaDataLoader();
    expect(() => loader.findByTypeAndName(TYPE_OBJECT, "Foo")).toThrow();
  });

  it("childrenOfType throws before load", () => {
    const loader = new MetaDataLoader();
    expect(() => loader.childrenOfType(TYPE_OBJECT)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Additional edge cases ported from the monolithic loader.test.ts
// ---------------------------------------------------------------------------

describe("MetaDataLoader — BOM-prefixed JSON", () => {
  it("parses BOM-prefixed JSON correctly", async () => {
    const loader = new MetaDataLoader();
    // Prepend UTF-8 BOM (U+FEFF)
    const jsonWithBOM = "﻿" + JSON.stringify({ "metadata.root": { package: "bom-test" } });
    const result = await loader.load([new InMemorySource(jsonWithBOM, { id: "bom.json" })]);
    expect(result.errors.length).toBe(0);
    expect(result.root.package).toBe("bom-test");
  });
});

describe("MetaDataLoader — empty sources array", () => {
  it("returns synthetic root with no errors or warnings", async () => {
    const loader = new MetaDataLoader();
    const result = await loader.load([]);
    expect(result.root.type).toBe(TYPE_METADATA);
    expect(result.root.subType).toBe(SUBTYPE_ROOT);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBe(0);
  });

  it("empty root has no children", async () => {
    const loader = new MetaDataLoader();
    const result = await loader.load([]);
    expect(result.root.children().length).toBe(0);
  });
});

describe("MetaDataLoader — multiple missing sources", () => {
  it("collects one error per missing source", async () => {
    const loader = new MetaDataLoader();
    const result = await loader.load([
      new FileSource("/nonexistent/a.json"),
      new FileSource("/nonexistent/b.json"),
    ]);
    expect(result.errors.length).toBe(2);
    expect(result.root.type).toBe(TYPE_METADATA);
  });
});

describe("MetaDataLoader — warnings propagated from parser", () => {
  it("non-strict loader propagates unknown-key warnings", async () => {
    const loader = new MetaDataLoader({ strict: false });
    const json = JSON.stringify({
      "metadata.root": { package: "x", unknownKey: "val" },
    });
    const result = await loader.load([new InMemorySource(json)]);
    expect(result.errors.length).toBe(0);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("unknownKey");
  });
});

describe("MetaDataLoader — unresolvable super ref produces ParseError", () => {
  it("unresolvable extends ref → ParseError in errors[], no warning", async () => {
    const loader = new MetaDataLoader({ freeze: false });
    const json = JSON.stringify({
      "metadata.root": {
        children: [{ "object.base": { name: "Widget", extends: "NonExistentBase" } }],
      },
    });
    const result = await loader.load([new InMemorySource(json)]);
    expect(result.errors.length).toBeGreaterThan(0);
    const parseErrors = result.errors.filter((e) => e instanceof ParseError);
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(parseErrors[0]!.message).toContain("NonExistentBase");
    const superWarnings = result.warnings.filter((w) => w.includes("Could not resolve"));
    expect(superWarnings.length).toBe(0);
  });
});

describe("MetaDataLoader — independent instances", () => {
  it("two loader instances do not share state", async () => {
    const loader1 = new MetaDataLoader();
    const loader2 = new MetaDataLoader();
    const json = '{"metadata.root":{}}';
    const r1 = await loader1.load([new InMemorySource(json)]);
    const r2 = await loader2.load([new InMemorySource(json)]);
    expect(r1.root.type).toBe(r2.root.type);
    expect(r1.errors.length).toBe(0);
    expect(r2.errors.length).toBe(0);
  });
});

describe("MetaDataLoader — InMemorySource id propagates to ParseError.source", () => {
  it("source id appears in ParseError.source when parse fails", async () => {
    const loader = new MetaDataLoader();
    const result = await loader.load([
      new InMemorySource("not json", { id: "my-source.json" }),
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    const pe = result.errors[0] as ParseError;
    expect(pe.source).toBe("my-source.json");
  });
});
