import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { perEntity, oncePerRun, type Generator } from "../src/generator.js";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-runner-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("runGen — happy path", () => {
  test("runs each generator in order and writes their files", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    const log: string[] = [];
    const a: Generator = {
      name: "alpha",
      generate: perEntity((e) => { log.push(`alpha:${e.name}`); return { path: `${e.name}.alpha.ts`, content: "// alpha" }; }),
    };
    const b: Generator = {
      name: "beta",
      generate: oncePerRun((all) => { log.push("beta:once"); return { path: "beta.ts", content: `// ${all.length}` }; }),
    };

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [a, b],
      }),
      metadata: root,
    });

    expect(result.warnings).toEqual([]);
    expect(result.files.map(f => f.path).sort()).toEqual([
      join(tmp, "Post.alpha.ts"),
      join(tmp, "beta.ts"),
    ].sort());
    expect(log).toEqual(["alpha:Post", "beta:once"]);
    expect(readdirSync(tmp).sort()).toEqual(["Post.alpha.ts", "beta.ts"]);
  });

  test("entityFilter narrows the entity set passed to generators", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    const gen: Generator = {
      name: "any",
      generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "" })),
    };
    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [gen],
      }),
      metadata: root,
      entityFilter: ["DoesNotExist"],
    });
    expect(result.files.length).toBe(0);
    expect(result.warnings.some(w => w.toLowerCase().includes("no entities"))).toBe(true);
  });
});

describe("runGen — error paths", () => {
  test("duplicate output paths from two generators -> throws naming both", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    const a: Generator = { name: "alpha", generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "// a" })) };
    const b: Generator = { name: "beta",  generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "// b" })) };

    await expect(runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [a, b],
      }),
      metadata: root,
    })).rejects.toThrow(/Output path collision.*Post\.ts".*alpha.*beta/);
  });

  // #266 — a shared artifact rendered from the whole loaded root (the shared
  // `enums.ts`) is emitted by EVERY entityFile() instance, so a config running more
  // than one instance against one target collided an emission with a byte-identical
  // copy of itself. Identical bytes at the same path are not a conflict: whichever
  // "wins" produces the same file, so emit once instead of failing the build.
  test("byte-identical duplicate emissions collapse to one file instead of throwing", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    const shared = "// shared artifact\n";
    const a: Generator = { name: "alpha", generate: oncePerRun(() => ({ path: "enums.ts", content: shared })) };
    const b: Generator = { name: "beta",  generate: oncePerRun(() => ({ path: "enums.ts", content: shared })) };

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [a, b],
      }),
      metadata: root,
    });

    const enumFiles = result.files.filter((f) => f.path.endsWith("enums.ts"));
    expect(enumFiles.length).toBe(1);
    expect(readFileSync(join(tmp, "enums.ts"), "utf-8")).toBe(shared);
    expect(result.warnings).toEqual([]);
  });

  test("generator throws -> error prefixed with [generator.name]", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);

    const bad: Generator = { name: "exploder", generate: () => { throw new Error("boom"); } };
    await expect(runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [bad],
      }),
      metadata: root,
    })).rejects.toThrow(/^\[exploder\] boom/);
  });

  test("rejects unsafe entity names (path-traversal guard preserved from legacy)", async () => {
    // End-to-end verification is impractical because Loader rejects invalid
    // metadata at parse time. Smoke-test by reading the source to confirm the
    // regex literal is present — survives renames of the identifier.
    const src = readFileSync(resolve(import.meta.dir, "..", "src", "runner.ts"), "utf-8");
    expect(src).toContain("/^[A-Za-z_][A-Za-z0-9_]*$/");
  });
});

describe("runGen — multi-target", () => {
  test("routes each generator's files to its target outDir; collision scoped per full path", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);
    const apiDir = join(tmp, "api");

    const entity: Generator = {
      name: "entity-file", emitsEntityModule: true,
      generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "// entity" })),
    };
    const routes: Generator = {
      name: "routes-file", target: "api",
      generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "// routes" })),
    };

    const result = await runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../index", dialect: "sqlite",
        importBase: "@mf/db/generated",
        targets: { api: { outDir: apiDir } },
        generators: [entity, routes],
      }),
      metadata: root,
    });

    // same relative path "Post.ts" in two targets is NOT a collision
    expect(result.warnings).toEqual([]);
    expect(result.files.map((f) => f.path).sort()).toEqual([
      join(apiDir, "Post.ts"), join(tmp, "Post.ts"),
    ].sort());
    expect(readFileSync(join(tmp, "Post.ts"), "utf-8")).toContain("// entity");
    expect(readFileSync(join(apiDir, "Post.ts"), "utf-8")).toContain("// routes");
  });

  test("unknown target name → throws listing valid targets", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);
    const g: Generator = { name: "x", target: "nope", generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "" })) };
    await expect(runGen({
      config: defineConfig({ outDir: tmp, extStyle: "none", dbImport: "../index", dialect: "sqlite", generators: [g] }),
      metadata: root,
    })).rejects.toThrow(/unknown target "nope".*default/);
  });

  test("cross-target without importBase on entity-module target → throws", async () => {
    const loader = new MetaDataLoader();
    const { root } = await loader.load([new FileSource(FIXTURE)]);
    const entity: Generator = { name: "entity-file", emitsEntityModule: true, generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "" })) };
    const routes: Generator = { name: "routes-file", target: "api", generate: perEntity((e) => ({ path: `${e.name}.routes.ts`, content: "" })) };
    await expect(runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../index", dialect: "sqlite",
        targets: { api: { outDir: join(tmp, "api") } }, // no importBase anywhere
        generators: [entity, routes],
      }),
      metadata: root,
    })).rejects.toThrow(/importBase/);
  });
});
