import { describe, test, expect } from "bun:test";
import { formatTs } from "../src/format.js";
import { formatTs as formatTsFromEntry } from "../src/index.js";

// Generation runs no formatter. `formatTs` stays exported only so a generator copied out
// with `meta eject` in 1.2 (which imports it from the package entry) still loads.
describe("formatTs", () => {
  test("is exported from the package entry, for owned 1.2 generator copies", () => {
    expect(formatTsFromEntry).toBe(formatTs);
  });

  test("returns its input unchanged", async () => {
    const ugly = "import {x} from'y';export const a={b:1,c:2}";
    expect(await formatTs(ugly)).toBe(ugly);
  });

  test("returns invalid TypeScript unchanged, with nothing logged", async () => {
    const warnings: unknown[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args);
    try {
      expect(await formatTs("import { from 'x';")).toBe("import { from 'x';");
    } finally {
      console.warn = warn;
    }
    expect(warnings).toEqual([]);
  });
});
