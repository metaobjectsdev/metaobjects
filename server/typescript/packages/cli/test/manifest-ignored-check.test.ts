// The check that ships with the fix.
//
// A project whose `.gitignore` still excludes `.gen-state/.hashes.json` looks
// completely healthy — gen succeeds, output is correct — while hand-edit detection
// silently does not work anywhere but the generating machine. That invisibility is
// the whole reason a doc is not enough.
//
// Uses REAL git repositories in a tmpdir, because the specific rule being caught
// (a directory exclusion preventing a `!` negation inside it from ever applying) is
// exactly the one a hand-rolled .gitignore parser gets wrong.

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { warnIfManifestIgnored, HASH_MANIFEST_REL } from "../src/lib/manifest-ignored-check.js";
import { log } from "../src/lib/log.js";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "manifest-ignored-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function gitInit(): void {
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf-8" });
}

function writeManifest(): void {
  const p = join(root, HASH_MANIFEST_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "{}\n");
}

function writeIgnore(body: string): void {
  mkdirSync(join(root, ".metaobjects"), { recursive: true });
  writeFileSync(join(root, ".metaobjects", ".gitignore"), body);
}

/** Capture warnings without printing them. */
function captureWarnings(fn: () => void): string[] {
  const seen: string[] = [];
  const spy = spyOn(log, "warn").mockImplementation((m: string) => { seen.push(m); });
  try { fn(); } finally { spy.mockRestore(); }
  return seen;
}

describe("warnIfManifestIgnored", () => {
  test("WARNS on the trap: '.gen-state/' makes the negation unreachable", () => {
    gitInit();
    writeManifest();
    // The naive form. git will not descend into an excluded directory, so the `!`
    // below it never applies — the manifest stays ignored and nobody notices.
    writeIgnore(".gen-state/\n!.gen-state/.hashes.json\n");

    const warnings = captureWarnings(() => warnIfManifestIgnored(root));
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(".hashes.json");
    expect(warnings[0]).toContain(".gen-state/*");
  });

  test("SILENT on the correct glob form", () => {
    gitInit();
    writeManifest();
    writeIgnore(".gen-state/*\n!.gen-state/.hashes.json\n");
    expect(captureWarnings(() => warnIfManifestIgnored(root))).toEqual([]);
  });

  test("SILENT when nothing has been generated yet — nothing is at risk", () => {
    gitInit();
    writeIgnore(".gen-state/\n");        // ignored, but no manifest exists
    expect(captureWarnings(() => warnIfManifestIgnored(root))).toEqual([]);
  });

  test("SILENT outside a git repository", () => {
    writeManifest();
    writeIgnore(".gen-state/\n");
    expect(captureWarnings(() => warnIfManifestIgnored(root))).toEqual([]);
  });

  test("SILENT when git is unavailable, and never throws", () => {
    gitInit();
    writeManifest();
    writeIgnore(".gen-state/\n");
    const prev = process.env.META_GEN_GIT;
    process.env.META_GEN_GIT = join(root, "definitely-not-a-real-git-binary");
    try {
      expect(captureWarnings(() => warnIfManifestIgnored(root))).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.META_GEN_GIT;
      else process.env.META_GEN_GIT = prev;
    }
  });

  test("SILENT with no ignore rules at all", () => {
    gitInit();
    writeManifest();
    expect(captureWarnings(() => warnIfManifestIgnored(root))).toEqual([]);
  });
});
