// rc.21 part B — the view vocabulary at load: each construct is accepted where it means
// something and refused, with its code, where it does not.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";

const ENTITIES = [
  { "object.value": { name: "Contact", children: [
    { "field.string": { name: "kind" } }, { "field.int": { name: "rank" } },
    { "field.object": { name: "nested", "@objectRef": "Note" } } ] } },
  { "object.value": { name: "Note", children: [ { "field.string": { name: "text" } } ] } },
  { "object.entity": { name: "Customer", children: [
    { "source.rdb": { "@table": "customers" } },
    { "field.long": { name: "id" } },
    { "field.string": { name: "zip" } },
    { "field.string": { name: "tags", isArray: true } },
    { "field.object": { name: "contacts", "@objectRef": "Contact", isArray: true, "@storage": "jsonb" } },
    { "field.object": { name: "primary", "@objectRef": "Contact" } },
    { "identity.primary": { name: "id", "@fields": "id" } } ] } },
  { "object.entity": { name: "Order", children: [
    { "source.rdb": { "@table": "orders" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "customerId" } },
    { "field.enum": { name: "status", "@values": ["Open", "Shipped"], "@intValueMap": { Open: 0, Shipped: 1 } } },
    { "field.enum": { name: "kind", "@values": ["A", "B"] } },
    { "field.int": { name: "n" } },
    { "field.string": { name: "ref" } },
    { "field.timestamp": { name: "at" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "customerId", "@fields": "customerId", "@references": "Customer" } } ] } },
  { "object.entity": { name: "OrderEvent", children: [
    { "source.rdb": { "@table": "order_events" } },
    { "field.long": { name: "id" } },
    { "field.long": { name: "orderId" } },
    { "field.long": { name: "customerId" } },
    { "field.timestamp": { name: "createdAt" } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "identity.reference": { name: "orderId", "@fields": "orderId", "@references": "Order" } } ] } },
];

const orderView = (fields: unknown[], extra: Record<string, unknown> = {}) => ({ "object.projection": { name: "V", ...extra, children: [
  { "source.rdb": { "@kind": "view", "@table": "v" } },
  { "field.long": { name: "id", extends: "Order.id" } },
  ...fields,
  { "identity.primary": { name: "id", extends: "Order.id" } } ] } });
const computed = (name: string, subType: string, expr: unknown) =>
  ({ [`field.${subType}`]: { name, children: [ { "origin.computed": { "@expr": expr } } ] } });

async function load(...extra: unknown[]): Promise<{ code: string; message: string }[]> {
  const doc = { "metadata.root": { package: "acme", children: [...ENTITIES, ...extra] } };
  const { errors } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
  return errors.map((e) => ({ code: String((e as { code?: string }).code), message: e.message }));
}
const ok = async (...extra: unknown[]) => expect(await load(...extra)).toEqual([]);
const refused = async (code: string, pattern: RegExp, ...extra: unknown[]) => {
  const errors = await load(...extra);
  expect(errors.some((e) => e.code === code && pattern.test(e.message))).toBe(true);
};

describe("U2 — @dbColumnType text spellings", () => {
  const entity = (attr: Record<string, unknown>) => ({ "object.entity": { name: "R", children: [
    { "source.rdb": { "@table": "r" } }, { "field.long": { name: "id" } },
    { "field.string": { name: "c", ...attr } }, { "identity.primary": { name: "id", "@fields": "id" } } ] } });
  test("text, varchar, character varying and the sized spellings load on a field.string", async () => {
    for (const t of ["text", "varchar", "character varying", "varchar(12)", "character varying(12)", "character(3)"]) {
      await ok(entity({ "@dbColumnType": t }));
    }
  });
  test("a misspelling, a zero length, another subtype and a @maxLength over n are refused", async () => {
    await refused("ERR_BAD_ATTR_VALUE", /'VARCHAR' is not legal/, entity({ "@dbColumnType": "VARCHAR" }));
    await refused("ERR_BAD_ATTR_VALUE", /'character\(0\)' is not legal/, entity({ "@dbColumnType": "character(0)" }));
    await refused("ERR_BAD_ATTR_VALUE", /@maxLength: 10 over '@dbColumnType: character\(3\)'/, entity({ "@dbColumnType": "character(3)", "@maxLength": 10 }));
    await refused("ERR_BAD_ATTR_VALUE", /'varchar' is not legal on field.int/, { "object.entity": { name: "R", children: [
      { "source.rdb": { "@table": "r" } }, { "field.long": { name: "id" } },
      { "field.int": { name: "c", "@dbColumnType": "varchar" } }, { "identity.primary": { name: "id", "@fields": "id" } } ] } });
  });
});

describe("U11, U12, U13 — the function set and the cast", () => {
  test("typed functions and casts load", async () => {
    await ok(orderView([
      computed("a", "string", { fn: "splitPart", args: [{ field: "ref" }, { value: "-" }, { value: 1 }] }),
      computed("b", "string", { fn: "concatWs", args: [{ value: " " }, { field: "ref" }, { field: "n" }] }),
      computed("c", "int", { fn: "length", args: [{ fn: "btrim", args: [{ field: "ref" }] }] }),
      computed("d", "string", { cast: { field: "id" }, as: "string" }),
      computed("e", "int", { cast: { field: "status" }, as: "int" }),
      computed("f", "string", { cast: { value: null }, as: "string", dbColumnType: "varchar(4)" }),
      computed("g", "timestamp", { fn: "greatest", args: [{ field: "at" }, { value: null }] }),
      computed("h", "string", { fn: "nullif", args: [{ field: "ref" }, { value: "" }] }),
    ]));
  });
  test("an unknown function, a bad arity and a wrong argument type are refused", async () => {
    await refused("ERR_UNKNOWN_EXPR_NODE", /unknown expression fn 'initcap'/, orderView([computed("a", "string", { fn: "initcap", args: [{ field: "ref" }] })]));
    await refused("ERR_UNKNOWN_EXPR_NODE", /'splitPart' requires at least 3 args/, orderView([computed("a", "string", { fn: "splitPart", args: [{ field: "ref" }] })]));
    await refused("ERR_INVALID_ORIGIN", /'lower' argument 1 must be a string, got int/, orderView([computed("a", "string", { fn: "lower", args: [{ field: "n" }] })]));
    await refused("ERR_INVALID_ORIGIN", /'greatest' arguments have differing types/, orderView([computed("a", "int", { fn: "greatest", args: [{ field: "n" }, { field: "id" }] })]));
    await refused("ERR_INVALID_ORIGIN", /'greatest' needs ordered arguments/, orderView([computed("a", "boolean", { fn: "greatest", args: [{ value: true }, { value: false }] })]));
  });
  test("a cast the source cannot hold is refused (U8: an enum casts to int only when int-stored)", async () => {
    await refused("ERR_INVALID_ORIGIN", /only an enum stored as an integer/, orderView([computed("a", "int", { cast: { field: "kind" }, as: "int" })]));
    await refused("ERR_INVALID_ORIGIN", /cast it to int/, orderView([computed("a", "string", { cast: { field: "status" }, as: "string" })]));
    await refused("ERR_UNKNOWN_EXPR_NODE", /requires 'as': one of/, orderView([computed("a", "string", { cast: { field: "id" }, as: "enum" })]));
    await refused("ERR_UNKNOWN_EXPR_NODE", /'dbColumnType' is a text spelling/, orderView([computed("a", "string", { cast: { field: "id" }, as: "string", dbColumnType: "uuid" })]));
    await refused("ERR_INVALID_ORIGIN", /a timestamp cannot be cast to int/, orderView([computed("a", "int", { cast: { field: "at" }, as: "int" })]));
  });
  test("an int-stored enum and an int still differ in a case without the cast", async () => {
    await refused("ERR_INVALID_ORIGIN", /'case' results have differing types/, orderView([computed("a", "int", {
      case: [{ when: { op: "eq", left: { field: "n" }, right: { value: 0 } }, then: { field: "status" } }], else: { field: "n" } })]));
    await ok(orderView([computed("a", "int", {
      case: [{ when: { op: "eq", left: { field: "n" }, right: { value: 0 } }, then: { cast: { field: "status" }, as: "int" } }], else: { field: "n" } })]));
  });
  test("an expression over an aggregate loads, and is not filterable", async () => {
    const last = { "field.timestamp": { name: "last", children: [ { "origin.aggregate": { "@agg": "max", "@of": "OrderEvent.createdAt", "@via": "Order.orderEvents" } } ] } };
    await ok(orderView([last, computed("touched", "timestamp", { fn: "greatest", args: [{ field: "at" }, { field: "last" }] })]));
    await refused("ERR_BAD_ATTR_FILTER", /touched/, orderView([last, computed("touched", "timestamp", { fn: "greatest", args: [{ field: "at" }, { field: "last" }] })],
      { "@filter": { touched: { isNull: false } } }));
  });
  test("a CHECK @condition refuses the view-only nodes", async () => {
    await refused("ERR_BAD_ATTR_VALUE", /uses lower, which a CHECK condition cannot hold/, { "object.entity": { name: "W", children: [
      { "source.rdb": { "@table": "w" } }, { "field.long": { name: "id" } }, { "field.string": { name: "a" } }, { "field.string": { name: "b" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
      { "validator.requiredWhen": { name: "r", "@field": "b", "@condition": { op: "eq", left: { fn: "lower", args: [{ field: "a" }] }, right: { value: "x" } } } } ] } });
  });
});

describe("U3, U4 — paths in an expression and in a correlated operand", () => {
  test("a path ref and a path operand load on a projection", async () => {
    await ok(orderView([
      computed("zip5", "string", { fn: "left", args: [{ field: "customerId.zip" }, { value: 5 }] }),
      { "field.long": { name: "ev", children: [ { "origin.first": { "@of": "OrderEvent.id", "@via": "Order.orderEvents", "@orderBy": ["createdAt"],
        "@filter": { customerId: { eq: { field: "customerId.id" } } } } } ] } },
    ]));
  });
  test("a path that does not resolve is refused", async () => {
    await refused("ERR_INVALID_ORIGIN", /does not resolve/, orderView([computed("z", "string", { field: "customerId.nope" })]));
    await refused("ERR_BAD_ATTR_FILTER", /base-row path "customerId.nope"/, orderView([
      { "field.long": { name: "ev", children: [ { "origin.first": { "@of": "OrderEvent.id", "@via": "Order.orderEvents", "@orderBy": ["createdAt"],
        "@filter": { customerId: { eq: { field: "customerId.nope" } } } } } ] } }]));
  });
});

describe("U10 — origin.function", () => {
  const withFn = (fn: Record<string, unknown>) => ({ "object.entity": { name: "Customer2", children: [
    { "source.rdb": { "@table": "customers2" } }, { "field.long": { name: "id" } }, { "field.string": { name: "zip" } },
    { "field.object": { name: "contacts", "@objectRef": "Contact", isArray: true } },
    { "identity.primary": { name: "id", "@fields": "id" } },
    { "field.string": { name: "tier", children: [ { "origin.function": fn } ] } } ] } });
  const reach = { "object.projection": { name: "P2", children: [
    { "source.rdb": { "@kind": "view", "@table": "p2" } },
    { "field.long": { name: "id", extends: "Customer2.id" } },
    { "field.string": { name: "tier", children: [ { "origin.passthrough": { "@from": "Customer2.tier" } } ] } },
    { "identity.primary": { name: "id", extends: "Customer2.id" } } ] } };
  test("a declared call on an entity, reached by a projection, loads", async () => {
    await ok(withFn({ "@function": "tier_of", "@schema": "app", "@args": ["id", "zip"], "@params": ["long", "string"], "@returns": "string" }), reach);
  });
  test("free SQL, an unknown argument and a non-scalar argument are refused", async () => {
    await refused("ERR_INVALID_ORIGIN", /is not a plain identifier/, withFn({ "@function": "tier_of(1); drop table x", "@args": [], "@returns": "string" }), reach);
    await refused("ERR_INVALID_ORIGIN", /@args names "nope"/, withFn({ "@function": "tier_of", "@args": ["nope"], "@params": ["long"], "@returns": "string" }), reach);
    await refused("ERR_INVALID_ORIGIN", /a field.object array; a function argument is a scalar/, withFn({ "@function": "tier_of", "@args": ["contacts"], "@params": ["string"], "@returns": "string" }), reach);
  });
  // rc.21 part B fix round (I4): the declared signature is checked.
  test("an argument of another type than its parameter, a return type other than the field's, and a short @params are refused", async () => {
    await refused("ERR_INVALID_ORIGIN", /argument 1 "id" is a field.long, but parameter 1 is declared int; pass an origin.computed field that casts it/,
      withFn({ "@function": "tier_of", "@args": ["id"], "@params": ["int"], "@returns": "string" }), reach);
    await refused("ERR_INVALID_ORIGIN", /@returns int, but the field is field.string/, withFn({ "@function": "tier_of", "@args": ["id"], "@params": ["long"], "@returns": "int" }), reach);
    await refused("ERR_INVALID_ORIGIN", /@params declares 1 parameter type\(s\) for 2 argument\(s\)/,
      withFn({ "@function": "tier_of", "@args": ["id", "zip"], "@params": ["long"], "@returns": "string" }), reach);
    await refused("ERR_MISSING_REQUIRED_ATTR", /returns/, withFn({ "@function": "tier_of", "@args": [] }), reach);
  });
  test("an argument cast through an origin.computed field loads", async () => {
    await ok({ "object.entity": { name: "Customer2", children: [
      { "source.rdb": { "@table": "customers2" } }, { "field.long": { name: "id" } },
      { "identity.primary": { name: "id", "@fields": "id" } },
      { "field.int": { name: "idAsInt", children: [ { "origin.computed": { "@expr": { cast: { field: "id" }, as: "int" } } } ] } },
      { "field.string": { name: "tier", children: [ { "origin.function": { "@function": "tier_of", "@args": ["idAsInt"], "@params": ["int"], "@returns": "string" } } ] } } ] } }, reach);
  });
  // Fix round 2 (N3): a view inlines a derived field's dependencies on the same row; a cycle has no SQL.
  test("a cycle through derived function arguments is refused, naming the path", async () => {
    const meter = (...fields: unknown[]) => ({ "object.entity": { name: "Meter", children: [
      { "source.rdb": { "@table": "meters" } }, { "field.long": { name: "id" } }, { "identity.primary": { name: "id", "@fields": "id" } }, ...fields ] } });
    const fnField = (name: string, arg: string) => ({ "field.long": { name, children: [
      { "origin.function": { "@function": `f_${name}`, "@args": [arg], "@params": ["long"], "@returns": "long" } } ] } });
    const meterRow = { "object.projection": { name: "MeterRow", children: [ { "source.rdb": { "@kind": "view", "@table": "v_meter" } },
      { "field.long": { name: "id", extends: "Meter.id" } },
      { "field.long": { name: "a", children: [ { "origin.passthrough": { "@from": "Meter.a" } } ] } },
      { "identity.primary": { name: "id", extends: "Meter.id" } } ] } };
    // function → function
    await refused("ERR_INVALID_ORIGIN", /Meter\.a: a derived field depends on itself through a → b → a/, meter(fnField("a", "b"), fnField("b", "a")), meterRow);
    // function → computed → function
    await refused("ERR_INVALID_ORIGIN", /depends on itself through a → c → a/,
      meter(fnField("a", "c"), { "field.long": { name: "c", children: [ { "origin.computed": { "@expr": { fn: "coalesce", args: [ { field: "a" }, { field: "id" } ] } } } ] } }), meterRow);
    // A chain without a cycle loads.
    await ok(meter(fnField("a", "b"), fnField("b", "id")), meterRow);
  });
  // Fix round 3 (M3): on an entity, a computed field that reads its own name reads itself.
  test("an entity's computed field that reads itself is a one-node cycle; on a projection the name is the base field", async () => {
    const selfRef = { "field.long": { name: "a", children: [ { "origin.computed": { "@expr": { fn: "coalesce", args: [ { field: "a" }, { field: "id" } ] } } } ] } };
    await refused("ERR_INVALID_ORIGIN", /Meter\.a: a derived field depends on itself through a → a/,
      { "object.entity": { name: "Meter", children: [ { "source.rdb": { "@table": "meters" } }, { "field.long": { name: "id" } },
        { "identity.primary": { name: "id", "@fields": "id" } }, selfRef ] } },
      { "object.projection": { name: "MeterRow", children: [ { "source.rdb": { "@kind": "view", "@table": "v_meter" } },
        { "field.long": { name: "id", extends: "Meter.id" } },
        { "field.long": { name: "a", children: [ { "origin.passthrough": { "@from": "Meter.a" } } ] } },
        { "identity.primary": { name: "id", extends: "Meter.id" } } ] } });
    // A projection field over the base field of the same name is no cycle.
    await ok(orderView([computed("customerId", "long", { fn: "coalesce", args: [ { field: "customerId" }, { field: "id" } ] })]));
  });
  test("an unreached function field on an entity with no read source is refused", async () => {
    await refused("ERR_DERIVED_FIELD_NO_READ_SOURCE", /tier/, withFn({ "@function": "tier_of", "@args": ["id"], "@params": ["long"], "@returns": "string" }));
  });
});

describe("U14 — @grain", () => {
  const grain = (extra: Record<string, unknown>, fields: unknown[]) => ({ "object.projection": { name: "G", ...extra, children: [
    { "source.rdb": { "@kind": "view", "@table": "g" } },
    { "field.long": { name: "customerId", extends: "Customer.id" } },
    ...fields ] } });
  const kind = { "field.string": { name: "kind", children: [ { "origin.passthrough": { "@from": "Contact.kind" } } ] } };
  test("one row per element loads, with a position", async () => {
    await ok(grain({ "@grain": "contacts", "@grainOrdinal": "pos" }, [{ "field.int": { name: "pos" } }, kind]));
  });
  test("a scalar array, a single object, a nested member, an aggregate and a bad ordinal are refused", async () => {
    await refused("ERR_BAD_ATTR_VALUE", /@grain "tags" must name a field.object array/, grain({ "@grain": "tags" }, [kind]));
    await refused("ERR_BAD_ATTR_VALUE", /@grain "primary" must name a field.object array/, grain({ "@grain": "primary" }, [kind]));
    await refused("ERR_INVALID_ORIGIN", /is not a scalar member of the @grain element/, grain({ "@grain": "contacts" },
      [{ "field.object": { name: "nested", "@objectRef": "Note", children: [ { "origin.passthrough": { "@from": "Contact.nested" } } ] } }]));
    await refused("ERR_BAD_ATTR_VALUE", /a @grain view has one row per element/, grain({ "@grain": "contacts" }, [kind,
      { "field.long": { name: "n", children: [ { "origin.aggregate": { "@agg": "count", "@of": "Order.id", "@via": "Customer.orders" } } ] } }]));
    await refused("ERR_BAD_ATTR_VALUE", /@grainOrdinal "pos" must name a field.int or field.long/, grain({ "@grain": "contacts", "@grainOrdinal": "pos" },
      [{ "field.string": { name: "pos" } }, kind]));
  });
});

describe("U15 — @union", () => {
  const branch = (name: string, entity: string, idField: string, label: Record<string, unknown>) => ({ "object.projection": { name, abstract: true, children: [
    { "field.long": { name: "personId", extends: `${entity}.${idField}` } }, label ] } });
  const label = (from: string) => ({ "field.string": { name: "label", children: [ { "origin.computed": { "@expr": { fn: "lower", args: [{ field: from }] } } } ] } });
  const union = (extra: Record<string, unknown>) => ({ "object.projection": { name: "U", extends: "A", ...extra, children: [
    { "source.rdb": { "@kind": "view", "@table": "u" } } ] } });
  test("projections of one shape union", async () => {
    await ok(branch("A", "Customer", "id", label("zip")), branch("B", "Order", "customerId", label("ref")), union({ "@union": ["B"], "@unionAll": true }));
  });
  test("a different shape, a non-projection, itself and @unionAll alone are refused", async () => {
    await refused("ERR_BAD_ATTR_VALUE", /member "B" has a different shape/, branch("A", "Customer", "id", label("zip")),
      branch("B", "Order", "customerId", { "field.int": { name: "label", children: [ { "origin.computed": { "@expr": { field: "n" } } } ] } }), union({ "@union": ["B"] }));
    await refused("ERR_BAD_ATTR_VALUE", /names "Order", which is not an object.projection/, branch("A", "Customer", "id", label("zip")), union({ "@union": ["Order"] }));
    await refused("ERR_BAD_ATTR_VALUE", /names the projection itself/, branch("A", "Customer", "id", label("zip")), union({ "@union": ["U"] }));
    await refused("ERR_BAD_ATTR_VALUE", /@unionAll needs @union/, branch("A", "Customer", "id", label("zip")), union({ "@unionAll": true }));
  });
});

// rc.21 part B fix round (I2): an extender keeps its super's identity anchor, so a projection over a
// TPH base that reads a subtype-only column now returns every base row. The load warns, unless a
// discriminator filter (or its own identity) scopes it.
describe("an extender whose view widened over a TPH base", () => {
  const tph = [
    { "object.entity": { name: "Vehicle", "@discriminator": "kind", children: [
      { "source.rdb": { "@table": "vehicles" } }, { "field.long": { name: "id" } }, { "field.string": { name: "kind", "@maxLength": 10 } },
      { "identity.primary": { "@fields": "id" } } ] } },
    { "object.entity": { name: "Truck", extends: "Vehicle", "@discriminatorValue": "TRUCK", children: [
      { "field.string": { name: "payloadClass" } } ] } },
    { "object.projection": { name: "VehicleBase", abstract: true, children: [
      { "field.long": { name: "vehicleId", extends: "Vehicle.id" } },
      { "identity.primary": { name: "id", extends: "Vehicle.primary" } } ] } },
  ];
  const row = (extra: Record<string, unknown> = {}, children: unknown[] = []) => ({ "object.projection": { name: "TruckRow", extends: "VehicleBase", ...extra, children: [
    { "source.rdb": { "@kind": "view", "@view": "v_trucks" } },
    { "field.string": { name: "payload", extends: "Truck.payloadClass" } }, ...children ] } });
  async function warningsOf(...extra: unknown[]): Promise<string[]> {
    const { errors, warnings } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children: [...tph, ...extra] } }))]);
    expect(errors).toEqual([]);
    return warnings.map((w) => (typeof w === "string" ? w : (w as { message: string }).message));
  }
  test("warns, naming the remedy", async () => {
    const w = (await warningsOf(row())).filter((m) => m.includes("TruckRow"));
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/"payload" \(Truck.payloadClass\) read columns only a subtype carries, over the TPH base Vehicle with no @filter on its discriminator "kind"/);
    expect(w[0]).toMatch(/@filter \{ kind: <value> \} or declare identity.primary \{ extends: Truck.primary \}/);
  });
  test("an abstract extender emits no view: no warning (fix round 2)", async () => {
    expect((await warningsOf(row({ abstract: true }))).filter((m) => m.includes("TruckRow"))).toEqual([]);
  });
  test("a discriminator filter, or its own identity, scopes it: no warning", async () => {
    expect((await warningsOf(row({ "@filter": { kind: "TRUCK" } }))).filter((m) => m.includes("TruckRow"))).toEqual([]);
    expect((await warningsOf(row({}, [{ "field.long": { name: "vehicleId", extends: "Truck.id" } },
      { "identity.primary": { name: "id", extends: "Truck.primary" } }]))).filter((m) => m.includes("TruckRow"))).toEqual([]);
  });
});

// L5: the identity-anchor rule applies to EVERY extender with no identity of its own, not only a TPH
// one. An extender over plain entities whose base changed from the pre-rc.21 derivation warns too.
describe("an extender whose base changed, over a non-TPH base", () => {
  const entities = [
    { "object.entity": { name: "Customer", children: [
      { "source.rdb": { "@table": "customers" } }, { "field.long": { name: "id" } },
      { "identity.primary": { "@fields": "id" } } ] } },
    { "object.entity": { name: "Invoice", children: [
      { "source.rdb": { "@table": "invoices" } }, { "field.long": { name: "id" } }, { "field.string": { name: "ref" } },
      { "identity.primary": { "@fields": "id" } } ] } },
    { "object.projection": { name: "CustomerBase", abstract: true, children: [
      { "field.long": { name: "customerId", extends: "Customer.id" } },
      { "identity.primary": { name: "id", extends: "Customer.primary" } } ] } },
  ];
  const row = (children: unknown[]) => ({ "object.projection": { name: "InvoiceRow", extends: "CustomerBase", children: [
    { "source.rdb": { "@kind": "view", "@view": "v_invoice_rows" } }, ...children ] } });
  async function warningsOf(...extra: unknown[]): Promise<string[]> {
    const { errors, warnings } = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "acme", children: [...entities, ...extra] } }))]);
    expect(errors).toEqual([]);
    return warnings.map((w) => (typeof w === "string" ? w : (w as { message: string }).message));
  }
  test("warns that the base is now the super's, naming both and the remedy", async () => {
    const w = (await warningsOf(row([{ "field.string": { name: "ref", extends: "Invoice.ref" } }]))).filter((m) => m.includes("InvoiceRow"));
    expect(w.length).toBe(1);
    expect(w[0]).toMatch(/its base entity is now Customer, where before it was Invoice/);
    expect(w[0]).toMatch(/identity.primary \{ extends: Invoice.<identity> \}/);
  });
  test("an extender whose own fields still name the super's base is not warned about", async () => {
    expect((await warningsOf(row([{ "field.long": { name: "other", extends: "Customer.id" } }]))).filter((m) => m.includes("InvoiceRow"))).toEqual([]);
  });
});

// rc.21 part B fix round minors.
describe("fix round: casts Postgres has, value-mapped grain members, union value maps", () => {
  test("M1: a boolean casts only to and from int; a count parameter takes only an int", async () => {
    await refused("ERR_INVALID_ORIGIN", /a long cannot be cast to boolean; only an int can/, orderView([computed("a", "boolean", { cast: { field: "id" }, as: "boolean" })]));
    await refused("ERR_INVALID_ORIGIN", /a boolean casts only to int, not long/, orderView([computed("a", "long", { cast: { value: true }, as: "long" })]));
    await ok(orderView([computed("a", "boolean", { cast: { field: "n" }, as: "boolean" })]));
    await refused("ERR_INVALID_ORIGIN", /'left' argument 2 must be an int, got long; cast it/, orderView([computed("a", "string", { fn: "left", args: [{ field: "ref" }, { field: "id" }] })]));
    await ok(orderView([computed("a", "string", { fn: "left", args: [{ field: "ref" }, { cast: { field: "id" }, as: "int" }] })]));
  });
  test("M2: a @grain member that is a value-mapped enum is refused", async () => {
    const doc = [
      { "object.value": { name: "Tag", children: [ { "field.enum": { name: "kind", "@values": ["A", "B"], "@intValueMap": { A: 0, B: 1 } } } ] } },
      { "object.entity": { name: "Item", children: [ { "source.rdb": { "@table": "items" } }, { "field.long": { name: "id" } },
        { "field.object": { name: "tags", "@objectRef": "Tag", isArray: true, "@storage": "jsonb" } }, { "identity.primary": { name: "id", "@fields": "id" } } ] } },
      { "object.projection": { name: "ItemTag", "@grain": "tags", children: [ { "source.rdb": { "@kind": "view", "@view": "v_item_tag" } },
        { "field.long": { name: "itemId", extends: "Item.id" } },
        { "field.enum": { name: "kind", "@values": ["A", "B"], "@intValueMap": { A: 0, B: 1 }, children: [ { "origin.passthrough": { "@from": "Tag.kind" } } ] } } ] } },
    ];
    await refused("ERR_INVALID_ORIGIN", /is an enum with a value map, but a @grain element holds the member's symbol/, ...doc);
  });
  test("M4: union members whose enum value maps differ, and a member's own @union, are refused", async () => {
    const branch = (name: string, map: Record<string, number>, extra: Record<string, unknown> = {}) => ({ "object.projection": { name, abstract: true, ...extra, children: [
      { "field.long": { name: "rowId", extends: "Order.id" } },
      { "field.enum": { name: "state", "@values": ["X", "Y"], "@intValueMap": map, children: [ { "origin.passthrough": { "@from": "Order.status", "@convert": true } } ] } } ] } });
    const union = { "object.projection": { name: "U", extends: "A", "@union": ["B"], children: [ { "source.rdb": { "@kind": "view", "@view": "u" } } ] } };
    await refused("ERR_BAD_ATTR_VALUE", /member "B" has a different shape/, branch("A", { X: 0, Y: 1 }), branch("B", { X: 1, Y: 0 }), union);
    await refused("ERR_BAD_ATTR_VALUE", /member "B" declares its own @union/, branch("A", { X: 0, Y: 1 }), branch("B", { X: 0, Y: 1 }, { "@union": ["C"] }),
      branch("C", { X: 0, Y: 1 }), union);
  });
});
