import { describe, it, expect } from "bun:test";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import {
  TYPE_FIELD,
  FIELD_SUBTYPE_STRING,
  TYPE_OBJECT,
  OBJECT_SUBTYPE_ENTITY,
  TYPE_VALIDATOR,
  VALIDATOR_SUBTYPE_REQUIRED,
  TYPE_METADATA,
  SUBTYPE_ROOT,
} from "../../src/constants.js";

describe("MetaDataLoader — default registry", () => {
  it("a loader with no supplied registry is composed from the core providers", () => {
    const registry = new MetaDataLoader().registry;
    // representative types across domains are registered
    expect(registry.has(TYPE_FIELD, FIELD_SUBTYPE_STRING)).toBe(true);
    expect(registry.has(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY)).toBe(true);
    expect(registry.has(TYPE_VALIDATOR, VALIDATOR_SUBTYPE_REQUIRED)).toBe(true);
    expect(registry.has(TYPE_METADATA, SUBTYPE_ROOT)).toBe(true);
    // default subtypes (set by the core provider) are present
    expect(registry.defaultSubTypeOf(TYPE_METADATA)).toBe(SUBTYPE_ROOT);
  });
});
