// Biome's WebAssembly build is ~14 MB of module that only the owned-copy comparison uses.
// A static import would load it for every `meta` command, so the import stays dynamic.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalLines } from "../src/lib/owned-copy.js";

describe("owned-copy loads Biome on first use", () => {
  test("no value import of the Biome package at module level", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "lib", "owned-copy.ts"), "utf8");
    const valueImports = source.split("\n").filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l) && l.includes("@biomejs"));
    expect(valueImports).toEqual([]);
    expect(source).toContain('import("@biomejs/js-api")');
  });

  test("a comparison still formats, so the lazy load works", async () => {
    // Biome runs at line width 1, so a one-line object and an exploded one reach the same lines.
    const tight = await canonicalLines("const x = {a:1,b:2};\n");
    const loose = await canonicalLines("const x = {\n  a: 1,\n  b: 2,\n};\n");
    expect(tight).toEqual(loose);
    expect(tight).toContain("a: 1");
  });
});
