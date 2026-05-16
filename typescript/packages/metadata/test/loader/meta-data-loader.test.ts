import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { TypeRegistry } from "../../src/registry.js";
import { TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY } from "../../src/constants.js";

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
