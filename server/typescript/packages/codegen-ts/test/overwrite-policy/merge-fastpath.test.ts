// The unedited-file fast path and merge temp-file cleanup, at the decideAndWrite level.
//
// An unedited file (on disk === .gen-state snapshot) must take the fresh output
// without spawning `git merge-file`, and advance the snapshot and its hash as a clean
// merge does; an edited file still merges or conflicts as before; and no merge input
// file may outlive its merge, including when the merge throws.
//
// "Never spawns git" is proven by pointing META_GEN_GIT at a binary that does not
// exist: any spawn would throw GitMissingError. Leftover temporaries are read from
// mergeTempDir(), pointed at a private directory through DEV_SCRATCH.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  contentHash,
  decideAndWrite,
  GitMissingError,
  mergeTempDir,
  readGeneratedHash,
} from "../../src/overwrite-policy.js";
import { makeScratchDir, removeTree } from "../../src/scratch-dir.js";

const NO_GIT = "/usr/bin/totally-not-a-real-binary-xyz123";

let root: string;
let out: string;
let state: string;
let prevGit: string | undefined;
let prevScratch: string | undefined;

beforeEach(() => {
  root = makeScratchDir("codegen-fastpath-");
  out = join(root, "out");
  state = join(root, "state");
  prevGit = process.env.META_GEN_GIT;
  prevScratch = process.env.DEV_SCRATCH;
  process.env.DEV_SCRATCH = join(root, "scratch");
});

afterEach(() => {
  if (prevGit === undefined) delete process.env.META_GEN_GIT;
  else process.env.META_GEN_GIT = prevGit;
  if (prevScratch === undefined) delete process.env.DEV_SCRATCH;
  else process.env.DEV_SCRATCH = prevScratch;
  removeTree(root);
});

const opts = () => ({ genStateDir: state, outputRelPath: "User.ts" });
const userPath = () => join(out, "User.ts");
const tmpLeft = () => (existsSync(mergeTempDir()) ? readdirSync(mergeTempDir()) : []);

describe("unedited file fast path", () => {
  test("never spawns git merge-file and gets the fresh content, snapshot and hash advanced", () => {
    decideAndWrite(userPath(), "v1\n", opts());
    process.env.META_GEN_GIT = NO_GIT;

    const result = decideAndWrite(userPath(), "v2\n", opts());

    expect(result.status).toBe("overwrite");
    expect(readFileSync(userPath(), "utf-8")).toBe("v2\n");
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe("v2\n");
    expect(readGeneratedHash(state, "User.ts")).toBe(contentHash("v2\n"));
    expect(tmpLeft()).toEqual([]);
  });
});

describe("edited file still merges", () => {
  const base = "line1\nline2\nline3\nline4\nline5\n";

  test("a non-overlapping edit merges cleanly, and no temp file remains", () => {
    decideAndWrite(userPath(), base, opts());
    writeFileSync(userPath(), "line1 EDITED\nline2\nline3\nline4\nline5\n");

    const result = decideAndWrite(userPath(), "line1\nline2\nline3\nline4\nline5 FRESH\n", opts());

    expect(result.status).toBe("merged");
    expect(readFileSync(userPath(), "utf-8")).toBe("line1 EDITED\nline2\nline3\nline4\nline5 FRESH\n");
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe("line1\nline2\nline3\nline4\nline5 FRESH\n");
    expect(tmpLeft()).toEqual([]);
  });

  test("an overlapping edit conflicts without advancing the snapshot, and no temp file remains", () => {
    decideAndWrite(userPath(), base, opts());
    writeFileSync(userPath(), "line1 MINE\nline2\nline3\nline4\nline5\n");

    const result = decideAndWrite(userPath(), "line1 THEIRS\nline2\nline3\nline4\nline5\n", opts());

    expect(result.status).toBe("conflict");
    expect(readFileSync(userPath(), "utf-8")).toContain("<<<<<<<");
    expect(readFileSync(join(state, "User.ts"), "utf-8")).toBe(base);
    expect(tmpLeft()).toEqual([]);
  });

  test("a merge that throws leaves no temp file behind", () => {
    decideAndWrite(userPath(), base, opts());
    writeFileSync(userPath(), "edited\n");
    process.env.META_GEN_GIT = NO_GIT;

    expect(() => decideAndWrite(userPath(), "fresh\n", opts())).toThrow(GitMissingError);
    expect(tmpLeft()).toEqual([]);
  });
});
