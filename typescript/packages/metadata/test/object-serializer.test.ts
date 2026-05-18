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
    const order = root.ownChildByName("Order") as MetaObject;
    const customer = order.fields()[0] as MetaField;
    expect(customer.objectRef).toBe("Customer");
  });

  it("objectRef is undefined on a field with no @objectRef", () => {
    const root = loadRoot(`{ "metadata.root": { "children": [
      { "object.entity": { "name": "Order", "children": [
        { "field.string": { "name": "code" } }
      ] } }
    ] } }`);
    const order = root.ownChildByName("Order") as MetaObject;
    const code = order.fields()[0] as MetaField;
    expect(code.objectRef).toBeUndefined();
  });
});

import { objectToJson, jsonToObject } from "../src/object-serializer.js";

describe("objectToJson / jsonToObject", () => {
  const shop = `{ "metadata.root": { "children": [
    { "object.entity": { "name": "Customer", "children": [
      { "field.string": { "name": "name" } }
    ] } },
    { "object.entity": { "name": "Order", "children": [
      { "field.string": { "name": "code" } },
      { "field.int": { "name": "qty" } },
      { "field.currency": { "name": "totalCents", "@currency": "USD" } },
      { "field.boolean": { "name": "paid" } },
      { "field.date": { "name": "placedAt" } },
      { "field.string": { "name": "tags", "isArray": true } },
      { "field.object": { "name": "customer", "@objectRef": "Customer" } }
    ] } }
  ] } }`;

  function order(): MetaObject {
    return loadRoot(shop).ownChildByName("Order") as MetaObject;
  }

  it("objectToJson emits @type and the declared fields", () => {
    const json = objectToJson(order(), { code: "A1", qty: 3, paid: true });
    expect(json["@type"]).toBe("Order");
    expect(json.code).toBe("A1");
    expect(json.qty).toBe(3);
    expect(json.paid).toBe(true);
  });

  it("objectToJson can suppress @type", () => {
    const json = objectToJson(order(), { code: "A1" }, { emitType: false });
    expect("@type" in json).toBe(false);
  });

  it("objectToJson drops unknown keys and omits absent fields", () => {
    const json = objectToJson(order(), { code: "A1", bogus: "x" });
    expect("bogus" in json).toBe(false);
    expect("qty" in json).toBe(false);
  });

  it("date fields serialize to ISO 8601 strings", () => {
    const json = objectToJson(order(), { placedAt: new Date("2026-05-17T00:00:00.000Z") }, { emitType: false });
    expect(json.placedAt).toBe("2026-05-17T00:00:00.000Z");
  });

  it("jsonToObject coerces loosely-typed wire values per dataType", () => {
    const obj = jsonToObject(order(), { qty: "5", paid: "true" });
    expect(obj.qty).toBe(5);
    expect(obj.paid).toBe(true);
  });

  it("isArray fields serialize element-wise", () => {
    const json = objectToJson(order(), { tags: ["a", "b"] }, { emitType: false });
    expect(json.tags).toEqual(["a", "b"]);
  });

  it("round-trips a flat instance", () => {
    const mo = order();
    const original = { code: "A1", qty: 3, totalCents: 1999, paid: true, tags: ["x"] };
    const round = jsonToObject(mo, objectToJson(mo, original, { emitType: false }));
    expect(round).toEqual(original);
  });

  it("recurses into a nested object field via @objectRef", () => {
    const json = objectToJson(order(), { code: "A1", customer: { name: "Dana" } }, { emitType: false });
    expect(json.customer).toEqual({ "@type": "Customer", name: "Dana" });
  });

  it("a nested object round-trips", () => {
    const mo = order();
    const original = { code: "A1", customer: { name: "Dana" } };
    const round = jsonToObject(mo, objectToJson(mo, original, { emitType: false }));
    expect(round).toEqual(original);
  });
});
