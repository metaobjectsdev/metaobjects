import { test, expect } from "bun:test";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { parseYaml } from "../src/core/parser-yaml.js";
import { TYPE_METADATA, TYPE_FIELD } from "../src/index.js";

function coreRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  return registry;
}

test("parseYaml: loads an authoring document into a typed tree", () => {
  const yaml = `
metadata:
  package: acme::shop
  children:
    - object:
        name: Product
        children:
          - field.string: sku
`;
  const result = parseYaml(yaml, { registry: coreRegistry() });
  expect(result.errors).toEqual([]);
  expect(result.root.type).toBe(TYPE_METADATA);

  const product = result.root.ownChildren()[0]!;
  expect(product.name).toBe("Product");

  const sku = product.ownChildren()[0]!;
  expect(sku.type).toBe(TYPE_FIELD);
  expect(sku.name).toBe("sku");
});

test("parseYaml: the [] suffix produces an array field", () => {
  const yaml = `
metadata:
  children:
    - object:
        name: Program
        children:
          - field.long[]: weekIds
`;
  const result = parseYaml(yaml, { registry: coreRegistry() });
  expect(result.errors).toEqual([]);
  const field = result.root.ownChildren()[0]!.ownChildren()[0]!;
  expect(field.name).toBe("weekIds");
  expect(field.isArray).toBe(true);
});

test("parseYaml: a YAML syntax error throws a ParseError", () => {
  expect(() => parseYaml("metadata: [unclosed", { registry: coreRegistry() })).toThrow();
});

test("parseYaml: a desugar error is collected, not thrown", () => {
  const yaml = `
metadata:
  children:
    - object:
        name: Program
        children:
          - field: sku
`;
  const result = parseYaml(yaml, { registry: coreRegistry() });
  expect(result.errors.length).toBeGreaterThan(0);
});
