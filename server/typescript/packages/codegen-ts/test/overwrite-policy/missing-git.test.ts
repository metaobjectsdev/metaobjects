// Missing-git scenario — when `git` is not on PATH, a real merge would throw
// ENOENT halfway through. We surface this as a clear `GitMissingError` with a
// remediation hint instead of a generic spawn failure.
//
// We simulate the missing-git case by pointing META_GEN_GIT at a non-existent
// binary (overriding the "git" default). Avoids depending on PATH manipulation,
// which Bun does not always honor for spawnSync resolution.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite, GitMissingError } from "../../src/overwrite-policy.js";

let tmp: string;
let state: string;
let prevGit: string | undefined;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-nogit-"));
  state = mkdtempSync(join(tmpdir(), "codegen-state-"));
  prevGit = process.env.META_GEN_GIT;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  rmSync(state, { recursive: true, force: true });
  if (prevGit !== undefined) {
    process.env.META_GEN_GIT = prevGit;
  } else {
    delete process.env.META_GEN_GIT;
  }
});

describe("missing git binary", () => {
  test("merge attempt with git unavailable → GitMissingError with remediation hint", () => {
    const path = join(tmp, "User.ts");

    // Seed: a real first-run write so .gen-state exists. (Note: this DOESN'T
    // invoke git — first-run is a straight write.)
    decideAndWrite(path, "v1\n", { genStateDir: state, outputRelPath: "User.ts" });

    // Pretend git is missing for the merge step.
    process.env.META_GEN_GIT = "/usr/bin/totally-not-a-real-binary-xyz123";

    // Edit the output to differ from the snapshot, forcing a merge call.
    writeFileSync(path, "user edit\n");

    let caught: unknown = undefined;
    try {
      decideAndWrite(path, "v2\n", { genStateDir: state, outputRelPath: "User.ts" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(GitMissingError);
    expect((caught as Error).message).toContain("git");
    expect((caught as Error).message).toContain("PATH");
  });
});
