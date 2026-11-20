// The `.gen-state/.hashes/` manifest files are written ONCE per `meta gen`, however many files the run
// writes. It used to be rewritten per written file — quadratic bookkeeping that was most
// of a large project's run time, for the same bytes one write produces.
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen, defineConfig } from "../src/index.js";
import { decideAndWrite, withManifestBatch } from "../src/overwrite-policy.js";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { barrel } from "../src/generators/barrel.js";
import { isManifestPath, manifestEntries, manifestFiles, removeManifest, seedLegacyManifest } from "./support/manifest.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "two-entities-fk.json");

let project: string;
beforeEach(() => { project = mkdtempSync(join(tmpdir(), "codegen-manifest-once-")); });
afterEach(() => { rmSync(project, { recursive: true, force: true }); });

/** Manifest-file writes during one run: path -> times written. */
async function gen(): Promise<Record<string, number>> {
  const { root, errors } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  expect(errors).toEqual([]);
  const spy = spyOn(fs, "writeFileSync");
  try {
    const result = await runGen({
      config: defineConfig({
        outDir: "src/generated", extStyle: "none", dbImport: "~/server/db", dialect: "postgres",
        generators: [entityFile(), queriesFile(), barrel()],
      }),
      metadata: root,
      projectRoot: project,
    });
    expect(result.files.length).toBeGreaterThan(2);
    const counts: Record<string, number> = {};
    for (const [path] of spy.mock.calls) if (isManifestPath(path)) counts[String(path)] = (counts[String(path)] ?? 0) + 1;
    return counts;
  } finally {
    spy.mockRestore();
  }
}

const genState = (): string => join(project, ".metaobjects", ".gen-state");

describe("the hash manifest is written once per run", () => {
  test("a first run that writes every file writes the manifest once, recording each", async () => {
    const writes = await gen();
    expect(Object.keys(writes).length).toBeGreaterThan(1); // one file per package
    expect(Object.values(writes).every((n) => n === 1)).toBe(true);
    const recorded = Object.keys(manifestEntries(genState()));
    expect(recorded).toContain("src/generated/Post.ts");
    expect(recorded).toContain("src/generated/User.queries.ts");
    expect(recorded).toContain("src/generated/index.ts");
  });

  test("a run that changes files rewrites the manifest once", async () => {
    await gen();
    // Two files to write again whose records are gone: both are recorded, in one manifest
    // write. (A file rewritten under an unchanged record changes no entry, so it writes none.)
    const entries = manifestEntries(genState());
    delete entries["src/generated/Post.ts"];
    delete entries["src/generated/User.ts"];
    removeManifest(genState());
    seedLegacyManifest(genState(), entries);
    rmSync(join(project, "src/generated/Post.ts"));
    rmSync(join(project, "src/generated/User.ts"));
    const writes = await gen();
    expect(Object.values(writes).every((n) => n === 1)).toBe(true);
    expect(Object.keys(manifestEntries(genState()))).toContain("src/generated/Post.ts");
  });

  test("a run that changes nothing leaves the manifest unwritten", async () => {
    await gen();
    const before = manifestFiles(genState());
    expect(await gen()).toEqual({});
    expect(manifestFiles(genState())).toEqual(before);
  });

  test("a run that throws keeps its own error when the manifest write fails too", () => {
    const genStateDir = join(project, ".gen-state");
    expect(() =>
      withManifestBatch(genStateDir, () => {
        decideAndWrite(join(project, "a.ts"), "export {};\n", { genStateDir, outputRelPath: "a.ts" });
        // A file where the manifest directory goes: the end-of-batch write now fails.
        writeFileSync(join(genStateDir, ".hashes"), "not a directory");
        throw new Error("the generator's own failure");
      }),
    ).toThrow("the generator's own failure");
  });
});
