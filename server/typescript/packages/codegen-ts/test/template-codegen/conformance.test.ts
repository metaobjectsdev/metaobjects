import { describe, test, expect } from "bun:test";
import { readdirSync, readFileSync, statSync, cpSync, existsSync, rmSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { runGen, defineConfig, parseTemplateSpec, templateSpecToGenerators } from "../../src/index.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { makeScratchDir, removeTree } from "../../src/scratch-dir.js";

const CORPUS = resolve(import.meta.dir, "../../../../../../fixtures/template-codegen-conformance");
/** Set to rewrite each case's `expected/` from this port's output (an intentional change). */
const UPDATE = process.env.UPDATE_TEMPLATE_CONFORMANCE === "1";

function walkFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walkFiles(p, base) : [relative(base, p)];
  });
}

/** Run a case's spec.json over its metadata/ (every file, sorted by name) and compare with its
 *  expected/. The case's templates/ and, when present, assets/ are copied into a scratch
 *  project, so runGen writes its .gen-state merge base there, never into the corpus. */
async function runCase(caseDir: string): Promise<void> {
  const spec = parseTemplateSpec(JSON.parse(readFileSync(join(caseDir, "spec.json"), "utf8")));
  const metaDir = join(caseDir, "metadata");
  const sources = readdirSync(metaDir).filter((f) => f.endsWith(".json")).sort().map((f) => new FileSource(join(metaDir, f)));
  const res = await new MetaDataLoader().load(sources);
  expect(res.errors).toEqual([]);

  const projectRoot = makeScratchDir("tmpl-conf-");
  const out = join(projectRoot, "out");
  cpSync(join(caseDir, "templates"), join(projectRoot, "templates"), { recursive: true });
  if (existsSync(join(caseDir, "assets"))) cpSync(join(caseDir, "assets"), join(projectRoot, "assets"), { recursive: true });
  try {
    await runGen({
      config: defineConfig({
        outDir: out, extStyle: "none", dbImport: "~/db", dialect: "sqlite",
        generators: templateSpecToGenerators(spec),
      }),
      metadata: res.root,
      projectRoot,
    });
    const expectedDir = join(caseDir, "expected");
    if (UPDATE) {
      rmSync(expectedDir, { recursive: true, force: true });
      cpSync(out, expectedDir, { recursive: true });
    }
    const got = walkFiles(out).sort();
    const want = walkFiles(expectedDir).sort();
    expect(got).toEqual(want);
    for (const rel of want) {
      expect(`${rel}:\n${readFileSync(join(out, rel), "utf8")}`)
        .toBe(`${rel}:\n${readFileSync(join(expectedDir, rel), "utf8")}`);
    }
  } finally {
    removeTree(projectRoot);
  }
}

describe("template-codegen conformance (TS)", () => {
  test("spec.json over metadata/ matches expected/ byte-for-byte", async () => {
    await runCase(CORPUS);
  });
  test("docs-view/: the docs view scopes, {path}, subDir, assets and the link check", async () => {
    await runCase(join(CORPUS, "docs-view"));
  });
});
