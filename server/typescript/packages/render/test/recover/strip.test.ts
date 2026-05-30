import { describe, test, expect } from "bun:test";
import { strip } from "../../src/recover/strip.js";

// Mirrors Java StripTest / C# StripTests (FR-010 stage 1).
describe("strip", () => {
  test("unwraps json fence", () => {
    const out = strip('Sure! Here you go:\n```json\n{"a":1}\n```\nHope that helps.');
    expect(out).toContain('{"a":1}');
    expect(out).not.toContain("```");
  });

  test("unwraps bare fence", () => {
    expect(strip('```\n{"a":1}\n```').trim()).toBe('{"a":1}');
  });

  test("unwraps xml fence", () => {
    const out = strip("```xml\n<a>1</a>\n```");
    expect(out).toContain("<a>1</a>");
    expect(out).not.toContain("```");
  });

  test("no fence returns trimmed input", () => {
    expect(strip('   {"a":1}   ')).toBe('{"a":1}');
  });

  test("null/undefined safe", () => {
    expect(strip(null)).toBe("");
    expect(strip(undefined)).toBe("");
  });
});
