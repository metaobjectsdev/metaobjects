// embedded-library — gates the generated embedded library module
// (embedded-library.generated.ts) against the canonical library/**/*.yaml
// source files.
//
// Three guarantees:
//   1. DRIFT GATE — every canonical library/**/*.yaml has a byte-identical
//      entry in EMBEDDED_LIBRARY under its ref (path under library/ minus
//      the .yaml suffix).
//   2. EXACT COVERAGE — the embedded map keys are exactly the canonical set
//      (no missing, no extra).
//   3. Content sanity — the known "ai/llm-call" entry contains expected text.

import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { EMBEDDED_LIBRARY } from "../src/library/embedded-library.generated.ts";

function repoRoot(): string {
  let dir = import.meta.dir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "library")) && existsSync(join(dir, "server"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found");
}
const root = repoRoot();
const libDir = join(root, "library");

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith(".yaml")) out.push(p);
  }
  return out;
}
const canonical = collect(libDir).map((abs) => ({
  ref: relative(libDir, abs).replace(/\.yaml$/, "").split("\\").join("/"),
  content: readFileSync(abs, "utf-8"),
}));

describe("EMBEDDED_LIBRARY — drift gate", () => {
  for (const { ref, content } of canonical) {
    test(`${ref} is byte-identical to canonical library/${ref}.yaml`, () => {
      expect(EMBEDDED_LIBRARY[ref]).toBeDefined();
      expect(EMBEDDED_LIBRARY[ref]).toBe(content);
    });
  }
});

describe("EMBEDDED_LIBRARY — exact coverage", () => {
  test("keys are exactly the canonical set", () => {
    expect(Object.keys(EMBEDDED_LIBRARY).sort()).toEqual(canonical.map((c) => c.ref).sort());
  });
});

describe("EMBEDDED_LIBRARY — content sanity", () => {
  test("ai/llm-call entry contains the LlmCallBase definition", () => {
    expect(EMBEDDED_LIBRARY["ai/llm-call"]).toContain("LlmCallBase");
  });
});
