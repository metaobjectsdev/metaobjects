import { describe, test, expect } from "bun:test";
import { extract } from "../../src/extract/extract.js";
import {
  Format,
  FieldKind,
  FieldExtraction,
  scalar,
  enumField,
  object,
  extractSchema,
  type FieldSpec,
  type ExtractSchema,
} from "../../src/extract/types.js";

// Mirrors Java ExtractTest / C# ExtractTests (FR-010 entry-point pipeline).
function jsonAnswer(): ExtractSchema {
  return extractSchema(Format.JSON, "answer", [
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

describe("extract pipeline", () => {
  test("clean json all extracted", () => {
    const o = extract('{"text":"hi","confidence":"HIGH","note":"n"}', jsonAnswer());
    expect(o.data["text"]).toBe("hi");
    expect(o.data["confidence"]).toBe("HIGH");
    expect(o.report.states().get("confidence")).toBe(FieldExtraction.EXTRACTED);
    expect(o.report.hasLostRequired()).toBe(false);
  });

  test("fenced and prose-wrapped still extracts", () => {
    const dirty = 'Sure!\n```json\n{"text":"hi","confidence":"HIGH"}\n```\nDone.';
    const o = extract(dirty, jsonAnswer());
    expect(o.data["text"]).toBe("hi");
    expect(o.report.states().get("note")).toBe(FieldExtraction.LOST_OPTIONAL);
  });

  test("alias folds off-vocab", () => {
    const o = extract('{"text":"hi","confidence":"medium"}', jsonAnswer());
    expect(o.data["confidence"]).toBe("OK");
    expect(o.report.states().get("confidence")).toBe(FieldExtraction.EXTRACTED);
  });

  test("off-vocab required is malformed", () => {
    const o = extract('{"text":"hi","confidence":"banana"}', jsonAnswer());
    expect(o.report.states().get("confidence")).toBe(FieldExtraction.MALFORMED);
    expect(Object.prototype.hasOwnProperty.call(o.data, "confidence")).toBe(false);
  });

  test("missing required is lost_required", () => {
    const o = extract('{"text":"hi"}', jsonAnswer());
    expect(o.report.lostRequired()).toContain("confidence");
  });

  test("empty response flags empty and all required lost", () => {
    const o = extract("   ", jsonAnswer());
    expect(o.report.isEmpty()).toBe(true);
    expect(o.report.lostRequired()).toContain("text");
    expect(o.report.lostRequired()).toContain("confidence");
  });

  test("xml unclosed tag extracts", () => {
    const xml = extractSchema(Format.XML, "answer", [
      scalar("text", FieldKind.STRING, true),
      enumField("confidence", true, ["HIGH"], {}),
    ]);
    const o = extract("<answer><text>hi<confidence>HIGH</confidence></answer>", xml);
    expect(o.data["text"]).toBe("hi");
    expect(o.data["confidence"]).toBe("HIGH");
  });

  test("never throws on garbage", () => {
    const o = extract("@@@ totally broken @@@", jsonAnswer());
    expect(o.report.isEmpty()).toBe(true);
  });

  test("json string array extracts as list", () => {
    const s = extractSchema(Format.JSON, "answer", [arrayField("tags", FieldKind.STRING, null, null)]);
    const o = extract('{"tags":["a","b"]}', s);
    expect(o.data["tags"]).toEqual(["a", "b"]);
    expect(o.report.states().get("tags")).toBe(FieldExtraction.EXTRACTED);
  });

  test("json enum array coerces per element", () => {
    const s = extractSchema(Format.JSON, "answer", [arrayField("tones", FieldKind.ENUM, ["HIGH", "LOW"], { warm: "HIGH" })]);
    const o = extract('{"tones":["warm","LOW"]}', s);
    expect(o.data["tones"]).toEqual(["HIGH", "LOW"]);
    expect(o.report.states().get("tones")).toBe(FieldExtraction.EXTRACTED);
  });

  test("list for scalar field is malformed", () => {
    const s = extractSchema(Format.JSON, "answer", [scalar("text", FieldKind.STRING, true)]);
    const o = extract('{"text":["a","b"]}', s);
    expect(o.report.states().get("text")).toBe(FieldExtraction.MALFORMED);
    expect(Object.prototype.hasOwnProperty.call(o.data, "text")).toBe(false);
  });

  test("object field with scalar value is malformed", () => {
    const nested = extractSchema(Format.JSON, "meta", [scalar("n", FieldKind.STRING, true)]);
    const s = extractSchema(Format.JSON, "answer", [object("meta", true, false, nested)]);
    const o = extract('{"meta":"oops"}', s);
    expect(o.report.states().get("meta")).toBe(FieldExtraction.MALFORMED);
  });

  test("nested object descends and extracts", () => {
    const nested = extractSchema(Format.JSON, "meta", [scalar("n", FieldKind.STRING, true)]);
    const s = extractSchema(Format.JSON, "answer", [object("meta", true, false, nested)]);
    const o = extract('{"meta":{"n":"hello"}}', s);
    expect(o.report.states().get("meta")).toBe(FieldExtraction.EXTRACTED);
    expect(o.report.states().get("meta.n")).toBe(FieldExtraction.EXTRACTED);
    expect((o.data["meta"] as Record<string, unknown>)["n"]).toBe("hello");
  });

  test("truncated value is malformed not lost", () => {
    const o = extract('{"text":"hi","confidence":', jsonAnswer());
    expect(o.data["text"]).toBe("hi");
    expect(o.report.states().get("confidence")).toBe(FieldExtraction.MALFORMED);
    expect(o.report.isEmpty()).toBe(false);
  });

  test("partial enum array is malformed but keeps valid elements", () => {
    const s = extractSchema(Format.JSON, "answer", [arrayField("tones", FieldKind.ENUM, ["HIGH", "LOW"], {})]);
    const o = extract('{"tones":["HIGH","grape"]}', s);
    expect(o.report.states().get("tones")).toBe(FieldExtraction.MALFORMED);
    expect(o.data["tones"]).toEqual(["HIGH"]);
  });

  // ---- FR-011 DEFAULTED classification + @default absent-fill ----
  test("present-garbage enum with coerceDefault is DEFAULTED and satisfies required", () => {
    const s = extractSchema(Format.JSON, "answer", [
      enumField("confidence", true, ["HIGH", "LOW"], {}, "LOW"),
    ]);
    const o = extract('{"confidence":"banana"}', s);
    expect(o.data["confidence"]).toBe("LOW");
    expect(o.report.states().get("confidence")).toBe(FieldExtraction.DEFAULTED);
    expect(o.report.lostRequired()).not.toContain("confidence");
  });

  test("present-valid enum stays EXTRACTED (not DEFAULTED)", () => {
    const s = extractSchema(Format.JSON, "answer", [
      enumField("confidence", true, ["HIGH", "LOW"], {}, "LOW"),
    ]);
    const o = extract('{"confidence":"HIGH"}', s);
    expect(o.data["confidence"]).toBe("HIGH");
    expect(o.report.states().get("confidence")).toBe(FieldExtraction.EXTRACTED);
  });

  test("absent enum with @default is DEFAULTED and satisfies required", () => {
    const s = extractSchema(Format.JSON, "answer", [
      enumField("confidence", true, ["HIGH", "LOW"], {}, null, "strip", "HIGH"),
    ]);
    const o = extract("{}", s);
    expect(o.data["confidence"]).toBe("HIGH");
    expect(o.report.states().get("confidence")).toBe(FieldExtraction.DEFAULTED);
    expect(o.report.lostRequired()).not.toContain("confidence");
    expect(o.report.coercions().some((c) => c.fieldPath === "confidence" && c.kind === "default")).toBe(true);
  });

  test("absent enum without @default is LOST_REQUIRED", () => {
    const s = extractSchema(Format.JSON, "answer", [
      enumField("confidence", true, ["HIGH", "LOW"], {}, null),
    ]);
    const o = extract("{}", s);
    expect(o.report.lostRequired()).toContain("confidence");
    expect(Object.prototype.hasOwnProperty.call(o.data, "confidence")).toBe(false);
  });

  test("absent optional enum with @default fills DEFAULTED", () => {
    const s = extractSchema(Format.JSON, "answer", [
      enumField("confidence", false, ["HIGH", "LOW"], {}, null, "strip", "LOW"),
    ]);
    const o = extract("{}", s);
    expect(o.data["confidence"]).toBe("LOW");
    expect(o.report.states().get("confidence")).toBe(FieldExtraction.DEFAULTED);
  });

  test("nested object extracts with dotted child path EXTRACTED", () => {
    const nested = extractSchema(Format.JSON, "meta", [scalar("score", FieldKind.INT, true)]);
    const s = extractSchema(Format.JSON, "answer", [object("meta", true, false, nested)]);
    const o = extract('{"meta":{"score":7}}', s);
    expect(o.report.states().get("meta")).toBe(FieldExtraction.EXTRACTED);
    expect(o.report.states().get("meta.score")).toBe(FieldExtraction.EXTRACTED);
    expect((o.data["meta"] as Record<string, unknown>)["score"]).toBe(7);
  });
});
