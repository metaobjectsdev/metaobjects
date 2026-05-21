import { test, expect } from "bun:test";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";

function coreRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  return registry;
}

test("registerCoreTypes designates metadata → root as the default subType", () => {
  expect(coreRegistry().defaultSubTypeOf("metadata")).toBe("root");
});

test("registerCoreTypes designates object → entity as the default subType", () => {
  expect(coreRegistry().defaultSubTypeOf("object")).toBe("entity");
});

test("registerCoreTypes designates no default for field (subtype always explicit)", () => {
  expect(coreRegistry().defaultSubTypeOf("field")).toBeUndefined();
});
