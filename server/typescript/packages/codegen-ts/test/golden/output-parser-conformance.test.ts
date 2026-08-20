// Conformance check: outputParser() codegen output matches
// fixtures/conformance/<name>/expected/*.output.ts byte-for-byte.
//
// For every conformance fixture that ships any expected/*.output.ts file, this
// test loads the input metadata, runs outputParser(), and asserts byte-identical
// match. Fixtures without expected/*.output.ts are skipped.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { outputParser } from "../../src/generators/output-parser-file.js";
import type { GenContext } from "../../src/generator.js";

const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/conformance");

function makeCtx(root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"]): GenContext {
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", dialect: "sqlite" } as never,
    warn: () => {},
  };
}

describe("outputParser() conformance fixtures", () => {
  // ADR-0052 renamed the emitted parser `<Output>.output.ts` → `<Prompt>.response.ts`.
  // Both suffixes are accepted so the discovery survives the transition.
  const GOLDEN_SUFFIXES = [".response.ts", ".output.ts"] as const;

  const fixtures = readdirSync(CORPUS).filter((d) => {
    const expectedDir = join(CORPUS, d, "expected");
    if (!existsSync(expectedDir)) return false;
    return readdirSync(expectedDir).some((f) =>
      GOLDEN_SUFFIXES.some((s) => f.endsWith(s)),
    );
  });

  // A discovery-driven suite that PASSES on zero matches is worse than no suite:
  // rename the golden and it silently stops asserting anything while still
  // reporting green. It used to install an `expect(true).toBe(true)` placeholder
  // here, which is exactly that failure. Fail loudly instead — if the corpus
  // genuinely has no parser goldens, that is a fact someone must state on purpose.
  it("discovers at least one parser golden (guards against a silently vacuous suite)", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });
  if (fixtures.length === 0) return;

  for (const fixture of fixtures) {
    it(`fixture ${fixture}: outputParser() byte-matches expected/*.output.ts`, async () => {
      const inputDir = join(CORPUS, fixture, "input");
      const inputFiles = readdirSync(inputDir).filter((f) => f.endsWith(".json"));
      expect(inputFiles.length).toBeGreaterThan(0);
      const sources = inputFiles.map(
        (f) =>
          new InMemoryStringSource(
            readFileSync(join(inputDir, f), "utf-8"),
            { id: f, format: "json" },
          ),
      );
      const res = await new MetaDataLoader().load(sources);
      expect(res.errors).toEqual([]);

      const gen = outputParser();
      const emitted = await gen.generate(makeCtx(res.root));

      const expectedDir = join(CORPUS, fixture, "expected");
      // Filter by the SAME suffix set discovery used. Filtering on `.output.ts` alone
      // here would re-create the vacuous-suite bug one line below the comment warning
      // about it: discovery would admit a fixture on its `.response.ts` golden, then
      // the loop would match zero files and assert nothing while reporting green.
      const expectedFiles = readdirSync(expectedDir).filter((f) =>
        GOLDEN_SUFFIXES.some((s) => f.endsWith(s)),
      );
      expect(expectedFiles.length).toBeGreaterThan(0);
      for (const ef of expectedFiles) {
        const expected = readFileSync(join(expectedDir, ef), "utf8");
        const match = emitted.find((e) => e.path === ef);
        expect(match, `no emitted file for ${ef}`).toBeDefined();
        expect(match!.content).toBe(expected);
      }
    });
  }
});
