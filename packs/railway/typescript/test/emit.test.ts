import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { defineConfig, runGen, type Generator } from "@metaobjectsdev/codegen-ts";
import type { MetaRoot } from "@metaobjectsdev/metadata";
import { railwayFiles } from "../src/index.js";
import { loadFixture } from "./model.js";

const scratch = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "pack-railway-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const GOLDEN = join(import.meta.dir, "golden");
/** `UPDATE_GOLDEN=1 bun test` rewrites the golden files from the generators. */
const UPDATE = process.env["UPDATE_GOLDEN"] === "1";

/** A dry run: every rendered file by its path relative to the output directory, nothing written. */
export async function render(metadata: MetaRoot, generators: Generator[], warnings?: string[]): Promise<Map<string, string>> {
  const out = join(scratch, "out");
  const res = await runGen({
    config: defineConfig({ outDir: out, extStyle: "none", dbImport: "../db", dialect: "sqlite", generators }),
    metadata,
    projectRoot: scratch,
    dryRun: true,
  });
  warnings?.push(...res.warnings);
  const files = new Map<string, string>();
  for (const [abs, content] of res.rendered ?? []) files.set(abs.slice(out.length + 1), content);
  return files;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe.each(["railway-emit-one-service", "railway-emit-two-services", "railway-emit-environments"])("%s", (scenario) => {
  test("the generators write the golden files, and only those", async () => {
    const files = await render(await loadFixture(scenario), railwayFiles());
    const golden = join(GOLDEN, scenario);
    if (UPDATE) {
      rmSync(golden, { recursive: true, force: true });
      for (const [path, content] of files) {
        mkdirSync(dirname(join(golden, path)), { recursive: true });
        writeFileSync(join(golden, path), content);
      }
    }
    expect(existsSync(golden)).toBe(true);
    const expected = new Map(walk(golden).map((p) => [relative(golden, p), readFileSync(p, "utf8")]));
    expect([...files.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [path, content] of files) expect(content).toBe(expected.get(path)!);
  });
});
