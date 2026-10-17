// `--baseline=fresh` over a stale merge-base snapshot.
//
// The snapshot bodies under `.metaobjects/.gen-state/` are a gitignored local cache, so they
// survive a `git checkout` that moves the output files to content they never described.
// `--baseline=fresh` is documented to overwrite a file the committed manifest has no record of;
// it used to three-way merge against such a body instead, keeping the old content as a "hand
// edit" that `verify --codegen` then reported.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile } from "../src/generators/entity-file.js";
import { queriesFile } from "../src/generators/queries-file.js";
import type { BaselineMode } from "../src/overwrite-policy.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), "adopt-baseline-")); });
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

const genStateDir = (): string => join(projectRoot, ".metaobjects", ".gen-state");
const outDir = (): string => join(projectRoot, "generated");
const hashesFile = (): string => join(genStateDir(), ".hashes.json");

const STALE = "STALE LINE WRITTEN BY AN OLDER ENGINE\n";

async function gen(baseline?: BaselineMode) {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  return runGen({
    config: defineConfig({
      outDir: outDir(),
      extStyle: "none",
      dbImport: "~/server/db",
      dialect: "sqlite",
      generators: [entityFile(), queriesFile()],
    }),
    metadata: root,
    projectRoot,
    ...(baseline !== undefined && { baseline }),
  });
}

/** Append stale content to every generated file and forget its manifest record, keeping the snapshot bodies. */
function staleAndUnrecorded(): string[] {
  const names = readdirSync(outDir()).filter((e) => statSync(join(outDir(), e)).isFile());
  for (const n of names) writeFileSync(join(outDir(), n), readFileSync(join(outDir(), n), "utf-8") + STALE);
  writeFileSync(hashesFile(), "{}\n");
  return names;
}

describe("--baseline=fresh with a stale snapshot body", () => {
  test("overwrites a file the manifest has no record of, instead of merging the old content back", async () => {
    await gen();
    const names = staleAndUnrecorded();
    // The cache the adopter still has: a body for each path, no manifest entry.
    expect(existsSync(join(genStateDir(), "generated", names[0]!))).toBe(true);

    const result = await gen("fresh");

    for (const n of names) {
      expect(readFileSync(join(outDir(), n), "utf-8")).not.toContain("STALE LINE");
    }
    expect(result.files.some((f) => f.status === "merged" || f.status === "conflict")).toBe(false);
    expect(result.files.filter((f) => f.status === "overwrite").length).toBe(names.length);
  });

  test("without --baseline=fresh the same state still merges (the cache is only ignored by fresh)", async () => {
    await gen();
    const names = staleAndUnrecorded();
    await gen();
    // The stale line is a hand edit against the snapshot base, so the default flow keeps it.
    expect(readFileSync(join(outDir(), names[0]!), "utf-8")).toContain("STALE LINE");
  });

  test("a recorded path still three-way merges under fresh", async () => {
    await gen();
    const names = readdirSync(outDir()).filter((e) => statSync(join(outDir(), e)).isFile());
    const f = join(outDir(), names[0]!);
    writeFileSync(f, readFileSync(f, "utf-8") + "// my hand edit\n");
    await gen("fresh");
    expect(readFileSync(f, "utf-8")).toContain("// my hand edit");
  });
});
