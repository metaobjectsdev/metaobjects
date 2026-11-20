// ADR-0064 §1 and §2: within a run the hash manifest is written once, and only when an
// entry changed; a file whose new bytes equal what is on disk is never rewritten.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isManifestPath, manifestEntries, manifestFiles, manifestMtimes } from "../support/manifest.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite, mergeTempDir, withManifestBatch } from "../../src/overwrite-policy.js";

let out: string;
let state: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "codegen-once-"));
  state = mkdtempSync(join(tmpdir(), "codegen-once-state-"));
});
afterEach(() => {
  rmSync(out, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
});

function run(files: Record<string, string>): void {
  withManifestBatch(state, () => {
    for (const [name, content] of Object.entries(files)) {
      decideAndWrite(join(out, name), content, { genStateDir: state, outputRelPath: name });
    }
  });
}

const manifestWrites = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter((c) => String(c[0]).includes("/.hashes/")).length;

describe("hash manifest, once per run", () => {
  test("a run that writes many files writes the manifest once", () => {
    const spy = spyOn(fs, "writeFileSync");
    try {
      run({ "A.ts": "a\n", "B.ts": "b\n", "C.ts": "c\n" });
      expect(manifestWrites(spy)).toBe(1);
    } finally { spy.mockRestore(); }
    expect(Object.keys(manifestEntries(state)).sort()).toEqual(["A.ts", "B.ts", "C.ts"]);
  });

  test("a run that changes nothing does not write the manifest", () => {
    run({ "A.ts": "a\n", "B.ts": "b\n" });
    const before = manifestMtimes(state);
    const beforeBytes = manifestFiles(state);
    const spy = spyOn(fs, "writeFileSync");
    try {
      run({ "A.ts": "a\n", "B.ts": "b\n" });
      expect(manifestWrites(spy)).toBe(0);
    } finally { spy.mockRestore(); }
    expect(manifestMtimes(state)).toEqual(before);
    expect(manifestFiles(state)).toEqual(beforeBytes);
  });
});

describe("identical bytes are never rewritten", () => {
  test("new output equal to a file already on disk leaves it untouched", () => {
    run({ "A.ts": "a\n" });
    // The file moves on by hand to exactly what the next run renders.
    writeFileSync(join(out, "A.ts"), "a2\n");
    const before = statSync(join(out, "A.ts")).mtimeMs;
    const spy = spyOn(fs, "writeFileSync");
    try {
      run({ "A.ts": "a2\n" });
      expect(spy.mock.calls.filter((c) => String(c[0]) === join(out, "A.ts")).length).toBe(0);
    } finally { spy.mockRestore(); }
    expect(statSync(join(out, "A.ts")).mtimeMs).toBe(before);
    expect(readFileSync(join(out, "A.ts"), "utf-8")).toBe("a2\n");
    // And the record now matches, so the next run is a plain no-change.
    const spy2 = spyOn(fs, "writeFileSync");
    try {
      run({ "A.ts": "a2\n" });
      expect(spy2.mock.calls.length).toBe(0);
    } finally { spy2.mockRestore(); }
  });
});

describe("three-way merge temporaries", () => {
  let scratch: string;
  let saved: string | undefined;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "codegen-once-scratch-"));
    saved = process.env.DEV_SCRATCH;
    process.env.DEV_SCRATCH = scratch;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.DEV_SCRATCH; else process.env.DEV_SCRATCH = saved;
    rmSync(scratch, { recursive: true, force: true });
  });

  const leftovers = () => {
    const dir = mergeTempDir();
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };

  test("live under $DEV_SCRATCH", () => {
    expect(mergeTempDir().startsWith(scratch)).toBe(true);
  });

  test("an untouched file is overwritten without a merge: no temporaries at all", () => {
    run({ "A.ts": "a\n" });
    run({ "A.ts": "a2\n" });
    expect(readFileSync(join(out, "A.ts"), "utf-8")).toBe("a2\n");
    expect(fs.existsSync(mergeTempDir())).toBe(false);
  });

  test("a hand-edited file is merged, and the run leaves nothing behind, clean or conflicted", () => {
    run({ "A.ts": "one\ntwo\nthree\nfour\nfive\n" });
    // A hand edit at the top, a generator change at the bottom: a clean merge.
    writeFileSync(join(out, "A.ts"), "ONE\ntwo\nthree\nfour\nfive\n");
    run({ "A.ts": "one\ntwo\nthree\nfour\nFIVE\n" });
    expect(readFileSync(join(out, "A.ts"), "utf-8")).toBe("ONE\ntwo\nthree\nfour\nFIVE\n");
    expect(leftovers()).toEqual([]);
    // Both sides change the same line: a conflict.
    writeFileSync(join(out, "A.ts"), "ONE\ntwo\nthree\nfour\nmine\n");
    run({ "A.ts": "one\ntwo\nthree\nfour\ntheirs\n" });
    expect(readFileSync(join(out, "A.ts"), "utf-8")).toContain("<<<<<<<");
    expect(leftovers()).toEqual([]);
  });
});
