import { describe, test, expect } from "bun:test";
import type { MetaData } from "@metaobjectsdev/metadata";
import { TypeId, TYPE_OBJECT, TYPE_FIELD,
         FIELD_SUBTYPE_BOOLEAN, FIELD_SUBTYPE_LONG, FIELD_SUBTYPE_STRING,
         OBJECT_SUBTYPE_ENTITY, MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { meta } from "./_meta-build.js";
import { coerceRowOnRead, coerceRowOnWrite } from "../src/type-coercer.js";

function entityWithFields(specs: { name: string; subType: string }[]): MetaData {
  const e = meta(new TypeId(TYPE_OBJECT, OBJECT_SUBTYPE_ENTITY), "X");
  for (const s of specs) e.addChild(meta(new TypeId(TYPE_FIELD, s.subType), s.name));
  return e;
}

describe("coerceRowOnRead — sqlite", () => {
  test("integer 0/1 → boolean for FIELD_SUBTYPE_BOOLEAN columns", () => {
    const e = entityWithFields([
      { name: "active", subType: FIELD_SUBTYPE_BOOLEAN },
      { name: "id", subType: FIELD_SUBTYPE_LONG },
    ]);
    const out = coerceRowOnRead(e, { active: 1, id: 42 }, "sqlite");
    expect(out.active).toBe(true);
    expect(out.id).toBe(42);
  });

  test("0 → false", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnRead(e, { active: 0 }, "sqlite").active).toBe(false);
  });

  test("null booleans pass through", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnRead(e, { active: null }, "sqlite").active).toBeNull();
  });
});

describe("coerceRowOnRead — mysql", () => {
  test("a conditional boolean aggregate is a BIGINT, which the pool returns as text: '0' / '1' → boolean", () => {
    const e = entityWithFields([{ name: "anyFailed", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnRead(e, { anyFailed: "1" }, "mysql").anyFailed).toBe(true);
    expect(coerceRowOnRead(e, { anyFailed: "0" }, "mysql").anyFailed).toBe(false);
    expect(coerceRowOnRead(e, { anyFailed: 1 }, "mysql").anyFailed).toBe(true);
    expect(coerceRowOnRead(e, { anyFailed: null }, "mysql").anyFailed).toBeNull();
  });
});

describe("coerceRowOnRead — postgres / memory", () => {
  test("native booleans pass through unchanged", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnRead(e, { active: true }, "postgres").active).toBe(true);
    expect(coerceRowOnRead(e, { active: false }, "memory").active).toBe(false);
  });
});

describe("coerceRowOnWrite — sqlite", () => {
  test("boolean → 0/1 for boolean columns", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnWrite(e, { active: true }, "sqlite").active).toBe(1);
    expect(coerceRowOnWrite(e, { active: false }, "sqlite").active).toBe(0);
  });
});

describe("coerceRowOnWrite — postgres / memory", () => {
  test("native booleans pass through", () => {
    const e = entityWithFields([{ name: "active", subType: FIELD_SUBTYPE_BOOLEAN }]);
    expect(coerceRowOnWrite(e, { active: true }, "postgres").active).toBe(true);
  });
});

describe("non-boolean fields untouched", () => {
  test("strings, numbers, nulls all pass through", () => {
    const e = entityWithFields([
      { name: "title", subType: FIELD_SUBTYPE_STRING },
      { name: "id", subType: FIELD_SUBTYPE_LONG },
    ]);
    const row = { title: "x", id: 42, extra: "ignored" };
    expect(coerceRowOnRead(e, row, "sqlite")).toEqual(row);
    expect(coerceRowOnWrite(e, row, "sqlite")).toEqual(row);
  });
});

// ADR-0019 Amendment 1 for a `field.decimal` declared `isArray` (a Postgres `numeric[]`): every
// element is a canonical string on read and on write, and an element the column cannot hold is
// refused (W3), as C#'s DecimalListJsonConverter, Python's to_wire and Java's contentUsing do.
describe("field.decimal isArray", () => {
  async function ledger(): Promise<MetaData> {
    const model = { "metadata.root": { package: "ledger", children: [
      { "object.entity": { name: "Entry", children: [
        { "source.rdb": { "@table": "entries" } },
        { "field.long": { name: "id" } },
        { "field.decimal": { name: "readings", isArray: true, "@precision": 9, "@scale": 4 } },
        { "field.decimal": { name: "amount", "@precision": 9, "@scale": 4 } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ]}},
    ]}};
    const { root, errors } = await new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(JSON.stringify(model), { id: "ledger.json" }),
    ]);
    expect(errors).toEqual([]);
    return root.objects().find((o) => o.name === "Entry") as MetaData;
  }

  test("read: the column's scale is stripped from each element (100.5000 -> 100.5)", async () => {
    const e = await ledger();
    expect(coerceRowOnRead(e, { readings: ["100.5000", "0.0000", "-2.2500", null] }, "postgres").readings)
      .toEqual(["100.5", "0", "-2.25", null]);
    expect(coerceRowOnRead(e, { readings: "[0.30000000000000004, 12]" }, "sqlite").readings).toEqual(["0.3", "12"]);
  });

  test("write: each element is bound as its canonical string", async () => {
    const e = await ledger();
    expect(coerceRowOnWrite(e, { readings: ["100.5000", 2.5, "1.5e1", null] }, "postgres").readings)
      .toEqual(["100.5", "2.5", "15", null]);
    expect(coerceRowOnWrite(e, { readings: [] }, "postgres").readings).toEqual([]);
  });

  test("write: an element that is not a number, or that the column cannot hold, is refused", async () => {
    const e = await ledger();
    expect(() => coerceRowOnWrite(e, { readings: ["1", "12abc"] }, "postgres")).toThrow("is not a decimal number");
    expect(() => coerceRowOnWrite(e, { readings: ["0.12345"] }, "postgres")).toThrow("does not fit");
    expect(() => coerceRowOnWrite(e, { readings: ["100000"] }, "postgres")).toThrow("does not fit");
    expect(() => coerceRowOnWrite(e, { readings: "100.5" }, "postgres")).toThrow("is not an array");
  });

  test("write: a scalar decimal the column cannot hold is refused too", async () => {
    const e = await ledger();
    expect(coerceRowOnWrite(e, { amount: "12345.1000" }, "postgres").amount).toBe("12345.1");
    expect(() => coerceRowOnWrite(e, { amount: "0.12345" }, "postgres")).toThrow("does not fit");
  });
});

describe("a field.decimal inside a jsonb value object (captain ruling C1)", () => {
  async function invoice(): Promise<MetaData> {
    const model = { "metadata.root": { package: "ledger", children: [
      { "object.value": { name: "Money", children: [
        { "field.decimal": { name: "amount", "@precision": 9, "@scale": 4 } },
      ]}},
      { "object.entity": { name: "Invoice", children: [
        { "field.long": { name: "id" } },
        { "field.object": { name: "total", "@objectRef": "Money", "@storage": "jsonb" } },
        { "field.object": { name: "lines", "@objectRef": "Money", isArray: true, "@storage": "jsonb" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ]}},
    ]}};
    const { root, errors } = await new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(JSON.stringify(model), { id: "ledger.json" }),
    ]);
    expect(errors).toEqual([]);
    return root.objects().find((o) => o.name === "Invoice") as MetaData;
  }

  test("write: a string or exact number is bound as the canonical string, single and array", async () => {
    const e = await invoice();
    const out = coerceRowOnWrite(e, { id: 1, total: { amount: 100.25 }, lines: [{ amount: "2.5000" }, { amount: 0.3 }] }, "postgres");
    expect(JSON.parse(out.total as string)).toEqual({ amount: "100.25" });
    expect(JSON.parse(out.lines as string)).toEqual([{ amount: "2.5" }, { amount: "0.3" }]);
  });

  test("write: excess scale, a non-number, and an inexact JSON number are refused", async () => {
    const e = await invoice();
    for (const amount of ["0.12345", "100000", "12abc", 1234567890.123456789]) {
      expect(() => coerceRowOnWrite(e, { id: 1, total: { amount } }, "postgres")).toThrow(/field\.decimal 'amount' cannot be written/);
      expect(() => coerceRowOnWrite(e, { id: 1, lines: [{ amount }] }, "postgres")).toThrow(/field\.decimal 'amount' cannot be written/);
    }
  });

  test("read: a stored uncanonical string, or a number, is answered canonical", async () => {
    const e = await invoice();
    const out = coerceRowOnRead(e, { id: 1, total: '{"amount":"1.5000"}', lines: [{ amount: "2.50" }, { amount: 0.1 }] }, "postgres");
    expect(out.total).toEqual({ amount: "1.5" });
    expect(out.lines).toEqual([{ amount: "2.5" }, { amount: "0.1" }]);
  });
});

describe("runValidators on a decimal (ADR-0019 Amendment 1)", () => {
  test("a non-number, an inexact JSON number and an excess scale are validation failures, not thrown errors", async () => {
    const { runValidators } = await import("../src/validator-runner.js");
    const { root, errors } = await new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(JSON.stringify({ "metadata.root": { package: "p", children: [
        { "object.entity": { name: "E", children: [
          { "field.long": { name: "id" } },
          { "field.decimal": { name: "amt", "@precision": 9, "@scale": 4 } },
          { "identity.primary": { name: "pk", "@fields": "id" } },
        ]}},
      ]}}), { id: "p.json" }),
    ]);
    expect(errors).toEqual([]);
    const e = root.objects().find((o) => o.name === "E") as MetaData;
    expect(runValidators(e, { id: 1, amt: "1.5" }).ok).toBe(true);
    expect(runValidators(e, { id: 1, amt: 0.25 }).ok).toBe(true);
    for (const amt of ["12abc", "1.12345", "123456", 1234567890.123456789, true]) {
      expect(runValidators(e, { id: 1, amt }).ok).toBe(false);
    }
  });
});

describe("a field.decimal inside a value object held by a field.map (ADR-0019 Amendment 1, C1)", () => {
  async function doc(): Promise<MetaData> {
    const model = { "metadata.root": { package: "ledger", children: [
      { "object.value": { name: "Tier", children: [
        { "field.decimal": { name: "amount", "@precision": 9, "@scale": 4 } },
      ]}},
      { "object.value": { name: "Pricing", children: [
        { "field.map": { name: "tiers", "@objectRef": "Tier" } },
      ]}},
      { "object.entity": { name: "Doc", children: [
        { "field.long": { name: "id" } },
        { "field.map": { name: "tiers", "@objectRef": "Tier" } },
        { "field.object": { name: "pricing", "@objectRef": "Pricing", "@storage": "jsonb" } },
        { "field.map": { name: "labels", "@valueType": "string" } },
        { "identity.primary": { name: "pk", "@fields": "id" } },
      ]}},
    ]}};
    const { root, errors } = await new MetaDataLoader({ strict: true }).load([
      new InMemoryStringSource(JSON.stringify(model), { id: "ledger.json" }),
    ]);
    expect(errors).toEqual([]);
    return root.objects().find((o) => o.name === "Doc") as MetaData;
  }

  test("write: each map value is bound canonical, top-level and nested; a key named amount is only a key", async () => {
    const e = await doc();
    const out = coerceRowOnWrite(e, {
      id: 1,
      tiers: { amount: { amount: "1.5000" }, gold: { amount: 2.5 } },
      pricing: { tiers: { amount: { amount: 100 }, silver: { amount: "0.25" } } },
      labels: { amount: "1.5000" },
    }, "postgres");
    expect(out.tiers).toEqual({ amount: { amount: "1.5" }, gold: { amount: "2.5" } });
    expect(JSON.parse(out.pricing as string)).toEqual({ tiers: { amount: { amount: "100" }, silver: { amount: "0.25" } } });
    expect(out.labels).toEqual({ amount: "1.5000" });
  });

  test("write: excess scale in any map value is refused", async () => {
    const e = await doc();
    expect(() => coerceRowOnWrite(e, { id: 1, tiers: { gold: { amount: "0.12345" } } }, "postgres")).toThrow(/field\.decimal 'amount' cannot be written/);
    expect(() => coerceRowOnWrite(e, { id: 1, pricing: { tiers: { amount: { amount: "0.12345" } } } }, "postgres")).toThrow(/field\.decimal 'amount' cannot be written/);
  });

  test("read: stored uncanonical map values are answered canonical", async () => {
    const e = await doc();
    const out = coerceRowOnRead(e, { id: 1, tiers: { amount: { amount: "1.5000" } }, pricing: { tiers: { x: { amount: 2.5 } } } }, "postgres");
    expect(out.tiers).toEqual({ amount: { amount: "1.5" } });
    expect(out.pricing).toEqual({ tiers: { x: { amount: "2.5" } } });
  });

  test("runValidators: a map value with an excess scale fails, keyed by the map key", async () => {
    const { runValidators } = await import("../src/validator-runner.js");
    const e = await doc();
    expect(runValidators(e, { id: 1, tiers: { amount: { amount: "1.5" } } }).ok).toBe(true);
    const bad = runValidators(e, { id: 1, tiers: { amount: { amount: "0.12345" } } });
    expect(bad.ok).toBe(false);
    expect(runValidators(e, { id: 1, pricing: { tiers: { amount: { amount: "0.12345" } } } }).ok).toBe(false);
    expect(runValidators(e, { id: 1, labels: { amount: "0.12345" } }).ok).toBe(true);
  });
});
