import { test, expect } from "bun:test";
import { MetaDataLoader } from "../../src/loader/meta-data-loader.js";
import { FileMetaDataLoader } from "../../src/core/file-meta-data-loader.js";
import { InMemorySource } from "../../src/loader/meta-data-source.js";
import { FileSource } from "../../src/core/file-source.js";
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
  const loader = new FileMetaDataLoader();
  const result = await loader.load([new InMemorySource(yaml, { id: "shop.yaml", format: "yaml" })]);
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
  const loader = new FileMetaDataLoader();
  const result = await loader.load([
    new InMemorySource(json, { id: "a.json", format: "json" }),
    new InMemorySource(yaml, { id: "b.yaml", format: "yaml" }),
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

test("loader: the base MetaDataLoader rejects a yaml-format source", async () => {
  const loader = new MetaDataLoader();
  const result = await loader.load([
    new InMemorySource("metadata:\n  children: []\n", { id: "x.yaml", format: "yaml" }),
  ]);
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0]!.message).toContain("MetaDataLoader parses JSON only");
});
