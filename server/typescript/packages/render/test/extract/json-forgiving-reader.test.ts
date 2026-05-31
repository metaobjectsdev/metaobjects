import { describe, test, expect } from "bun:test";
import { readJson, TRUNCATED } from "../../src/extract/json-forgiving-reader.js";

// Mirrors Java JsonForgivingReaderTest / C# JsonForgivingReaderTests (FR-010 stage 4),
// including the TRUNCATED sentinel and no-hang assertions.
describe("json forgiving reader", () => {
  test("clean object", () => {
    const m = readJson('{"a":"1","b":"two"}');
    expect(m["a"]).toBe("1");
    expect(m["b"]).toBe("two");
  });

  test("trailing comma", () => {
    const m = readJson('{"a":"1",}');
    expect(m["a"]).toBe("1");
    expect(Object.keys(m)).toHaveLength(1);
  });

  test("single quotes", () => {
    const m = readJson("{'a':'1'}");
    expect(m["a"]).toBe("1");
  });

  test("unquoted keys", () => {
    const m = readJson('{a:"1",b:"2"}');
    expect(m["a"]).toBe("1");
    expect(m["b"]).toBe("2");
  });

  test("nested object", () => {
    const m = readJson('{"a":{"b":"1"}}');
    const inner = m["a"] as Record<string, unknown>;
    expect(inner["b"]).toBe("1");
  });

  test("array values", () => {
    const m = readJson('{"xs":["a","b"]}');
    expect(m["xs"]).toEqual(["a", "b"]);
  });

  test("truncated extracts complete prefix keys", () => {
    const m = readJson('{"a":"1","b":"2","c":');
    expect(m["a"]).toBe("1");
    expect(m["b"]).toBe("2");
    expect(m["c"]).toBe(TRUNCATED);
  });

  test("unextractable returns empty", () => {
    expect(Object.keys(readJson("@@@@"))).toHaveLength(0);
  });

  test("malformed array brace-close does not hang", () => {
    const m = readJson('{"xs":[}');
    expect(Object.prototype.hasOwnProperty.call(m, "xs")).toBe(true);
  });

  test("malformed array brace-close after comma does not hang", () => {
    const m = readJson('{"xs":[1,}');
    expect(Array.isArray(m["xs"])).toBe(true);
  });

  test("empty value marks truncated", () => {
    const m = readJson('{"a":"1","c":}');
    expect(m["a"]).toBe("1");
    expect(m["c"]).toBe(TRUNCATED);
  });

  test("empty value whitespace marks truncated", () => {
    const m = readJson('{"a": }');
    expect(m["a"]).toBe(TRUNCATED);
  });

  test("empty value then more keys continues", () => {
    const m = readJson('{"a":,"b":"2"}');
    expect(m["a"]).toBe(TRUNCATED);
    expect(m["b"]).toBe("2");
  });

  test("never throws on arbitrary garbage", () => {
    const garbage = ['{', '{"', '{"a', '{"a"', '{"a":', '[', '{[]}', '{"x":[[[', '}}}', '{"x":{"y":'];
    for (const g of garbage) {
      expect(() => readJson(g)).not.toThrow();
    }
  });
});
