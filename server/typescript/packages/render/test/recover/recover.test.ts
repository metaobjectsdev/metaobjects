import { describe, test, expect } from "bun:test";
import { recover } from "../../src/recover/recover.js";
import {
  Format,
  FieldKind,
  FieldRecovery,
  scalar,
  enumField,
  object,
  recoverSchema,
  type FieldSpec,
  type RecoverSchema,
} from "../../src/recover/types.js";

// Mirrors Java RecoverTest / C# RecoverTests (FR-010 entry-point pipeline).
function jsonAnswer(): RecoverSchema {
  return recoverSchema(Format.JSON, "answer", [
    scalar("text", FieldKind.STRING, true),
    enumField("confidence", true, ["HIGH", "OK", "LOW"], { medium: "OK" }),
    scalar("note", FieldKind.STRING, false),
  ]);
}

function arrayField(name: string, kind: FieldKind, values: string[] | null, aliases: Record<string, string> | null): FieldSpec {
  return {
    name,
    kind,
    required: false,
    array: true,
    enumValues: values,
    enumAlias: aliases,
    min: null,
    max: null,
    nested: null,
    coerceDefault: null,
    defaultValue: null,
    normalize: "strip",
  };
}

describe("recover pipeline", () => {
  test("clean json all recovered", () => {
    const o = recover('{"text":"hi","confidence":"HIGH","note":"n"}', jsonAnswer());
    expect(o.data["text"]).toBe("hi");
    expect(o.data["confidence"]).toBe("HIGH");
    expect(o.report.states().get("confidence")).toBe(FieldRecovery.RECOVERED);
    expect(o.report.hasLostRequired()).toBe(false);
  });

  test("fenced and prose-wrapped still recovers", () => {
    const dirty = 'Sure!\n```json\n{"text":"hi","confidence":"HIGH"}\n```\nDone.';
    const o = recover(dirty, jsonAnswer());
    expect(o.data["text"]).toBe("hi");
    expect(o.report.states().get("note")).toBe(FieldRecovery.LOST_OPTIONAL);
  });

  test("alias folds off-vocab", () => {
    const o = recover('{"text":"hi","confidence":"medium"}', jsonAnswer());
    expect(o.data["confidence"]).toBe("OK");
    expect(o.report.states().get("confidence")).toBe(FieldRecovery.RECOVERED);
  });

  test("off-vocab required is malformed", () => {
    const o = recover('{"text":"hi","confidence":"banana"}', jsonAnswer());
    expect(o.report.states().get("confidence")).toBe(FieldRecovery.MALFORMED);
    expect(Object.prototype.hasOwnProperty.call(o.data, "confidence")).toBe(false);
  });

  test("missing required is lost_required", () => {
    const o = recover('{"text":"hi"}', jsonAnswer());
    expect(o.report.lostRequired()).toContain("confidence");
  });

  test("empty response flags empty and all required lost", () => {
    const o = recover("   ", jsonAnswer());
    expect(o.report.isEmpty()).toBe(true);
    expect(o.report.lostRequired()).toContain("text");
    expect(o.report.lostRequired()).toContain("confidence");
  });

  test("xml unclosed tag recovers", () => {
    const xml = recoverSchema(Format.XML, "answer", [
      scalar("text", FieldKind.STRING, true),
      enumField("confidence", true, ["HIGH"], {}),
    ]);
    const o = recover("<answer><text>hi<confidence>HIGH</confidence></answer>", xml);
    expect(o.data["text"]).toBe("hi");
    expect(o.data["confidence"]).toBe("HIGH");
  });

  test("never throws on garbage", () => {
    const o = recover("@@@ totally broken @@@", jsonAnswer());
    expect(o.report.isEmpty()).toBe(true);
  });

  test("json string array recovers as list", () => {
    const s = recoverSchema(Format.JSON, "answer", [arrayField("tags", FieldKind.STRING, null, null)]);
    const o = recover('{"tags":["a","b"]}', s);
    expect(o.data["tags"]).toEqual(["a", "b"]);
    expect(o.report.states().get("tags")).toBe(FieldRecovery.RECOVERED);
  });

  test("json enum array coerces per element", () => {
    const s = recoverSchema(Format.JSON, "answer", [arrayField("tones", FieldKind.ENUM, ["HIGH", "LOW"], { warm: "HIGH" })]);
    const o = recover('{"tones":["warm","LOW"]}', s);
    expect(o.data["tones"]).toEqual(["HIGH", "LOW"]);
    expect(o.report.states().get("tones")).toBe(FieldRecovery.RECOVERED);
  });

  test("list for scalar field is malformed", () => {
    const s = recoverSchema(Format.JSON, "answer", [scalar("text", FieldKind.STRING, true)]);
    const o = recover('{"text":["a","b"]}', s);
    expect(o.report.states().get("text")).toBe(FieldRecovery.MALFORMED);
    expect(Object.prototype.hasOwnProperty.call(o.data, "text")).toBe(false);
  });

  test("object field with scalar value is malformed", () => {
    const nested = recoverSchema(Format.JSON, "meta", [scalar("n", FieldKind.STRING, true)]);
    const s = recoverSchema(Format.JSON, "answer", [object("meta", true, false, nested)]);
    const o = recover('{"meta":"oops"}', s);
    expect(o.report.states().get("meta")).toBe(FieldRecovery.MALFORMED);
  });

  test("nested object descends and recovers", () => {
    const nested = recoverSchema(Format.JSON, "meta", [scalar("n", FieldKind.STRING, true)]);
    const s = recoverSchema(Format.JSON, "answer", [object("meta", true, false, nested)]);
    const o = recover('{"meta":{"n":"hello"}}', s);
    expect(o.report.states().get("meta")).toBe(FieldRecovery.RECOVERED);
    expect(o.report.states().get("meta.n")).toBe(FieldRecovery.RECOVERED);
    expect((o.data["meta"] as Record<string, unknown>)["n"]).toBe("hello");
  });

  test("truncated value is malformed not lost", () => {
    const o = recover('{"text":"hi","confidence":', jsonAnswer());
    expect(o.data["text"]).toBe("hi");
    expect(o.report.states().get("confidence")).toBe(FieldRecovery.MALFORMED);
    expect(o.report.isEmpty()).toBe(false);
  });

  test("partial enum array is malformed but keeps valid elements", () => {
    const s = recoverSchema(Format.JSON, "answer", [arrayField("tones", FieldKind.ENUM, ["HIGH", "LOW"], {})]);
    const o = recover('{"tones":["HIGH","grape"]}', s);
    expect(o.report.states().get("tones")).toBe(FieldRecovery.MALFORMED);
    expect(o.data["tones"]).toEqual(["HIGH"]);
  });
});
