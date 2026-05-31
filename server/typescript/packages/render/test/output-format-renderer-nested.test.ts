import { describe, test, expect } from "bun:test";
import { renderOutputFormat, Format, FieldKind, PromptStyle } from "../src/index.js";
import type { OutputFormatSpec, PromptField } from "../src/index.js";

function f(p: Partial<PromptField> & { name: string; kind: FieldKind }): PromptField {
  return {
    name: p.name, kind: p.kind, required: p.required ?? true, array: p.array ?? false,
    enumValues: p.enumValues ?? null, enumDoc: p.enumDoc ?? null,
    example: p.example ?? null, instruction: p.instruction ?? null, nested: p.nested ?? null,
  };
}
const spec = (format: Format, rootName: string, fields: PromptField[]): OutputFormatSpec =>
  ({ format, rootName, style: PromptStyle.GUIDE, fields });
const NONE = { examples: {}, instructions: {} };

const review = (fmt: Format) =>
  spec(fmt, "Review", [
    f({ name: "summary", kind: FieldKind.STRING, example: "Solid work overall.", instruction: "One sentence." }),
    f({ name: "meta", kind: FieldKind.OBJECT, nested: spec(fmt, "Meta", [
      f({ name: "score", kind: FieldKind.INT, example: "5", instruction: "1-5." }),
    ]) }),
  ]);

describe("FR-012 nested expansion", () => {
  test("nested object — exampleOnly json", () => {
    expect(renderOutputFormat(review(Format.JSON), { ...NONE, style: PromptStyle.EXAMPLE_ONLY })).toBe(
      `{\n  "summary": "Solid work overall.",\n  "meta": {\n    "score": 5\n  }\n}`,
    );
  });
  test("nested object — exampleOnly xml", () => {
    expect(renderOutputFormat(review(Format.XML), { ...NONE, style: PromptStyle.EXAMPLE_ONLY })).toBe(
      `<Review>\n  <summary>Solid work overall.</summary>\n  <meta>\n    <score>5</score>\n  </meta>\n</Review>`,
    );
  });
  test("nested object — inline json", () => {
    expect(renderOutputFormat(review(Format.JSON), { ...NONE, style: PromptStyle.INLINE })).toBe(
      `{\n  "summary": "{One sentence.}",\n  "meta": {\n    "score": "{1-5.}"\n  }\n}`,
    );
  });
  test("nested object — guide json", () => {
    expect(renderOutputFormat(review(Format.JSON), { ...NONE, style: PromptStyle.GUIDE })).toBe(
      `Fill in each field as described below:\n` +
      `- summary (required): One sentence.\n    e.g. Solid work overall.\n` +
      `- meta (required)\n` +
      `- meta.score (required): 1-5.\n    e.g. 5\n` +
      `\nRespond exactly like this:\n` +
      `{\n  "summary": "Solid work overall.",\n  "meta": {\n    "score": 5\n  }\n}`,
    );
  });
  test("array of objects — exampleOnly json", () => {
    const s = spec(Format.JSON, "Bundle", [
      f({ name: "items", kind: FieldKind.OBJECT, array: true, nested: spec(Format.JSON, "Item", [
        f({ name: "label", kind: FieldKind.STRING, example: "spec" }),
      ]) }),
    ]);
    expect(renderOutputFormat(s, { ...NONE, style: PromptStyle.EXAMPLE_ONLY })).toBe(
      `{\n  "items": [\n    {\n      "label": "spec"\n    }\n  ]\n}`,
    );
  });
  test("scalar array — exampleOnly json", () => {
    const s = spec(Format.JSON, "Tagging", [f({ name: "tags", kind: FieldKind.STRING, array: true })]);
    expect(renderOutputFormat(s, { ...NONE, style: PromptStyle.EXAMPLE_ONLY })).toBe(
      `{\n  "tags": [\n    "{tags}"\n  ]\n}`,
    );
  });
  test("depth guard — over-deep chain falls back to flat placeholder, never throws", () => {
    let leaf: OutputFormatSpec = spec(Format.JSON, "L", [f({ name: "v", kind: FieldKind.STRING, example: "x" })]);
    for (let i = 0; i < 12; i++) {
      leaf = spec(Format.JSON, `N${i}`, [f({ name: "child", kind: FieldKind.OBJECT, nested: leaf })]);
    }
    const out = renderOutputFormat(leaf, { ...NONE, style: PromptStyle.EXAMPLE_ONLY });
    expect(out).toContain(`"child": "{child}"`);
    expect(typeof out).toBe("string");
  });
});
