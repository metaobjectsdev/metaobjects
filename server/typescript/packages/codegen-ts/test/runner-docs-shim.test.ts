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
import { apiDocsFile, docsFile } from "../src/generators/index.js";
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
    // Packaged ones: none of them is an owned copy.
    expect(result.skippedOwnedDocGenerators).toEqual([]);
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
    expect(result.skippedOwnedDocGenerators).toEqual([]);
  });
});

describe("isPackagedDocsGenerator — the one definition of what `meta gen` skips", () => {
  test("is keyed by the generator's implementation name", () => {
    expect(isPackagedDocsGenerator(apiDocsFile().name)).toBe(true);
    expect(isPackagedDocsGenerator(docsFile().name)).toBe(true);
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
    const listed = (/Available native generators: ([^.]*)\./.exec(message)?.[1] ?? "")
      .split(",").map((s) => s.trim());
    expect(listed).toContain("entity");
    expect(listed).not.toContain("api-docs");
    expect(listed).not.toContain("docs");
    // `mermaid-er` was removed in 1.1, so it is not offered either.
    expect(listed).not.toContain("mermaid-er");
    // ...and says where documentation comes from, so the reader is not left guessing
    // why a catalog name is missing from the list.
    expect(message).toContain("meta docs");
  });
});

// ADR-0034 Amendment 7: an OWNED docs generator carries `docsSurface` and is listed in the
// docs door's own block, `docs: { generators: [...] }`. In the array `meta gen` runs it is
// in the wrong place: it is not run, and the warning says where it goes.
describe("runGen — an owned docs generator in `generators` is skipped and pointed at the docs door", () => {
  test("a generator carrying docsSurface is not run, and the warning names `docs.generators`", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    let ran = false;
    const ownedDocs: Generator = {
      name: "docs-file",
      docsSurface: "model",
      generate: () => {
        ran = true;
        return [{ path: "README.md", content: "# mine" }];
      },
    };
    const normal: Generator = {
      name: "alpha",
      generate: perEntity((e) => ({ path: `${e.name}.alpha.ts`, content: "// alpha" })),
    };

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [normal, ownedDocs],
      }),
      metadata: root,
    });

    expect(ran).toBe(false);
    expect(result.files.map((f) => relPath(tmp, f.path))).toEqual(["Post.alpha.ts"]);
    expect(result.warnings.filter((w) => w.includes("docs-file"))).toEqual([
      "[docs-file] is a docs generator: 'meta docs' runs it, from `docs: { generators: [...] }` " +
        "in metaobjects.config.ts, and 'meta gen' does not. Move it there. Skipped.",
    ]);
    // Reported as skipped, like a packaged one, and as OWNED: its fix is to move it.
    expect(result.skippedDocGenerators).toEqual(["docs-file"]);
    expect(result.skippedOwnedDocGenerators).toEqual(["docs-file"]);
  });

  // Without this a config wiring only an owned docs copy emitted nothing and was told
  // "no entities to generate": the caller counts skipped generators to word that summary.
  test("an owned copy is in skippedDocGenerators beside a packaged one, in config order", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);
    // Renamed by its owner: the marker decides, not the name.
    const ownedApi: Generator = { name: "my-api-reference", docsSurface: "api", generate: () => [] };

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [ownedApi, docsFile()],
      }),
      metadata: root,
    });

    expect(result.files).toEqual([]);
    expect(result.skippedDocGenerators).toEqual(["my-api-reference", "docs-file"]);
    expect(result.skippedOwnedDocGenerators).toEqual(["my-api-reference"]);
    // Each warning gives its own fix: move the owned copy, remove the packaged one.
    expect(result.warnings.some((w) => w.startsWith("[my-api-reference]") && w.includes("Move it there."))).toBe(true);
    expect(result.warnings.some((w) => w.includes("remove docsFile() from generators"))).toBe(true);
  });
});

function relPath(base: string, full: string): string {
  return full.startsWith(base) ? full.slice(base.length).replace(/^[/\\]/, "") : full;
}
