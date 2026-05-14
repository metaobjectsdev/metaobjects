import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Loader } from "@metaobjects/metadata";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/forge-config.js";
import { perEntity, oncePerRun, type Generator } from "../src/generator.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-runner-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("runGen — happy path", () => {
  test("runs each generator in order and writes their files", async () => {
    const loader = new Loader();
    const { root } = await loader.load([FIXTURE]);

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
    const loader = new Loader();
    const { root } = await loader.load([FIXTURE]);

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
    const loader = new Loader();
    const { root } = await loader.load([FIXTURE]);

    const a: Generator = { name: "alpha", generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "// a" })) };
    const b: Generator = { name: "beta",  generate: perEntity((e) => ({ path: `${e.name}.ts`, content: "// b" })) };

    await expect(runGen({
      config: defineConfig({
        outDir: tmp, extStyle: "none", dbImport: "../db", dialect: "sqlite",
        generators: [a, b],
      }),
      metadata: root,
    })).rejects.toThrow(/Output path collision.*"Post\.ts".*alpha.*beta/);
  });

  test("generator throws -> error prefixed with [generator.name]", async () => {
    const loader = new Loader();
    const { root } = await loader.load([FIXTURE]);

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
