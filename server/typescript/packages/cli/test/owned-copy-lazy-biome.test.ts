// Biome's WebAssembly build is ~14 MB of module that only the owned-copy comparison uses.
// Importing owned-copy must not load it; the first canonicalLines call must.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { canonicalLines } from "../src/lib/owned-copy.js";

const probe = `
import { plugin } from "bun";
const resolved = [];
plugin({
  name: "biome-probe",
  setup(build) {
    build.onResolve({ filter: /@biomejs/ }, (args) => {
      resolved.push(args.path);
      return undefined;
    });
  },
});
const { canonicalLines } = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "lib", "owned-copy.ts"))});
const afterImport = resolved.length;
await canonicalLines("const x = {a:1};\\n");
console.log(JSON.stringify({ afterImport, afterCall: resolved.length }));
`;

describe("owned-copy loads Biome on first use", () => {
  test("importing the module does not load Biome; the first comparison does", () => {
    const run = Bun.spawnSync([process.execPath, "-e", probe], { cwd: join(import.meta.dir, "..") });
    expect(run.exitCode).toBe(0);
    const { afterImport, afterCall } = JSON.parse(run.stdout.toString().trim().split("\n").pop() ?? "{}");
    expect(afterImport).toBe(0);
    expect(afterCall).toBeGreaterThan(0);
  });

  test("a comparison still formats, so the lazy load works", async () => {
    // Biome runs at line width 1, so a one-line object and an exploded one reach the same lines.
    const tight = await canonicalLines("const x = {a:1,b:2};\n");
    const loose = await canonicalLines("const x = {\n  a: 1,\n  b: 2,\n};\n");
    expect(tight).toEqual(loose);
    expect(tight).toContain("a: 1");
  });
});
