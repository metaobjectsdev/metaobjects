// ADR-0025: `meta docs` is the single docs door. A `meta gen` config that still
// lists a deprecated doc generator (apiDocsFile / docsFile) is WARNED + SKIPPED by
// the runner, NOT run. This gates that shim.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig, resolveGenerators } from "../src/metaobjects-config.js";
import { perEntity, type Generator } from "../src/generator.js";
import { apiDocsFile, docsFile, mermaidErDiagram } from "../src/generators/index.js";
import { isPackagedDocsGenerator } from "../src/packaged-docs-generators.js";
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

  // The warning is prose. A caller that has to DECIDE something from the skip — the CLI
  // wording its "nothing was generated" summary, `verify --codegen`, the catalog probe —
  // needs the fact itself, not a regex over a sentence.
  test("the result names every skipped doc generator, in config order", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [apiDocsFile(), docsFile()],
      }),
      metadata: root,
    });

    expect(result.skippedDocGenerators).toEqual(["api-docs", "docs-file"]);
    expect(result.files).toEqual([]);
    // One warning per skipped generator, each naming the factory call to remove.
    expect(result.warnings.filter((w) => w.includes("Skipped."))).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes("remove docsFile() from generators"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("remove apiDocsFile() from generators"))).toBe(true);
  });

  test("a run with no doc generator skips nothing", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);
    const normal: Generator = {
      name: "alpha",
      generate: perEntity((e) => ({ path: `${e.name}.alpha.ts`, content: "// alpha" })),
    };

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [normal],
      }),
      metadata: root,
    });

    expect(result.skippedDocGenerators).toEqual([]);
  });

  // `mermaidErDiagram()` is deprecated under `meta gen` but still RUNS (it is kept for
  // configs that already list it), so it is not a skipped generator and must not be
  // reported as one.
  test("mermaidErDiagram() still runs and is not reported as skipped", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [mermaidErDiagram()],
      }),
      metadata: root,
    });

    expect(result.skippedDocGenerators).toEqual([]);
    expect(result.files.map((f) => relPath(tmp, f.path))).toEqual(["docs/model.md"]);
  });
});

describe("isPackagedDocsGenerator — the one definition of what `meta gen` skips", () => {
  test("is keyed by the generator's implementation name", () => {
    expect(isPackagedDocsGenerator(apiDocsFile().name)).toBe(true);
    expect(isPackagedDocsGenerator(docsFile().name)).toBe(true);
    expect(isPackagedDocsGenerator(mermaidErDiagram().name)).toBe(false);
    expect(isPackagedDocsGenerator("entity-file")).toBe(false);
  });
});

describe("resolveGenerators — a doc generator is not offered as a `meta gen` name", () => {
  // The unknown-name error lists what CAN be selected. It used to list `api-docs`,
  // which `meta gen` then warns about and skips — an error message recommending the
  // exact wiring the run rejects.
  test("the unknown-name listing leaves out every generator `meta gen` skips", () => {
    let message = "";
    try { resolveGenerators(["no-such-generator"]); }
    catch (err) { message = err instanceof Error ? err.message : String(err); }

    expect(message).toContain(`unknown generator "no-such-generator"`);
    const listed = (/Available generators: ([^.]*)\./.exec(message)?.[1] ?? "")
      .split(",").map((s) => s.trim());
    expect(listed).toContain("entity");
    expect(listed).not.toContain("api-docs");
    expect(listed).not.toContain("docs");
    // `mermaid-er` is neutral and IS in the list: `meta gen` runs it.
    expect(listed).toContain("mermaid-er");
    // ...and says where documentation comes from, so the reader is not left guessing
    // why a catalog name is missing from the list.
    expect(message).toContain("meta docs");
  });
});

function relPath(base: string, full: string): string {
  return full.startsWith(base) ? full.slice(base.length).replace(/^[/\\]/, "") : full;
}
