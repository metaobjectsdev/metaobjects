// gen-cube-model-canonical.ts — (re)write the cube-model golden for the canonical model.
//
// Run: `bun run gen:cube-canonical` (from server/typescript/packages/codegen-ts). Pure metadata
// to YAML, no database. Runs the cubeModel() generator through runGen over
// fixtures/persistence-conformance/canonical/meta.fitness.json (dialect postgres, column naming
// literal, as the persistence corpus's schema is) and replaces
// fixtures/cube-model/canonical/expected/ with what it writes: contract Table H, the files the
// live Cube lane loads. test/cube/cube-model-canonical.test.ts regenerates in a temp directory
// and fails on any difference.
//
// Also exports the harness both cube-model fixture tests use: run the generator over a loaded
// model into a fresh temp directory and read the tree back.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadUris, type ColumnNamingStrategy, type MetaRoot } from "@metaobjectsdev/metadata";
import { defineConfig, runGen, type Dialect } from "../src/index.js";
import { cubeModel } from "../src/generators/cube-model.js";

// scripts → codegen-ts → packages → typescript → server → repo root
const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..", "..", "..");

/** The mapping corpus: one directory per case, plus `canonical/`. */
export const CUBE_CORPUS_DIR = join(REPO_ROOT, "fixtures", "cube-model");

/** The canonical model every port's persistence corpus loads. */
export const CANONICAL_MODEL = join(REPO_ROOT, "fixtures", "persistence-conformance", "canonical", "meta.fitness.json");

/** The canonical model's golden: `model/cubes/*.yml` under it. */
export const CANONICAL_EXPECTED_DIR = join(CUBE_CORPUS_DIR, "canonical", "expected");

/** This script, as a failing test names it. */
export const CANONICAL_SCRIPT = "server/typescript/packages/codegen-ts/scripts/gen-cube-model-canonical.ts (bun run gen:cube-canonical)";

/** The canonical golden's config: the persistence corpus's schema spells its columns literally. */
export const CANONICAL_CONFIG = { dialect: "postgres", columnNamingStrategy: "literal" } as const;

export interface CubeRunConfig {
  readonly dialect: Dialect;
  readonly columnNamingStrategy?: ColumnNamingStrategy;
}

/** Every file under `dir`, keyed by its `/`-separated path relative to `dir`, in path order. */
export function readTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (at: string): void => {
    for (const name of readdirSync(at).sort()) {
      const full = join(at, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(relative(dir, full).split("\\").join("/"), readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
}

/**
 * Run `cubeModel()` (its default options) over `root` through runGen into a fresh temp
 * directory, read what it wrote, and remove the directory. A generator error is rethrown as the
 * runner reports it (the CubeModelError is its `cause`).
 */
export async function cubeModelTree(root: MetaRoot, config: CubeRunConfig): Promise<Map<string, string>> {
  const dir = mkdtempSync(join(tmpdir(), "cube-model-"));
  try {
    const outDir = join(dir, "out");
    await runGen({
      config: defineConfig({
        outDir,
        dialect: config.dialect,
        ...(config.columnNamingStrategy !== undefined ? { columnNamingStrategy: config.columnNamingStrategy } : {}),
        generators: [cubeModel()],
      }),
      metadata: root,
      genStateDir: join(dir, ".gen-state"),
    });
    let wrote = true;
    try {
      statSync(outDir);
    } catch {
      wrote = false;
    }
    return wrote ? readTree(outDir) : new Map();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Load one metadata file through the standard loader, refusing any load error. */
export async function loadModelFile(path: string): Promise<MetaRoot> {
  const result = await loadUris([pathToFileURL(path).href]);
  if (result.errors.length > 0) {
    throw new Error(`${path}: metadata did not load cleanly: ${result.errors.map((e) => e.message).join("; ")}`);
  }
  return result.root;
}

/** What the generator writes for the canonical model (Table H). */
export async function canonicalCubeModelTree(): Promise<Map<string, string>> {
  return cubeModelTree(await loadModelFile(CANONICAL_MODEL), CANONICAL_CONFIG);
}

async function main(): Promise<void> {
  const fresh = mkdtempSync(join(tmpdir(), "cube-model-canonical-"));
  try {
    const tree = await canonicalCubeModelTree();
    // Written to a staging directory first, so a failing run leaves the golden as it was.
    for (const [path, content] of tree) {
      const target = join(fresh, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    rmSync(CANONICAL_EXPECTED_DIR, { recursive: true, force: true });
    cpSync(fresh, CANONICAL_EXPECTED_DIR, { recursive: true });
    /* eslint-disable no-console */
    console.log(`wrote ${tree.size} file(s) under ${relative(REPO_ROOT, CANONICAL_EXPECTED_DIR)}: ${[...tree.keys()].join(", ")}`);
    /* eslint-enable no-console */
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
