import { describe, test, expect } from "bun:test";
import { locateJson, locateXml } from "../../src/recover/locate.js";

// Mirrors Java LocateTest / C# LocateTests (FR-010 stages 2-3).
describe("locate json", () => {
  test("isolates balanced object from prose", () => {
    expect(locateJson('Here is the result: {"a":1,"b":{"c":2}} — done.')).toBe('{"a":1,"b":{"c":2}}');
  });

  test("ignores braces inside strings", () => {
    const input = '{"text":"a } not a close","n":1}';
    expect(locateJson(input)).toBe(input);
  });

  test("truncated returns prefix to end", () => {
    expect(locateJson('prefix {"a":1,"b":')).toBe('{"a":1,"b":');
  });

  test("no brace returns null", () => {
    expect(locateJson("no object here")).toBeNull();
  });

  test("first closed candidate wins", () => {
    expect(locateJson('noise {"a":1} tail {"b":2}')).toBe('{"a":1}');
  });

  test("null safe", () => {
    expect(locateJson(null)).toBeNull();
    expect(locateJson(undefined)).toBeNull();
  });
});

describe("locate xml", () => {
  test("spans root", () => {
    expect(locateXml("blah <answer><t>hi</t></answer> blah", "answer", false)).toBe("<answer><t>hi</t></answer>");
  });

  test("unclosed root returns to end", () => {
    expect(locateXml("x <answer><t>hi</t>", "answer", false)).toBe("<answer><t>hi</t>");
  });

  test("case insensitive match", () => {
    expect(locateXml("<Answer><t>hi</t></Answer>", "answer", true)).toBe("<Answer><t>hi</t></Answer>");
  });

  test("no open returns null", () => {
    expect(locateXml("nothing", "answer", false)).toBeNull();
  });

  test("bare close tag does not throw and returns null", () => {
    expect(locateXml("</x>", "x", false)).toBeNull();
  });
});
