import { test, expect } from "bun:test";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { parseJson } from "../src/parser-json.js";
import { parseYaml } from "../src/core/parser-yaml.js";
import { canonicalSerialize } from "../src/serializer-json.js";

function coreRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  return registry;
}

// Asserts the authoring YAML and the canonical JSON load to byte-identical
// trees. Each parser gets its own fresh registry so neither can see the
// other's mutations.
function assertEquivalent(json: string, yaml: string): void {
  const jsonResult = parseJson(json, { registry: coreRegistry() });
  const yamlResult = parseYaml(yaml, { registry: coreRegistry() });
  expect(jsonResult.errors).toEqual([]);
  expect(yamlResult.errors).toEqual([]);
  expect(canonicalSerialize(yamlResult.root)).toBe(canonicalSerialize(jsonResult.root));
}

test("equivalence: rule 1 — bare metadata/object keys default their subType", () => {
  const json = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Product" } } ] } }`;
  const yaml = `
metadata:
  children:
    - object:
        name: Product
`;
  assertEquivalent(json, yaml);
});

test("equivalence: rule 2 — scalar body equals { name: <scalar> }", () => {
  const json = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Product", "children": [
      { "field.string": { "name": "sku" } } ] } } ] } }`;
  const yaml = `
metadata:
  children:
    - object:
        name: Product
        children:
          - field.string: sku
`;
  assertEquivalent(json, yaml);
});

test("equivalence: rule 4 — [] suffix equals isArray: true", () => {
  const json = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Program", "children": [
      { "field.long": { "name": "weekIds", "isArray": true } } ] } } ] } }`;
  const yaml = `
metadata:
  children:
    - object:
        name: Program
        children:
          - field.long[]: weekIds
`;
  assertEquivalent(json, yaml);
});

test("equivalence: a full document spanning all four rules", () => {
  const json = `{ "metadata.root": {
    "package": "acme::shop",
    "children": [
      { "object.entity": {
        "name": "Product",
        "children": [
          { "field.string": { "name": "sku" } },
          { "field.string": { "name": "tags", "isArray": true } },
          { "field.long": { "name": "priceCents", "@column": "price_cents" } },
          { "identity.primary": { "name": "pk", "@fields": ["sku"] } }
        ]
      } },
      { "object.value": { "name": "Money" } }
    ]
  } }`;
  const yaml = `
metadata:
  package: acme::shop
  children:
    - object:
        name: Product
        children:
          - field.string: sku
          - field.string[]: tags
          - field.long:
              name: priceCents
              "@column": price_cents
          - identity.primary:
              name: pk
              "@fields": sku
    - object.value:
        name: Money
`;
  assertEquivalent(json, yaml);
});
