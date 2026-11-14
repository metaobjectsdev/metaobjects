// `.gen-state/.hashes.json` is written ONCE per `meta gen`, however many files the run
// writes. It used to be rewritten per written file — quadratic bookkeeping that was most
// of a large project's run time, for the same bytes one write produces.
import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen, defineConfig } from "../src/index.js";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import { barrel } from "../src/generators/barrel.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "two-entities-fk.json");
const MANIFEST = ".hashes.json";

let project: string;
beforeEach(() => { project = mkdtempSync(join(tmpdir(), "codegen-manifest-once-")); });
afterEach(() => { rmSync(project, { recursive: true, force: true }); });

async function gen(): Promise<number> {
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
    return spy.mock.calls.filter(([path]) => String(path).endsWith(MANIFEST)).length;
  } finally {
    spy.mockRestore();
  }
}

const manifestPath = (): string => join(project, ".metaobjects", ".gen-state", MANIFEST);

describe("the hash manifest is written once per run", () => {
  test("a first run that writes every file writes the manifest once, recording each", async () => {
    expect(await gen()).toBe(1);
    const recorded = Object.keys(JSON.parse(readFileSync(manifestPath(), "utf-8")));
    expect(recorded).toContain("src/generated/Post.ts");
    expect(recorded).toContain("src/generated/User.queries.ts");
    expect(recorded).toContain("src/generated/index.ts");
  });

  test("a run that changes files rewrites the manifest once", async () => {
    await gen();
    // Two files to write again: both are recorded, in one manifest write.
    rmSync(join(project, "src/generated/Post.ts"));
    rmSync(join(project, "src/generated/User.ts"));
    expect(await gen()).toBe(1);
  });

  test("a run that changes nothing leaves the manifest unwritten", async () => {
    await gen();
    const before = readFileSync(manifestPath(), "utf-8");
    expect(await gen()).toBe(0);
    expect(readFileSync(manifestPath(), "utf-8")).toBe(before);
  });
});
