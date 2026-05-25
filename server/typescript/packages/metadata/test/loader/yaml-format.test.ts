import { test, expect } from "bun:test";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../../src/loader/meta-data-source.js";
import { FileSource } from "../../src/loader/sources/file-source.js";
import { TYPE_METADATA } from "../../src/index.js";

test("loader: dispatches a yaml-format source through parseYaml", async () => {
  const yaml = `
metadata:
  children:
    - object:
        name: Product
        children:
          - field.string: sku
`;
  const loader = new MetaDataLoader();
  const result = await loader.load([new InMemoryStringSource(yaml, { id: "shop.yaml", format: "yaml" })]);
  expect(result.errors).toEqual([]);
  expect(result.root.type).toBe(TYPE_METADATA);
  expect(result.root.ownChildren()[0]!.name).toBe("Product");
});

test("loader: merges a json source and a yaml source into one tree", async () => {
  const json = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Product", "children": [
      { "field.string": { "name": "sku" } } ] } } ] } }`;
  const yaml = `
metadata:
  children:
    - object:
        name: Customer
        children:
          - field.string: email
`;
  const loader = new MetaDataLoader();
  const result = await loader.load([
    new InMemoryStringSource(json, { id: "a.json", format: "json" }),
    new InMemoryStringSource(yaml, { id: "b.yaml", format: "yaml" }),
  ]);
  expect(result.errors).toEqual([]);
  expect(result.root.ownChildByName("Product")).toBeDefined();
  expect(result.root.ownChildByName("Customer")).toBeDefined();
});

test("FileSource: infers format from the file extension", () => {
  expect(new FileSource("meta.commerce.json").format).toBe("json");
  expect(new FileSource("meta.commerce.yaml").format).toBe("yaml");
  expect(new FileSource("meta.commerce.yml").format).toBe("yaml");
});

test("loader: the base MetaDataLoader now parses yaml-format sources directly", async () => {
  // YAML support is folded into the base loader as of the cross-language
  // loader-unification work — no FileMetaDataLoader subclass needed.
  const loader = new MetaDataLoader();
  const result = await loader.load([
    new InMemoryStringSource("metadata:\n  children: []\n", { id: "x.yaml", format: "yaml" }),
  ]);
  expect(result.errors).toEqual([]);
  expect(result.root.type).toBe(TYPE_METADATA);
});
