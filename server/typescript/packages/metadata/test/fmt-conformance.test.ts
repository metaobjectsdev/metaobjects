// Cross-port fmt conformance corpus (#304) — fixtures/fmt-conformance/.
// See that directory's README.md for the fixture format. Every port runs
// this same corpus against its own standalone single-file formatter; a
// mismatch is a bug in THIS port's formatter or serializer, never in the
// fixture (mirrors fixtures/conformance/'s own README rule).

import { describe, it, expect } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { composeRegistry } from "../src/provider.js";
import { coreProviders } from "../src/core-types.js";
import { formatMetadataFile } from "../src/fmt.js";

const CORPUS_DIR = join(import.meta.dir, "../../../../../fixtures/fmt-conformance");

const registry = composeRegistry(coreProviders);

const fixtures = readdirSync(CORPUS_DIR).filter((name) =>
  statSync(join(CORPUS_DIR, name)).isDirectory(),
);

describe("fmt conformance corpus", () => {
  it("found fixtures to run", () => {
    // A guard against a path typo silently turning this into a vacuous pass.
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    const dir = join(CORPUS_DIR, name);
    const inputPath = join(dir, "input.json");
    const expectedPath = join(dir, "expected.json");
    const expectedSkipPath = join(dir, "expected-skip.json");

    it(name, () => {
      const input = readFileSync(inputPath, "utf8");
      const result = formatMetadataFile(input, { registry, sourceId: "input.json" });

      let hasExpected = true;
      let expectedText = "";
      try {
        expectedText = readFileSync(expectedPath, "utf8");
      } catch {
        hasExpected = false;
      }

      if (hasExpected) {
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.text).toBe(expectedText);
      } else {
        const skip = JSON.parse(readFileSync(expectedSkipPath, "utf8")) as { reason: "overlay" | "error" };
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.overlay).toBe(skip.reason === "overlay");
      }
    });
  }
});
