import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { TYPE_FIELD, FIELD_SUBTYPE_STRING } from "../../src/constants.js";

describe("MetaDataLoader — default registry", () => {
  it("a loader with no supplied registry has the core metamodel registered", () => {
    const loader = new MetaDataLoader();
    expect(loader.registry.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(true);
  });
});
