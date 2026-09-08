// `--baseline=adopt` — the first step a pre-manifest project can actually perform.
//
// The no-manifest refusal used to LEAD with "commit .metaobjects/.gen-state/.hashes.json",
// which the population it names cannot do: nothing writes a manifest until a `gen` succeeds,
// and `gen` refuses until one exists. The only escape was `--baseline=fresh`, framed —
// correctly — as the lossy one, so an adopter whose committed output was already a
// byte-identical regen still had to reason their way past a warning about losing work.
//
// `adopt` closes that loop by separating the two things `fresh` does at once: it records the
// files you HAVE as the merge base and writes nothing. What it is NOT is a way to protect an
// edit that is already inside one of those files — the base becomes the edited text, so the
// next regen replaces it. That is pinned below, because the message says it and a message
// nothing tests goes stale.

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

async function gen(opts: { baseline?: BaselineMode; dryRun?: boolean } = {}) {
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
    ...(opts.baseline !== undefined && { baseline: opts.baseline }),
    ...(opts.dryRun === true && { dryRun: true }),
  });
}

/** The state of a project that predates the committed manifest: output on disk, no gen-state. */
function dropAllGenState(): void {
  rmSync(genStateDir(), { recursive: true, force: true });
}

/** Make every generated file differ from fresh output, as an older engine's output would. */
function makeAllOutputStale(marker = "// from an older engine\n"): string[] {
  const touched: string[] = [];
  for (const entry of readdirSync(outDir())) {
    const full = join(outDir(), entry);
    if (statSync(full).isFile()) { writeFileSync(full, marker); touched.push(entry); }
  }
  expect(touched.length).toBeGreaterThan(1);
  return touched;
}

const filesOnDisk = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(outDir())) {
    const full = join(outDir(), entry);
    if (statSync(full).isFile()) out[entry] = readFileSync(full, "utf-8");
  }
  return out;
};

describe("--baseline=adopt", () => {
  test("records the files you have and writes NOTHING", async () => {
    await gen();
    const stale = makeAllOutputStale();
    dropAllGenState();
    const before = filesOnDisk();

    const result = await gen({ baseline: "adopt" });

    const adopted = result.files.filter((f) => f.status === "adopted");
    expect(adopted.length).toBe(stale.length);
    expect(result.files.some((f) => f.status === "refused")).toBe(false);
    // Not one byte written: this is the whole promise of the mode.
    expect(filesOnDisk()).toEqual(before);
    // …and the manifest the adopter is told to commit now exists, naming those files.
    expect(existsSync(hashesFile())).toBe(true);
    const hashes = JSON.parse(readFileSync(hashesFile(), "utf-8")) as Record<string, string>;
    expect(Object.keys(hashes).length).toBeGreaterThanOrEqual(stale.length);
  });

  test("the run says what to do next, once, and does not claim to have written anything", async () => {
    await gen();
    makeAllOutputStale();
    dropAllGenState();

    const result = await gen({ baseline: "adopt" });

    const notice = result.warnings.filter((w) => w.includes("baseline"));
    expect(notice.length).toBe(1);
    expect(notice[0]).toContain(".hashes.json");
    // The honesty clause: adopt declares your files to BE generated output.
    expect(notice[0]).toMatch(/replace|regenerat/i);
  });

  test("after adopt, the next plain run regenerates instead of refusing", async () => {
    await gen();
    makeAllOutputStale();
    dropAllGenState();
    await gen({ baseline: "adopt" });

    const result = await gen();

    expect(result.files.some((f) => f.status === "refused")).toBe(false);
    expect(result.files.some((f) => f.status === "overwrite" || f.status === "merged")).toBe(true);
  });

  test("an edit that PREDATES the adopt run is not protected — it becomes the base", async () => {
    // The claim the message must not overstate. `adopt` records what is on disk as the
    // merge base, so base == ours, and a three-way merge against fresh output takes fresh
    // wholesale. Losslessness here is about the ADOPT run (it writes nothing, and your
    // files stay in git) — not about the regen that follows it.
    await gen();
    makeAllOutputStale("// an edit nobody recorded\n");
    dropAllGenState();
    await gen({ baseline: "adopt" });

    await gen();

    for (const text of Object.values(filesOnDisk())) {
      expect(text).not.toContain("an edit nobody recorded");
    }
  });

  test("an edit made AFTER adopt survives the next run — that is what the baseline buys", async () => {
    await gen();
    makeAllOutputStale();
    dropAllGenState();
    await gen({ baseline: "adopt" });

    // Now edit, the way an adopter edits a file they own.
    const target = Object.keys(filesOnDisk())[0]!;
    const path = join(outDir(), target);
    writeFileSync(path, readFileSync(path, "utf-8") + "\n// my hand edit\n");

    await gen();

    expect(readFileSync(path, "utf-8")).toContain("my hand edit");
  });

  test("adopt does NOT suppress a legitimate regen of a pristine file", async () => {
    // A file the manifest records and whose content still matches has nothing to lose,
    // so it overwrites in every mode. `adopt` only ever replaces a REFUSAL.
    await gen();
    const bodies = readdirSync(genStateDir(), { recursive: true }) as string[];
    expect(bodies.length).toBeGreaterThan(0);
    // Drop the snapshot BODIES only — a migrated project on a fresh clone.
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir)) {
        const full = join(dir, e);
        if (statSync(full).isDirectory()) { walk(full); rmSync(full, { recursive: true, force: true }); }
        else if (e !== ".hashes.json" && e !== ".engine.json") rmSync(full, { force: true });
      }
    };
    walk(genStateDir());

    const result = await gen({ baseline: "adopt" });

    expect(result.files.some((f) => f.status === "adopted")).toBe(false);
    expect(result.files.every((f) => f.status !== "refused")).toBe(true);
  });

  test("--dry-run previews adoption and writes no manifest", async () => {
    await gen();
    makeAllOutputStale();
    dropAllGenState();

    const result = await gen({ baseline: "adopt", dryRun: true });

    expect(result.files.some((f) => f.status === "adopted")).toBe(true);
    expect(existsSync(hashesFile())).toBe(false);
  });
});

describe("the refusal message, with adopt available", () => {
  test("leads with the remedy the reader can perform", async () => {
    await gen();
    makeAllOutputStale();
    dropAllGenState();

    const result = await gen();

    expect(result.warnings.length).toBe(1);
    const msg = result.warnings[0]!;
    expect(msg).toContain("--baseline=adopt");
    // `fresh` stays, named as the discard it is.
    expect(msg).toContain("--baseline=fresh");
    // What it must no longer do: prescribe committing a file this project has no way to produce.
    expect(msg).not.toMatch(/ONE-TIME FIX: commit/);
    // adopt is named BEFORE fresh — the leading remedy is the performable one.
    expect(msg.indexOf("--baseline=adopt")).toBeLessThan(msg.indexOf("--baseline=fresh"));
  });
});
