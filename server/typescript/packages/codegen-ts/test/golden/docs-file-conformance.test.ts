// Conformance check: docsFile() codegen output matches
// fixtures/conformance/<name>/expected/<Entity>.md byte-for-byte.
//
// For every conformance fixture that ships an expected/<Entity>.md file, this
// test loads the input metadata, runs docsFile(), and asserts byte-identical
// match. Fixtures without an expected markdown file are skipped.

import { describe, it, expect } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { docsFile } from "../../src/generators/docs-file.js";
import { makeRenderContext } from "../../src/render-context.js";
import { buildPkMap } from "../../src/pk-resolver.js";
import { buildRelationMap } from "../../src/relation-resolver.js";
import type { GenContext } from "../../src/generator.js";

// Corpus is six levels up from this file:
//   test/golden → test → codegen-ts → packages → typescript → server → repo-root/fixtures/conformance
const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/conformance");

function makeCtx(root: Awaited<ReturnType<MetaDataLoader["load"]>>["root"]): GenContext {
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "~/db",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return {
    entities: root.objects(),
    loadedRoot: root,
    matches: () => true,
    config: { outDir: "/tmp", extStyle: "none", dbImport: "~/db", dialect: "sqlite" } as never,
    renderContext,
    warn: () => {},
  };
}

// Discover fixtures that have any expected/*.md file.
const fixtures = readdirSync(CORPUS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => {
    const expectedDir = join(CORPUS, name, "expected");
    if (!existsSync(expectedDir)) return false;
    return readdirSync(expectedDir).some((f) => f.endsWith(".md"));
  });

describe("docsFile() conformance — expected/<Entity>.md byte-match", () => {
  if (fixtures.length === 0) {
    it("no fixtures have expected/<Entity>.md yet (placeholder)", () => {
      expect(true).toBe(true);
    });
  }

  for (const fixtureName of fixtures) {
    it(`${fixtureName} — markdown matches byte-for-byte`, async () => {
      const inputDir = join(CORPUS, fixtureName, "input");
      const expectedDir = join(CORPUS, fixtureName, "expected");

      const inputFiles = readdirSync(inputDir).filter((f) => f.endsWith(".json"));
      const sources = inputFiles.map((f) =>
        new InMemoryStringSource(
          readFileSync(join(inputDir, f), "utf-8"),
          { id: f, format: "json" },
        ),
      );

      const res = await new MetaDataLoader().load(sources);
      expect(res.errors, `Fixture ${fixtureName} load errors`).toEqual([]);

      const gen = docsFile();
      const out = await gen.generate(makeCtx(res.root));

      // Match each expected .md file by filename.
      const expectedFiles = readdirSync(expectedDir).filter((f) => f.endsWith(".md"));
      for (const fname of expectedFiles) {
        const emitted = out.find((f) => f.path === fname);
        expect(emitted, `${fixtureName}: missing emitted file ${fname}`).toBeDefined();
        const expected = readFileSync(join(expectedDir, fname), "utf-8");
        expect(
          emitted!.content,
          `${fixtureName}: ${fname} content mismatch`,
        ).toBe(expected);
      }
    });
  }
});
