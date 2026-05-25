// Conformance check: promptRender() codegen output matches fixtures/conformance/<name>/expected/prompts.ts
//
// For every conformance fixture that ships an expected/prompts.ts file, this
// test loads the input metadata, runs promptRender(), and asserts byte-identical
// match. Fixtures without expected/prompts.ts are skipped — no change to
// existing fixtures required.
//
// This file lives in codegen-ts/test/golden/ (not metadata/test/conformance/)
// to avoid an import-direction cycle: codegen-ts already depends on metadata;
// metadata must not depend on codegen-ts.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { promptRender } from "../../src/generators/prompt-render-file.js";
import type { GenContext } from "../../src/generator.js";

// Corpus is six levels up from this file:
//   test/golden → test → codegen-ts → packages → typescript → server → worktree-root/fixtures/conformance
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

// Discover fixtures that have expected/prompts.ts
const fixtures = readdirSync(CORPUS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => existsSync(join(CORPUS, name, "expected", "prompts.ts")));

describe("promptRender() conformance — expected/prompts.ts byte-match", () => {
  if (fixtures.length === 0) {
    it("no fixtures have expected/prompts.ts yet (placeholder)", () => {
      expect(true).toBe(true);
    });
  }

  for (const fixtureName of fixtures) {
    it(`${fixtureName} — prompts.ts matches byte-for-byte`, async () => {
      const inputDir = join(CORPUS, fixtureName, "input");
      const expectedPath = join(CORPUS, fixtureName, "expected", "prompts.ts");

      // Load all .json files from the input directory
      const inputFiles = readdirSync(inputDir).filter((f) => f.endsWith(".json"));
      const sources = inputFiles.map((f) =>
        new InMemoryStringSource(
          readFileSync(join(inputDir, f), "utf-8"),
          { id: f, format: "json" },
        ),
      );

      const res = await new MetaDataLoader().load(sources);
      expect(res.errors, `Fixture ${fixtureName} load errors`).toEqual([]);

      const gen = promptRender();
      const out = await gen.generate(makeCtx(res.root));

      expect(out, `${fixtureName}: expected 1 file from promptRender()`).toHaveLength(1);

      const expected = readFileSync(expectedPath, "utf-8");
      expect(out[0]!.content, `${fixtureName}: prompts.ts content mismatch`).toBe(expected);
    });
  }
});
