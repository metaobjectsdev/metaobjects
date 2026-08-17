// The upgrade path must not be a wall of refusals.
//
// An adopter whose project predates the committed manifest, running `meta gen` on a
// fresh checkout, gets a refusal for every file whose committed output differs from
// fresh output — potentially dozens, all with ONE cause and ONE fix. Reported per
// file, the instruction is buried; that is how a tool gets switched off on first
// contact (the 0.21.4 grid-discoverability lesson).
//
// So: no manifest at all ⇒ one aggregated, actionable message. A manifest that
// exists but lacks a path ⇒ per-file naming, because there the file IS the
// information. Self-extinguishing either way.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { entityFile, queriesFile } from "../src/generators/index.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), "no-manifest-")); });
afterEach(() => { rmSync(projectRoot, { recursive: true, force: true }); });

const genStateDir = (): string => join(projectRoot, ".metaobjects", ".gen-state");
const outDir = (): string => join(projectRoot, "generated");

async function gen(opts: { dryRun?: boolean } = {}) {
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
    ...(opts.dryRun === true && { dryRun: true }),
  });
}

/** Drop the whole gen-state: the state of a project whose .gitignore still reads
 *  `.gen-state/`, cloned fresh. */
function dropAllGenState(): void {
  rmSync(genStateDir(), { recursive: true, force: true });
}

/** Keep the manifest, drop only the bodies: a MIGRATED project, cloned fresh. */
function dropBodiesOnly(): void {
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir)) {
      const full = join(dir, e);
      if (statSync(full).isDirectory()) { walk(full); rmSync(full, { recursive: true, force: true }); }
      else if (e !== ".hashes.json" && e !== ".engine.json") rmSync(full, { force: true });
    }
  };
  walk(genStateDir());
}

/** Make every generated file differ from fresh output, as an engine upgrade would. */
function makeAllOutputStale(): string[] {
  const touched: string[] = [];
  for (const entry of readdirSync(outDir())) {
    const full = join(outDir(), entry);
    if (statSync(full).isFile()) {
      writeFileSync(full, "// stale from an older engine\n");
      touched.push(entry);
    }
  }
  expect(touched.length).toBeGreaterThan(1);   // the wall needs >1 file to be a wall
  return touched;
}

describe("no manifest at all — the upgrade path", () => {
  test("many refusals produce ONE message, not one per file", async () => {
    await gen();
    const stale = makeAllOutputStale();
    dropAllGenState();

    const result = await gen();

    const refused = result.files.filter((f) => f.status === "refused");
    expect(refused.length).toBe(stale.length);

    // The point: N refusals, ONE warning.
    expect(result.warnings.length).toBe(1);
    const msg = result.warnings[0]!;
    expect(msg).toContain(`${refused.length} existing file(s)`);
    expect(msg).toContain("--baseline=fresh");
    expect(msg).toContain(".hashes.json");
    // Names some files so it is actionable, without pasting all of them.
    expect(msg).toContain("Post.ts");
  });

  test("nothing was written — the refusal is real, not cosmetic", async () => {
    await gen();
    makeAllOutputStale();
    dropAllGenState();

    await gen();
    for (const entry of readdirSync(outDir())) {
      const full = join(outDir(), entry);
      if (statSync(full).isFile()) {
        expect(Bun.file(full).text()).resolves.toBe("// stale from an older engine\n");
      }
    }
  });

  test("--dry-run previews the refusals and the same one message", async () => {
    await gen();
    makeAllOutputStale();
    dropAllGenState();

    const result = await gen({ dryRun: true });
    expect(result.files.some((f) => f.status === "refused")).toBe(true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain("--baseline=fresh");
  });

  test("it is self-extinguishing: once the manifest exists, the aggregate stops", async () => {
    await gen();                       // manifest now exists
    makeAllOutputStale();
    dropBodiesOnly();                  // migrated project, fresh clone

    const result = await gen();
    const msgs = result.warnings.filter((w) => w.includes("no codegen hash manifest"));
    expect(msgs).toEqual([]);
    // Per-file naming instead, because here the file IS the information.
    const perFile = result.warnings.filter((w) => w.includes("Refused to overwrite"));
    expect(perFile.length).toBeGreaterThan(1);
    expect(perFile.some((w) => w.includes("Post.ts"))).toBe(true);
  });
});

describe("a migrated project", () => {
  test("an untouched file regenerates with no warning at all", async () => {
    await gen();
    dropBodiesOnly();

    const result = await gen();
    expect(result.files.some((f) => f.status === "refused")).toBe(false);
    expect(result.warnings.filter((w) => w.includes("Refused"))).toEqual([]);
    expect(existsSync(join(genStateDir(), ".hashes.json"))).toBe(true);
  });
});
