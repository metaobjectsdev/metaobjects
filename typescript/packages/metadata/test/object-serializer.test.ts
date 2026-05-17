import { describe, it, expect } from "bun:test";
import { TypeRegistry } from "../src/registry.js";
import { registerCoreTypes } from "../src/core-types.js";
import { parseJson } from "../src/parser-json.js";
import type { MetaObject } from "../src/meta/meta-object.js";
import type { MetaField } from "../src/meta/meta-field.js";

function loadRoot(json: string) {
  const registry = new TypeRegistry();
  registerCoreTypes(registry);
  return parseJson(json, { registry }).root;
}

describe("MetaField.objectRef", () => {
  it("reads the @objectRef attr off an object-typed field", () => {
    const root = loadRoot(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.object": { "name": "customer", "@objectRef": "Customer" } }
      ] } }
    ] } }`);
    const order = root.childByName("Order") as MetaObject;
    const customer = order.fields()[0] as MetaField;
    expect(customer.objectRef).toBe("Customer");
  });

  it("objectRef is undefined on a field with no @objectRef", () => {
    const root = loadRoot(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.string": { "name": "code" } }
      ] } }
    ] } }`);
    const order = root.childByName("Order") as MetaObject;
    const code = order.fields()[0] as MetaField;
    expect(code.objectRef).toBeUndefined();
  });
});
