import { describe, test, expect } from "bun:test";
import { strip } from "../../src/extract/strip.js";

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

describe("strip: fence closing", () => {
  test("backticks inside a JSON string do not close the fence", () => {
    const out = strip('```json\n{"summary": "run ```make``` first", "score": 7}\n```');
    expect(out).toBe('{"summary": "run ```make``` first", "score": 7}');
  });

  test("a longer opening fence is closed only by an equal-or-longer run", () => {
    const out = strip('````md\nbefore\n```\ninner\n```\nafter\n````\ntail');
    expect(out).toBe("before\n```\ninner\n```\nafter\ntail");
  });

  test("a closing fence on the payload's own line is accepted at the end of the text", () => {
    expect(strip('```json\n{"a":1}```')).toBe('{"a":1}');
  });

  test("an unclosed fence is not a fence", () => {
    expect(strip('```json\n{"a":1}')).toBe('```json\n{"a":1}');
  });
});
