import { describe, test, expect } from "bun:test";
import { readXml } from "../../src/recover/xml-forgiving-reader.js";

// Mirrors Java XmlForgivingReaderTest / C# XmlForgivingReaderTests (FR-010 stage 4 — XML).
describe("xml forgiving reader", () => {
  test("flat children", () => {
    const m = readXml("<answer><t>hi</t><c>HIGH</c></answer>", false);
    expect(m["t"]).toBe("hi");
    expect(m["c"]).toBe("HIGH");
  });

  test("nested element", () => {
    const m = readXml("<answer><meta><n>1</n></meta></answer>", false);
    const nested = m["meta"] as Record<string, unknown>;
    expect(nested["n"]).toBe("1");
  });

  test("repeated siblings collapse to list", () => {
    const m = readXml("<answer><x>a</x><x>b</x></answer>", false);
    expect(m["x"]).toEqual(["a", "b"]);
  });

  test("attributes ignored for value", () => {
    const m = readXml("<answer><t lang='en' n=2>hi</t></answer>", false);
    expect(m["t"]).toBe("hi");
  });

  test("unclosed child recovers inner text", () => {
    const m = readXml("<answer><t>hi<c>HIGH</c></answer>", false);
    expect(m["t"]).toBe("hi");
    expect(m["c"]).toBe("HIGH");
  });

  test("case insensitive tags", () => {
    const m = readXml("<Answer><T>hi</T></Answer>", true);
    expect(m["t"]).toBe("hi");
  });

  test("span starting with close tag does not throw", () => {
    expect(() => readXml("</x>", false)).not.toThrow();
    expect(Object.keys(readXml("</x>", false))).toHaveLength(0);
  });

  test("degenerate close-tag-only does not throw", () => {
    expect(() => readXml("</>", false)).not.toThrow();
    expect(Object.keys(readXml("</>", false))).toHaveLength(0);
  });

  test("stray close tag then text does not throw", () => {
    expect(() => readXml("</foo>stuff", false)).not.toThrow();
  });

  test("null/blank safe", () => {
    expect(Object.keys(readXml(null, false))).toHaveLength(0);
    expect(Object.keys(readXml("   ", false))).toHaveLength(0);
  });
});
