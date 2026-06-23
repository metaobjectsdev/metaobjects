import { test, expect, describe } from "bun:test";
import { resolveFormat, toonEncode } from "../../src/lib/format.js";

describe("resolveFormat", () => {
  test("explicit flag wins over TTY", () => {
    expect(resolveFormat("toon", true)).toBe("toon");
    expect(resolveFormat("text", false)).toBe("text");
    expect(resolveFormat("json", true)).toBe("json");
  });
  test("default is TTY-aware: text on TTY, toon on non-TTY", () => {
    expect(resolveFormat(undefined, true)).toBe("text");
    expect(resolveFormat(undefined, false)).toBe("toon");
  });
});

describe("toonEncode", () => {
  test("emits tabular TOON for a uniform array of objects", () => {
    const out = toonEncode({ gen: [{ file: "a.ts", status: "new" }, { file: "b.ts", status: "new" }] });
    expect(out).toContain("gen[2]{file,status}:");
    expect(out).toContain("a.ts,new");
  });
});
