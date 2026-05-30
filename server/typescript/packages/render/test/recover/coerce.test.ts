import { describe, test, expect } from "bun:test";
import { coerceValue, MALFORMED } from "../../src/recover/coerce.js";
import {
  FieldKind,
  Tolerance,
  scalar,
  enumField,
  range,
  defaults,
  normalizeOptions,
  RecoveryReport,
} from "../../src/recover/types.js";

// Mirrors Java CoerceTest / C# CoerceTests (FR-010 stage 7 — scalar canonicalization).
describe("coerce", () => {
  // ---- enum ----
  test("enum exact match", () => {
    const f = enumField("tone", true, ["FRIENDLY", "HOSTILE"], {});
    expect(coerceValue("FRIENDLY", f, defaults(), "tone", new RecoveryReport())).toBe("FRIENDLY");
  });

  test("enum case-folded in normal", () => {
    const f = enumField("tone", true, ["FRIENDLY"], {});
    expect(coerceValue("friendly", f, defaults(), "tone", new RecoveryReport())).toBe("FRIENDLY");
  });

  test("enum strict does not case-fold", () => {
    const f = enumField("tone", true, ["FRIENDLY"], {});
    const opts = normalizeOptions({ tolerance: Tolerance.STRICT });
    expect(coerceValue("friendly", f, opts, "tone", new RecoveryReport())).toBe(MALFORMED);
  });

  test("enum schema alias folds", () => {
    const f = enumField("tone", true, ["FRIENDLY"], { warm: "FRIENDLY" });
    const rep = new RecoveryReport();
    expect(coerceValue("warm", f, defaults(), "tone", rep)).toBe("FRIENDLY");
    expect(rep.coercions().some((c) => c.kind === "alias")).toBe(true);
  });

  test("runtime alias wins over schema", () => {
    const f = enumField("tone", true, ["FRIENDLY", "HOSTILE"], { x: "FRIENDLY" });
    const opts = normalizeOptions({ tolerance: Tolerance.NORMAL, aliases: { x: "HOSTILE" } });
    const rep = new RecoveryReport();
    expect(coerceValue("x", f, opts, "tone", rep)).toBe("HOSTILE");
    expect(rep.coercions().some((c) => c.kind === "runtime-alias-override")).toBe(true);
  });

  test("enum off-vocab is malformed", () => {
    const f = enumField("tone", true, ["FRIENDLY"], {});
    expect(coerceValue("banana", f, defaults(), "tone", new RecoveryReport())).toBe(MALFORMED);
  });

  // ---- int / range ----
  test("int clamp to range", () => {
    const f = range("score", FieldKind.INT, true, 0, 10);
    const rep = new RecoveryReport();
    expect(coerceValue("42", f, defaults(), "score", rep)).toBe(10);
    expect(rep.coercions().some((c) => c.kind === "clamp")).toBe(true);
  });

  test("int unparseable malformed", () => {
    const f = scalar("score", FieldKind.INT, true);
    expect(coerceValue("abc", f, defaults(), "score", new RecoveryReport())).toBe(MALFORMED);
  });

  test("int truncates toward zero", () => {
    const f = scalar("score", FieldKind.INT, true);
    expect(coerceValue("42.9", f, defaults(), "score", new RecoveryReport())).toBe(42);
    expect(coerceValue("-3.9", f, defaults(), "score", new RecoveryReport())).toBe(-3);
  });

  // ---- boolean ----
  test("boolean forms", () => {
    const f = scalar("ok", FieldKind.BOOLEAN, true);
    expect(coerceValue("yes", f, defaults(), "ok", new RecoveryReport())).toBe(true);
    expect(coerceValue("0", f, defaults(), "ok", new RecoveryReport())).toBe(false);
  });

  // ---- onField hook ----
  test("onField hook wins", () => {
    const f = scalar("x", FieldKind.STRING, true);
    const opts = normalizeOptions({ onField: () => "HOOKED" });
    expect(coerceValue("anything", f, opts, "x", new RecoveryReport())).toBe("HOOKED");
  });

  // ---- non-finite guard ----
  test("NaN is malformed for double", () => {
    const f = scalar("n", FieldKind.DOUBLE, true);
    expect(coerceValue("NaN", f, defaults(), "n", new RecoveryReport())).toBe(MALFORMED);
  });

  test("Infinity is malformed for int", () => {
    const f = scalar("k", FieldKind.INT, true);
    expect(coerceValue("Infinity", f, defaults(), "k", new RecoveryReport())).toBe(MALFORMED);
    expect(coerceValue("-Infinity", f, defaults(), "k", new RecoveryReport())).toBe(MALFORMED);
  });

  test("JS-only radix-prefixed literals are malformed (cross-port parity)", () => {
    // Number("0x10")===16 in JS, but Java/C# numeric parsing rejects these → MALFORMED.
    const i = scalar("h", FieldKind.INT, true);
    const d = scalar("g", FieldKind.DOUBLE, true);
    for (const t of ["0x10", "0xFF", "0b101", "0o17", "+0x1", "-0b1"]) {
      expect(coerceValue(t, i, defaults(), "h", new RecoveryReport())).toBe(MALFORMED);
      expect(coerceValue(t, d, defaults(), "g", new RecoveryReport())).toBe(MALFORMED);
    }
  });

  // ---- normalizer ----
  test("normalizer by field name applied", () => {
    const f = scalar("x", FieldKind.STRING, true);
    const opts = normalizeOptions({ normalizers: { x: (raw) => raw.toUpperCase() } });
    const rep = new RecoveryReport();
    expect(coerceValue("hello", f, opts, "x", rep)).toBe("HELLO");
    expect(rep.coercions().some((c) => c.kind === "normalizer")).toBe(true);
  });

  test("null raw is malformed", () => {
    const f = scalar("x", FieldKind.STRING, true);
    expect(coerceValue(null, f, defaults(), "x", new RecoveryReport())).toBe(MALFORMED);
  });
});
