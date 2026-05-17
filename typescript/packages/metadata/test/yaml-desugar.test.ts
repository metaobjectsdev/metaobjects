import { test, expect } from "bun:test";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { desugar } from "../src/yaml-desugar.js";

function coreRegistry(): TypeRegistry {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  return registry;
}

test("rule 1: a bare type key resolves to the registry default subType", () => {
  const { canonical, errors } = desugar({ object: { name: "Product" } }, coreRegistry());
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "object.entity": { name: "Product" } });
});

test("rule 1: a fused type.subType key is left untouched", () => {
  const { canonical, errors } = desugar({ "object.value": { name: "Money" } }, coreRegistry());
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "object.value": { name: "Money" } });
});

test("rule 1: a bare key for a type with no default subType is a collected error", () => {
  const { errors } = desugar({ field: { name: "sku" } }, coreRegistry());
  expect(errors.length).toBeGreaterThan(0);
});

test("rule 2: a scalar body becomes { name: <scalar> }", () => {
  const { canonical, errors } = desugar({ "field.string": "sku" }, coreRegistry());
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "field.string": { name: "sku" } });
});

test("rule 2: a mapping body is kept as-is", () => {
  const { canonical } = desugar(
    { "field.string": { name: "sku", "@dbColumn": "sku_code" } },
    coreRegistry(),
  );
  expect(canonical).toEqual({ "field.string": { name: "sku", "@dbColumn": "sku_code" } });
});

test("rule 3: a node with no children gets no synthesized children key", () => {
  const { canonical } = desugar({ "object.entity": { name: "Product" } }, coreRegistry());
  const body = (canonical as Record<string, Record<string, unknown>>)["object.entity"]!;
  expect("children" in body).toBe(false);
});

test("rule 4: a trailing [] on the key strips to isArray: true on the body", () => {
  const { canonical, errors } = desugar({ "field.string[]": "tags" }, coreRegistry());
  expect(errors).toEqual([]);
  expect(canonical).toEqual({ "field.string": { name: "tags", isArray: true } });
});

test("recursion: children nodes are desugared", () => {
  const { canonical, errors } = desugar(
    {
      "object.entity": {
        name: "Product",
        children: [{ "field.string": "sku" }, { "field.long[]": "weekIds" }],
      },
    },
    coreRegistry(),
  );
  expect(errors).toEqual([]);
  expect(canonical).toEqual({
    "object.entity": {
      name: "Product",
      children: [
        { "field.string": { name: "sku" } },
        { "field.long": { name: "weekIds", isArray: true } },
      ],
    },
  });
});

test("malformed: a list body is a collected error", () => {
  const { errors } = desugar({ "field.string": ["a", "b"] }, coreRegistry());
  expect(errors.length).toBeGreaterThan(0);
});

test("malformed: a non-mapping document is a collected error with empty canonical", () => {
  const { canonical, errors } = desugar("just a string", coreRegistry());
  expect(errors.length).toBeGreaterThan(0);
  expect(Object.keys(canonical)).toEqual([]);
});
