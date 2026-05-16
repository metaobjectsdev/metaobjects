import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { InMemorySource, FileSource } from "../../src/loader/meta-data-source.js";
import { MetaRoot } from "../../src/meta/meta-root.js";
import { TypeRegistry } from "../../src/registry.js";
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
