import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { runGen, defineConfig, parseTemplateSpec, templateSpecToGenerators } from "../../src/index.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/template-codegen-conformance");

function walkFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkFiles(p, base) : [relative(base, p)];
  });
}

describe("template-codegen conformance (TS)", () => {
  test("spec.json over metadata/ matches expected/ byte-for-byte", async () => {
    const spec = parseTemplateSpec(JSON.parse(readFileSync(join(CORPUS, "spec.json"), "utf8")));
    const loader = new MetaDataLoader();
    const res = await loader.load([new FileSource(join(CORPUS, "metadata", "meta.shop.json"))]);
    expect(res.errors).toEqual([]);

    // Hermetic: copy the corpus templates into a tmp projectRoot so runGen writes
    // its .gen-state merge base into the tmp tree, never into the committed corpus.
    const projectRoot = mkdtempSync(join(tmpdir(), "tmpl-conf-"));
    const out = join(projectRoot, "out");
    cpSync(join(CORPUS, "templates"), join(projectRoot, "templates"), { recursive: true });
    try {
      await runGen({
        config: defineConfig({
          outDir: out, extStyle: "none", dbImport: "~/db", dialect: "sqlite",
          generators: templateSpecToGenerators(spec),
        }),
        metadata: res.root,
        projectRoot,
      });
      const expectedDir = join(CORPUS, "expected");
      const got = walkFiles(out).sort();
      const want = walkFiles(expectedDir).sort();
      expect(got).toEqual(want);
      for (const rel of want) {
        expect(`${rel}:\n${readFileSync(join(out, rel), "utf8")}`)
          .toBe(`${rel}:\n${readFileSync(join(expectedDir, rel), "utf8")}`);
      }
    } finally {
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
