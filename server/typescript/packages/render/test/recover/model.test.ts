import { describe, test, expect } from "bun:test";
import {
  Format,
  FieldKind,
  FieldRecovery,
  Tolerance,
  scalar,
  enumField,
  range,
  object,
  recoverSchema,
  defaults,
  normalizeOptions,
  RecoveryReport,
} from "../../src/recover/types.js";

// Mirrors Java ModelTest + ReportTest / C# ModelTests.
describe("model: FieldSpec factories", () => {
  test("scalar builds with expected defaults", () => {
    const f = scalar("confidence", FieldKind.STRING, true);
    expect(f.name).toBe("confidence");
    expect(f.kind).toBe(FieldKind.STRING);
    expect(f.required).toBe(true);
    expect(f.array).toBe(false);
    expect(f.enumValues).toBeNull();
    expect(f.enumAlias).toBeNull();
    expect(f.min).toBeNull();
    expect(f.max).toBeNull();
    expect(f.nested).toBeNull();
  });

  test("enumField carries values and aliases", () => {
    const f = enumField("tone", true, ["FRIENDLY", "NEUTRAL", "HOSTILE"], { warm: "FRIENDLY" });
    expect(f.kind).toBe(FieldKind.ENUM);
    expect(f.enumValues).toEqual(["FRIENDLY", "NEUTRAL", "HOSTILE"]);
    expect(f.enumAlias).not.toBeNull();
    expect(f.enumAlias?.["warm"]).toBe("FRIENDLY");
  });

  test("enumField null aliases yields empty record", () => {
    const f = enumField("tone", false, ["A", "B"], null);
    expect(f.enumAlias).toEqual({});
  });

  test("range carries min and max", () => {
    const f = range("score", FieldKind.DOUBLE, true, 0, 1);
    expect(f.kind).toBe(FieldKind.DOUBLE);
    expect(f.min).toBe(0);
    expect(f.max).toBe(1);
    expect(f.enumValues).toBeNull();
    expect(f.nested).toBeNull();
  });

  test("object carries nested schema", () => {
    const nested = recoverSchema(Format.JSON, "inner", [scalar("x", FieldKind.INT, true)]);
    const f = object("payload", true, false, nested);
    expect(f.kind).toBe(FieldKind.OBJECT);
    expect(f.required).toBe(true);
    expect(f.array).toBe(false);
    expect(f.nested?.rootName).toBe("inner");
  });

  test("object array sets array flag", () => {
    const f = object("items", false, true, recoverSchema(Format.JSON, "item", []));
    expect(f.array).toBe(true);
  });
});

describe("model: RecoverSchema", () => {
  test("carries format, root, fields", () => {
    const schema = recoverSchema(Format.XML, "answer", [scalar("text", FieldKind.STRING, true)]);
    expect(schema.format).toBe(Format.XML);
    expect(schema.rootName).toBe("answer");
    expect(schema.fields).toHaveLength(1);
  });

  test("null fields yields empty list", () => {
    const schema = recoverSchema(Format.JSON, "root", null);
    expect(schema.fields).toEqual([]);
  });
});

describe("model: RecoverOptions", () => {
  test("defaults: normal tolerance, empty maps, null hook", () => {
    const opts = defaults();
    expect(opts.tolerance).toBe(Tolerance.NORMAL);
    expect(opts.aliases).toEqual({});
    expect(opts.normalizers).toEqual({});
    expect(opts.onField).toBeNull();
  });

  test("normalizeOptions(undefined) returns defaults", () => {
    const opts = normalizeOptions(undefined);
    expect(opts.tolerance).toBe(Tolerance.NORMAL);
    expect(opts.onField).toBeNull();
  });

  test("normalizeOptions overrides tolerance", () => {
    const opts = normalizeOptions({ tolerance: Tolerance.STRICT });
    expect(opts.tolerance).toBe(Tolerance.STRICT);
    expect(opts.aliases).toEqual({});
  });
});

describe("model: RecoveryReport", () => {
  test("lostRequired filters to LOST_REQUIRED states", () => {
    const r = new RecoveryReport();
    r.set("a", FieldRecovery.RECOVERED);
    r.set("b", FieldRecovery.LOST_REQUIRED);
    r.set("c", FieldRecovery.LOST_REQUIRED);
    r.set("d", FieldRecovery.DEFAULTED);
    expect(r.lostRequired()).toEqual(["b", "c"]);
    expect(r.hasLostRequired()).toBe(true);
  });

  test("markEmpty sets flag; hasLostRequired false", () => {
    const r = new RecoveryReport();
    r.markEmpty();
    expect(r.isEmpty()).toBe(true);
    expect(r.hasLostRequired()).toBe(false);
  });

  test("states returns snapshot with all entries", () => {
    const r = new RecoveryReport();
    r.set("x", FieldRecovery.RECOVERED);
    r.set("y", FieldRecovery.MALFORMED);
    const snap = r.states();
    expect(snap.size).toBe(2);
    expect(snap.get("x")).toBe(FieldRecovery.RECOVERED);
    expect(snap.get("y")).toBe(FieldRecovery.MALFORMED);
  });

  test("coercions returns all in order", () => {
    const r = new RecoveryReport();
    r.addCoercion({ fieldPath: "a", from: "raw", to: "ALIAS", kind: "alias" });
    r.addCoercion({ fieldPath: "b", from: "x", to: "y", kind: "clamp" });
    const list = r.coercions();
    expect(list).toHaveLength(2);
    expect(list[0]?.kind).toBe("alias");
    expect(list[1]?.kind).toBe("clamp");
  });

  test("malformed filters to MALFORMED states", () => {
    const r = new RecoveryReport();
    r.set("ok", FieldRecovery.RECOVERED);
    r.set("bad", FieldRecovery.MALFORMED);
    expect(r.malformed()).toEqual(["bad"]);
  });

  test("states insertion order preserved", () => {
    const r = new RecoveryReport();
    r.set("z", FieldRecovery.RECOVERED);
    r.set("a", FieldRecovery.RECOVERED);
    r.set("m", FieldRecovery.RECOVERED);
    expect([...r.states().keys()]).toEqual(["z", "a", "m"]);
  });
});

describe("model: FieldRecovery names match corpus", () => {
  test("frozen string values", () => {
    expect(FieldRecovery.RECOVERED).toBe("RECOVERED");
    expect(FieldRecovery.DEFAULTED).toBe("DEFAULTED");
    expect(FieldRecovery.LOST_OPTIONAL).toBe("LOST_OPTIONAL");
    expect(FieldRecovery.LOST_REQUIRED).toBe("LOST_REQUIRED");
    expect(FieldRecovery.MALFORMED).toBe("MALFORMED");
  });
});
