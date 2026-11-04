// `readsRunOutput`: a generator that lists what the rest of the run generated (the docs site's
// model explorer) runs after every other generator and reads the files through `ctx.runOutput`,
// keyed as the manifest keys them. `requirementLedger` is the caller's callback, called once.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { perEntity, type Generator, type RunOutputFile } from "../src/generator.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");
const TWO = resolve(import.meta.dir, "fixtures", "two-entities-fk.json");

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-run-output-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

async function load(file = FIXTURE) {
  return (await new MetaDataLoader().load([new FileSource(file)])).root;
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

  test("a run narrowed to some entities still reads the other objects' files from the manifest", async () => {
    const config = (seen: { files?: readonly RunOutputFile[] | undefined }) =>
      defineConfig({ outDir: join(tmp, "gen"), extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [alpha, reader(seen)] });
    await runGen({ config: config({}), metadata: await load(TWO), projectRoot: tmp });
    const seen: { files?: readonly RunOutputFile[] | undefined } = {};
    await runGen({ config: config(seen), metadata: await load(TWO), projectRoot: tmp, entityFilter: ["Post"] });
    expect(seen.files?.map((f) => f.path)).toEqual(["gen/Post.alpha.ts", "gen/User.alpha.ts"]);
  });

  test("a narrowed run leaves out records for a generator no longer declared or a file no longer on disk", async () => {
    const beta: Generator = { name: "beta", generate: perEntity((e) => ({ path: `${e.name}.beta.ts`, content: "// b\n" })) };
    const base = { outDir: join(tmp, "gen"), extStyle: "none" as const, dbImport: "../db", dialect: "sqlite" as const };
    await runGen({ config: defineConfig({ ...base, generators: [alpha, beta, reader({})] }), metadata: await load(TWO), projectRoot: tmp });
    unlinkSync(join(tmp, "gen", "User.alpha.ts"));
    const seen: { files?: readonly RunOutputFile[] | undefined } = {};
    await runGen({ config: defineConfig({ ...base, generators: [alpha, reader(seen)] }), metadata: await load(TWO), projectRoot: tmp, generatorNames: ["reader"] });
    expect(seen.files?.map((f) => f.path)).toEqual(["gen/Post.alpha.ts"]);
  });

  test("a stand-in for an out-of-tree outDir is left out, as the out-of-tree outDir itself is", async () => {
    const webAlpha: Generator = { ...alpha, target: "web" };
    const config = (web: string, seen: { files?: readonly RunOutputFile[] | undefined }) =>
      defineConfig({ outDir: join(tmp, "project", "gen"), targets: { web: { outDir: web } }, extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [webAlpha, reader(seen)] });
    // `meta gen`: the web target sits outside the project.
    const gen: { files?: readonly RunOutputFile[] | undefined } = {};
    await runGen({ config: config(join(tmp, "web"), gen), metadata: await load(), projectRoot: join(tmp, "project") });
    // `meta verify --codegen`: the same target, moved to a slot inside the regenerated tree.
    const verify: { files?: readonly RunOutputFile[] | undefined } = {};
    const slot = join(tmp, "verify", "_web");
    await runGen({
      config: { ...config(slot, verify), outDir: join(tmp, "verify", "gen") },
      metadata: await load(),
      projectRoot: join(tmp, "verify"),
      untrackedOutDirs: [slot],
    });
    expect(gen.files).toEqual([]);
    expect(verify.files).toEqual(gen.files);
  });
});
