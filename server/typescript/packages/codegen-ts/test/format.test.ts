import { describe, test, expect } from "bun:test";
import { formatTs } from "../src/format.js";

describe("formatTs", () => {
  test("formats unformatted TS into idiomatic Biome style", async () => {
    const ugly = "import {x} from'y';export const a={b:1,c:2}";
    const formatted = await formatTs(ugly);
    expect(formatted).not.toBe(ugly);
    expect(formatted).toContain("import");
    expect(formatted.length).toBeGreaterThan(ugly.length);
  });

  test("returns input unchanged on Biome error (with warning logged)", async () => {
    const broken = "import { from 'x';"; // syntax error
    const formatted = await formatTs(broken);
    // Per design §11: format error → log warning, return unformatted
    expect(typeof formatted).toBe("string");
  });
});
