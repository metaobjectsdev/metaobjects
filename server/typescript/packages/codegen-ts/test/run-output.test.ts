// `readsRunOutput`: a generator that lists what the rest of the run generated (the docs site's
// model explorer) runs after every other generator and reads the files through `ctx.runOutput`,
// keyed as the manifest keys them. `requirementLedger` is the caller's callback, called once.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { perEntity, type Generator, type RunOutputFile } from "../src/generator.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-run-output-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function load() {
  return (await new MetaDataLoader().load([new FileSource(FIXTURE)])).root;
}

function reader(seen: { files?: readonly RunOutputFile[] | undefined; ledger?: unknown[] }): Generator {
  return {
    name: "reader",
    readsRunOutput: true,
    generate(ctx) {
      seen.files = ctx.runOutput?.();
      seen.ledger = [ctx.requirementLedger?.(), ctx.requirementLedger?.()];
      return [{ path: "list.txt", content: (seen.files ?? []).map((f) => f.path).join("\n") }];
    },
  };
}

const alpha: Generator = { name: "alpha", generate: perEntity((e) => ({ path: `${e.name}.alpha.ts`, content: "// a\n" })) };

describe("readsRunOutput", () => {
  test("runs after a generator declared later and sees its files, project-relative", async () => {
    const seen: { files?: readonly RunOutputFile[] | undefined } = {};
    let calls = 0;
    await runGen({
      config: defineConfig({ outDir: join(tmp, "gen"), extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [reader(seen), alpha] }),
      metadata: await load(),
      projectRoot: tmp,
      requirementLedger: () => { calls++; return { requirementLedger: [] }; },
    });
    expect(seen.files).toEqual([{ path: "gen/Post.alpha.ts", generatedBy: "alpha", sourceNode: "demo::Post" }]);
    expect(calls).toBe(1);
  });

  test("an unmarked generator gets no runOutput", async () => {
    let had: unknown = "unset";
    const plain: Generator = { name: "plain", generate(ctx) { had = ctx.runOutput; return []; } };
    await runGen({
      config: defineConfig({ outDir: join(tmp, "gen"), extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [plain] }),
      metadata: await load(),
      projectRoot: tmp,
    });
    expect(had).toBeUndefined();
  });

  test("a narrowed run reads the manifest for the generators it did not run", async () => {
    const config = defineConfig({ outDir: join(tmp, "gen"), extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [alpha, reader({})] });
    await runGen({ config, metadata: await load(), projectRoot: tmp });
    const seen: { files?: readonly RunOutputFile[] | undefined } = {};
    const narrowed = defineConfig({ outDir: join(tmp, "gen"), extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [alpha, reader(seen)] });
    await runGen({ config: narrowed, metadata: await load(), projectRoot: tmp, generatorNames: ["reader"] });
    expect(seen.files).toEqual([{ path: "gen/Post.alpha.ts", generatedBy: "alpha", sourceNode: "demo::Post" }]);
  });
});
