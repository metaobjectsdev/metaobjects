// The null-member rewrite of a value object column (`wire.nullMembers`, ADR-0019 Amendment 2).

import { describe, test, expect } from "bun:test";
import { nullMembersWire, withWire, type ValueObjectShape } from "../src/wire-format.js";

const money: ValueObjectShape = { members: ["label", "amount", "note"] };

describe("nullMembersWire", () => {
  test("native and absent do nothing", () => {
    expect(nullMembersWire({ total: money }, "native")).toBeUndefined();
    expect(nullMembersWire({ total: money }, undefined)).toBeUndefined();
    expect(nullMembersWire({}, "omit")).toBeUndefined();
  });

  test("omit drops null members, in a single value, an array and a map", () => {
    const wire = nullMembersWire({ total: money, lines: money, byKey: { ...money, map: true } }, "omit")!;
    expect(
      wire({
        id: 1,
        other: null,
        total: { label: "a", amount: null },
        lines: [{ label: null, amount: "1.50" }, { amount: "2" }],
        byKey: { amount: { label: null, amount: "3" } },
      }),
    ).toEqual({
      id: 1,
      other: null,
      total: { label: "a" },
      lines: [{ amount: "1.50" }, { amount: "2" }],
      byKey: { amount: { amount: "3" } },
    });
  });

  test("emit writes every declared member, null when unset", () => {
    const wire = nullMembersWire({ total: money, lines: money }, "emit")!;
    const out = wire({ total: { label: "a" }, lines: [{ amount: "1.50", note: null }], untouched: null }) as Record<string, unknown>;
    expect(out["total"]).toEqual({ label: "a", amount: null, note: null });
    expect(out["lines"]).toEqual([{ label: null, amount: "1.50", note: null }]);
    expect(out["untouched"]).toBeNull();
    expect(Object.keys(out["total"] as object)).toEqual(["label", "amount", "note"]);
  });

  test("a nested value object is shaped too, and a null column stays null", () => {
    const outer: ValueObjectShape = { members: ["name", "addr"], nested: { addr: { members: ["city", "zip"] } } };
    const emit = nullMembersWire({ person: outer }, "emit")!;
    expect(emit({ person: { name: "x", addr: { city: "Oslo" } } })).toEqual({ person: { name: "x", addr: { city: "Oslo", zip: null } } });
    expect(emit({ person: null })).toEqual({ person: null });
    const omit = nullMembersWire({ person: outer }, "omit")!;
    expect(omit({ person: { name: null, addr: { city: "Oslo", zip: null } } })).toEqual({ person: { addr: { city: "Oslo" } } });
  });
});

describe("withWire", () => {
  test("composes the decimal and null-member rewrites after the base mapper", () => {
    const toWire = withWire((r) => r, {
      decimalColumns: ["price"],
      decimalWire: "string",
      nullMembers: "omit",
      valueObjects: { total: money },
    });
    expect(toWire({ price: "12.50", total: { label: null, amount: "1" } })).toEqual({ price: "12.5", total: { amount: "1" } });
    const native = withWire((r) => r, { decimalColumns: ["price"], valueObjects: { total: money } });
    expect(native({ price: "12.50", total: { label: null } })).toEqual({ price: "12.50", total: { label: null } });
  });
});
