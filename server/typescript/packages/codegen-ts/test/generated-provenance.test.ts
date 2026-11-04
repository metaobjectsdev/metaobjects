// Node provenance in the generated-file manifest: `perEntity` stamps each file with the node
// it rendered, and the runner records that on the file's `.hashes.json` entry, so a reader
// (the explorer builder) can say which files a node produced without matching names.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { perEntity, perModel, type Generator } from "../src/generator.js";
import { recordGeneratedProvenance } from "../src/overwrite-policy.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-provenance-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const manifest = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, ".metaobjects", ".gen-state", ".hashes.json"), "utf8"));

describe("perEntity stamps the source node", () => {
  test("each file carries its entity's resolution key unless the generator set one", async () => {
    const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
    const plain = perEntity((e) => ({ path: `${e.name}.ts`, content: "" }));
    const preset = perEntity((e) => ({ path: `${e.name}.ts`, content: "", sourceNode: "kept" }));
    const ctx = { entities: root.objects(), root, matches: () => true } as unknown as Parameters<typeof plain>[0];
    expect((await plain(ctx)).map((f) => f.sourceNode)).toEqual(["demo::Post"]);
    expect((await preset(ctx)).map((f) => f.sourceNode)).toEqual(["kept"]);
  });
});

describe("runGen records provenance in .hashes.json", () => {
  test("a per-entity file gets { hash, generatedBy, sourceNode }; a whole-model file stays plain", async () => {
    const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
    const entity: Generator = { name: "alpha", generate: perEntity((e) => ({ path: `${e.name}.alpha.ts`, content: "// a\n" })) };
    const barrel: Generator = { name: "barrel", generate: perModel(() => ({ path: "index.ts", content: "// i\n" })) };
    await runGen({
      config: defineConfig({ outDir: join(tmp, "gen"), extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [entity, barrel] }),
      metadata: root,
      projectRoot: tmp,
    });
    const m = manifest(tmp);
    expect(m["gen/Post.alpha.ts"]).toEqual({
      hash: expect.any(String),
      generatedBy: "alpha",
      sourceNode: "demo::Post",
    });
    expect(typeof m["gen/index.ts"]).toBe("string");
  });
});

describe("recordGeneratedProvenance", () => {
  function seed(entries: Record<string, unknown>): string {
    const dir = join(tmp, ".gen-state");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".hashes.json"), JSON.stringify(entries, null, 2) + "\n");
    return dir;
  }
  const read = (dir: string): Record<string, unknown> => JSON.parse(readFileSync(join(dir, ".hashes.json"), "utf8"));

  test("keeps the JVM owner fields beside the provenance", () => {
    const dir = seed({ "a.kt": { hash: "h1", generator: "kotlin-entity", outputDir: "src" } });
    recordGeneratedProvenance(dir, new Map([["a.kt", { generatedBy: "entity", sourceNode: "x::A" }]]));
    expect(read(dir)["a.kt"]).toEqual({ hash: "h1", generator: "kotlin-entity", outputDir: "src", generatedBy: "entity", sourceNode: "x::A" });
  });

  test("a file with no source node returns to the plain form", () => {
    const dir = seed({ "i.ts": { hash: "h2", generatedBy: "barrel", sourceNode: "gone::X" } });
    recordGeneratedProvenance(dir, new Map([["i.ts", { generatedBy: "barrel" }]]));
    expect(read(dir)["i.ts"]).toBe("h2");
  });

  test("never records a path the manifest has no hash for, and writes nothing when nothing changes", () => {
    const dir = seed({ "a.ts": "h3" });
    const before = readFileSync(join(dir, ".hashes.json"), "utf8");
    recordGeneratedProvenance(dir, new Map([["b.ts", { generatedBy: "g", sourceNode: "x::B" }], ["a.ts", { generatedBy: "g" }]]));
    expect(readFileSync(join(dir, ".hashes.json"), "utf8")).toBe(before);
  });

  test("no manifest, no file", () => {
    const dir = join(tmp, "none");
    recordGeneratedProvenance(dir, new Map([["a.ts", { generatedBy: "g", sourceNode: "x::A" }]]));
    expect(() => readFileSync(join(dir, ".hashes.json"))).toThrow();
  });
});
