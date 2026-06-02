import { describe, test, expect } from "bun:test";
import { readXml, TEXT_KEY } from "../../src/extract/xml-forgiving-reader.js";

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

  test("attributes parsed alongside text", () => {
    const m = readXml("<answer><t lang='en' n=2>hi</t></answer>", false);
    const t = m["t"] as Record<string, unknown>;
    expect(t["lang"]).toBe("en");
    expect(t["n"]).toBe("2");
    expect(t[TEXT_KEY]).toBe("hi");
  });

  test("self-closing all attributes", () => {
    const m = readXml('<answer><check id="A" status="ok"/></answer>', false);
    const check = m["check"] as Record<string, unknown>;
    expect(check["id"]).toBe("A");
    expect(check["status"]).toBe("ok");
  });

  test("attributes merge with child elements", () => {
    const m = readXml(
      '<answer><correction id="NPC-004"><reason>r</reason><area>a</area></correction></answer>',
      false,
    );
    const c = m["correction"] as Record<string, unknown>;
    expect(c["id"]).toBe("NPC-004");
    expect(c["reason"]).toBe("r");
    expect(c["area"]).toBe("a");
  });

  test("self-closing no attributes no space", () => {
    const m = readXml("<answer><br/></answer>", false);
    expect(m["br"]).toBe("");
  });

  test("repeated self-closing collapse to list of records", () => {
    const m = readXml('<answer><x a="1"/><x a="2"/></answer>', false);
    const list = m["x"] as Array<Record<string, unknown>>;
    expect(list.length).toBe(2);
    expect(list[0]["a"]).toBe("1");
    expect(list[1]["a"]).toBe("2");
  });

  test("unclosed child extracts inner text", () => {
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
