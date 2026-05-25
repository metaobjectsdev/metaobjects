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
  const fixtures = readdirSync(CORPUS).filter((d) => {
    const expectedDir = join(CORPUS, d, "expected");
    if (!existsSync(expectedDir)) return false;
    return readdirSync(expectedDir).some((f) => f.endsWith(".output.ts"));
  });

  if (fixtures.length === 0) {
    it("(no fixtures with expected/*.output.ts found — placeholder)", () => {
      expect(true).toBe(true);
    });
    return;
  }

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
      const expectedFiles = readdirSync(expectedDir).filter((f) => f.endsWith(".output.ts"));
      for (const ef of expectedFiles) {
        const expected = readFileSync(join(expectedDir, ef), "utf8");
        const match = emitted.find((e) => e.path === ef);
        expect(match, `no emitted file for ${ef}`).toBeDefined();
        expect(match!.content).toBe(expected);
      }
    });
  }
});
