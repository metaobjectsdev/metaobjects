// ADR-0025: `meta docs` is the single docs door. A `meta gen` config that still
// lists a deprecated doc generator (apiDocsFile / docsFile) is WARNED + SKIPPED by
// the runner, NOT run. This gates that shim.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { perEntity, type Generator } from "../src/generator.js";
import { apiDocsFile } from "../src/generators/index.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-docs-shim-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("runGen — deprecated doc generators are warned + skipped (ADR-0025)", () => {
  test("apiDocsFile() in a meta gen config is warned and produces no docs/api output", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    const normal: Generator = {
      name: "alpha",
      generate: perEntity((e) => ({ path: `${e.name}.alpha.ts`, content: "// alpha" })),
    };

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [normal, apiDocsFile()],
      }),
      metadata: root,
    });

    // (a) a warning naming the deprecated generator + pointing at `meta docs`.
    const docWarn = result.warnings.find(
      (w) => /api-docs|apiDocsFile/.test(w) && /meta docs/.test(w),
    );
    expect(docWarn).toBeDefined();

    // (b) the deprecated generator was SKIPPED — no emitted file under docs/api/.
    const apiPaths = result.files.filter((f) =>
      relPath(tmp, f.path).startsWith("docs/api/"),
    );
    expect(apiPaths).toEqual([]);

    // the normal generator still ran.
    expect(result.files.some((f) => f.path.endsWith("Post.alpha.ts"))).toBe(true);
  });
});

function relPath(base: string, full: string): string {
  return full.startsWith(base) ? full.slice(base.length).replace(/^[/\\]/, "") : full;
}
