import { describe, it, expect } from "bun:test";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { TYPE_ATTR, ATTR_SUBTYPE_FILTER, ATTR_SUBTYPES } from "../src/index.js";
import { DATA_TYPE_OBJECT } from "../src/data-type.js";

describe("attr.filter subtype", () => {
  it("is in ATTR_SUBTYPES", () => {
    expect(ATTR_SUBTYPES).toContain(ATTR_SUBTYPE_FILTER);
  });

  it("registers with DATA_TYPE_OBJECT", () => {
    const registry = composeRegistry(coreProviders);
    const def = registry.find(TYPE_ATTR, ATTR_SUBTYPE_FILTER);
    expect(def).toBeDefined();
    expect(def?.dataType).toBe(DATA_TYPE_OBJECT);
  });
});
