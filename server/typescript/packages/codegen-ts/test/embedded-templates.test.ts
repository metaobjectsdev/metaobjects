// embedded-templates — gates the generated embedded framework-doc templates
// module (embedded-templates.generated.ts) that lets framework templates
// resolve inside the `bun build --compile` standalone `meta` binary, where the
// on-disk `templates/` directory does not exist.
//
// Three guarantees:
//   1. DRIFT GATE — every canonical templates/docs/*.mustache has a
//      byte-identical entry in EMBEDDED_FRAMEWORK_TEMPLATES under the ref the
//      provider resolves with (path under templates/ minus the .mustache).
//   2. EXACT COVERAGE — the embedded map keys are exactly the canonical set
//      (no missing, no extra).
//   3. BINARY FALLBACK — the embedded map resolves the framework refs the
//      binary needs (docs/entity-page.md, docs/template-page.md), and the
//      public frameworkTemplatesProvider resolves them too (via on-disk in
//      tests; the embedded map is what the binary falls back to).

import { describe, it, test, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { EMBEDDED_FRAMEWORK_TEMPLATES } from "../src/render-engine/embedded-templates.generated.js";
import { frameworkTemplatesProvider } from "../src/render-engine/framework-provider.js";

// Walk UP from this test file's dir until we find a dir containing BOTH
// templates/ and server/ — that's the repo root. No hardcoded absolute paths.
function findRepoRoot(start: string): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "templates")) && existsSync(join(dir, "server"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repo root (dir containing templates/ and server/)");
    }
    dir = parent;
  }
}

const repoRoot = findRepoRoot(import.meta.dir);
const canonicalDir = join(repoRoot, "templates", "docs");

// Canonical *.mustache files and their resolve refs (path under templates/
// minus the .mustache suffix). e.g. entity-page.md.mustache -> docs/entity-page.md
const canonicalFiles = readdirSync(canonicalDir).filter((f) => f.endsWith(".mustache"));
const canonicalRefs = canonicalFiles.map((f) => `docs/${f.slice(0, -".mustache".length)}`);

describe("EMBEDDED_FRAMEWORK_TEMPLATES — drift gate", () => {
  for (const file of canonicalFiles) {
    const ref = `docs/${file.slice(0, -".mustache".length)}`;
    it(`${ref} is byte-identical to canonical templates/docs/${file}`, () => {
      const canonical = readFileSync(join(canonicalDir, file), "utf-8");
      expect(EMBEDDED_FRAMEWORK_TEMPLATES[ref]).toBeDefined();
      expect(EMBEDDED_FRAMEWORK_TEMPLATES[ref]).toBe(canonical);
    });
  }
});

describe("EMBEDDED_FRAMEWORK_TEMPLATES — exact coverage", () => {
  test("keys are exactly the canonical set (no missing, no extra)", () => {
    const embeddedKeys = Object.keys(EMBEDDED_FRAMEWORK_TEMPLATES).sort();
    expect(embeddedKeys).toEqual([...canonicalRefs].sort());
  });
});

describe("EMBEDDED_FRAMEWORK_TEMPLATES — binary fallback", () => {
  // The two framework refs the compiled `meta docs` path needs.
  for (const ref of ["docs/entity-page.md", "docs/template-page.md"]) {
    test(`embedded map resolves ${ref} (the binary's source of truth)`, () => {
      const embedded = EMBEDDED_FRAMEWORK_TEMPLATES[ref];
      expect(typeof embedded).toBe("string");
      expect(embedded!.length).toBeGreaterThan(0);
    });

    test(`frameworkTemplatesProvider resolves ${ref} and matches the embedded content`, () => {
      // In tests the on-disk dir exists, so this resolves via disk; the
      // embedded entry must agree byte-for-byte (so the binary fallback is
      // equivalent to the dev path).
      const resolved = frameworkTemplatesProvider.resolve(ref);
      expect(typeof resolved).toBe("string");
      expect(resolved).toBe(EMBEDDED_FRAMEWORK_TEMPLATES[ref]);
    });
  }

  test("an unknown ref is undefined in the embedded map", () => {
    expect(EMBEDDED_FRAMEWORK_TEMPLATES["docs/nope.md"]).toBeUndefined();
  });
});
