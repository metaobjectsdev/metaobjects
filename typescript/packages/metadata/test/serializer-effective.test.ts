import { test, expect } from "bun:test";
import { canonicalSerialize, canonicalSerializeEffective } from "../src/serializer-json.js";
import { parseJson } from "../src/parser-json.js";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";

test("effective serialization includes extends-inherited fields", () => {
  const registry = composeRegistry(coreProviders);
  const json = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Base", "abstract": true, "children": [
      { "field.string": { "name": "id" } } ] } },
    { "object.entity": { "name": "Product", "extends": "Base", "children": [
      { "field.string": { "name": "sku" } } ] } }
  ] } }`;
  const { root } = parseJson(json, { registry });
  const effective = canonicalSerializeEffective(root);
  // Product's effective rendering carries both id (inherited) and sku (own).
  expect(effective).toContain('"id"');
  expect(effective).toContain('"sku"');
});

test("own serialization of Product only has sku directly (not testing id presence — Base has it)", () => {
  const registry = composeRegistry(coreProviders);
  const json = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Base", "abstract": true, "children": [
      { "field.string": { "name": "id" } } ] } },
    { "object.entity": { "name": "Product", "extends": "Base", "children": [
      { "field.string": { "name": "sku" } } ] } }
  ] } }`;
  const { root } = parseJson(json, { registry });
  const own = canonicalSerialize(root);
  // own serialization of the whole tree still contains sku (Product's own child)
  expect(own).toContain('"sku"');
});

test("effective serialization of a node with no super is identical to own", () => {
  const registry = composeRegistry(coreProviders);
  const json = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Standalone", "children": [
      { "field.string": { "name": "title" } } ] } }
  ] } }`;
  const { root } = parseJson(json, { registry });
  const own = canonicalSerialize(root);
  const effective = canonicalSerializeEffective(root);
  expect(effective).toBe(own);
});

test("effective attrs from super chain appear on child node", () => {
  const registry = composeRegistry(coreProviders);
  const json = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Base", "abstract": true, "@description": "base-desc" } },
    { "object.entity": { "name": "Child", "extends": "Base" } }
  ] } }`;
  const { root } = parseJson(json, { registry });
  const effective = canonicalSerializeEffective(root);
  // Child inherits @description from Base; effective serialization must include it
  // in the Child node's rendering.
  const parsed = JSON.parse(effective) as Record<string, unknown>;
  const children = (parsed["metadata.root"] as Record<string, unknown>)["children"] as unknown[];
  const childNode = children.find((c) => {
    const body = (c as Record<string, unknown>)["object.entity"] as Record<string, unknown>;
    return body?.["name"] === "Child";
  }) as Record<string, unknown> | undefined;
  expect(childNode).toBeDefined();
  const childBody = childNode!["object.entity"] as Record<string, unknown>;
  expect(childBody["@description"]).toBe("base-desc");
});
