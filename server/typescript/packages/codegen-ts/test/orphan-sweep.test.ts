// FR-038 §8 — the filesystem half of orphan reconciliation.
//
// reconcile-orphans.ts decides; this binds the decision to real files. The cases
// worth pinning are the ones where getting it wrong destroys work: an edited
// orphan must survive, and a namespace boundary must hold even when a generator
// stops emitting everything it used to.
//
// Every fixture goes through `decideAndWrite` rather than writing snapshots by
// hand, so the gen-state these tests reconcile is the gen-state `meta gen`
// actually produces.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite, listGeneratedPaths } from "../src/overwrite-policy.js";
import { sweepOrphans, type OrphanJob } from "../src/orphan-sweep.js";

let root: string;
let genStateDir: string;
let outDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "orphan-sweep-"));
  genStateDir = join(root, ".gen-state");
  outDir = join(root, "src", "generated");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Generate `relPath` (project-relative) the way the runner does. */
function generate(relPath: string, content: string): void {
  decideAndWrite(join(root, relPath), content, {
    genStateDir,
    outputRelPath: relPath,
  });
}

/** A job owning everything under `requirements/` inside `outDir`. */
function reqJob(overrides: Partial<OrphanJob> = {}): OrphanJob {
  return {
    generatorName: "requirement-tests",
    writeOutDir: outDir,
    policy: { owns: (rel) => rel.startsWith("requirements/") },
    ...overrides,
  };
}

const STUB_A = "src/generated/requirements/a.object.entity.test.ts";
const STUB_B = "src/generated/requirements/b.object.entity.test.ts";

describe("sweepOrphans", () => {
  test("removes an untouched orphan and leaves what this run still emits", () => {
    generate(STUB_A, "// stub a\n");
    generate(STUB_B, "// stub b\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [STUB_B],
      jobs: [reqJob()],
      dryRun: false,
    });

    expect(result.removed).toEqual([STUB_A]);
    expect(result.refused).toEqual([]);
    expect(existsSync(join(root, STUB_A))).toBe(false);
    expect(existsSync(join(root, STUB_B))).toBe(true);
    // Both halves of the record go, or the next run re-decides a settled orphan.
    expect(listGeneratedPaths(genStateDir)).toEqual([STUB_B]);
  });

  test("REFUSES a hand-edited orphan — the file and its edit survive", () => {
    generate(STUB_A, "// stub a\n");
    writeFileSync(join(root, STUB_A), "// stub a\nexpect(realThing).toBe(true);\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob()],
      dryRun: false,
    });

    expect(result.refused).toEqual([STUB_A]);
    expect(result.removed).toEqual([]);
    expect(readFileSync(join(root, STUB_A), "utf-8")).toContain("expect(realThing)");
    // The record is KEPT for a refused file: dropping it would make the next run
    // blind to the orphan, turning a refusal into permanent silence.
    expect(listGeneratedPaths(genStateDir)).toEqual([STUB_A]);
  });

  test("never touches a path outside the declared namespace", () => {
    // The disease this guards: every generator in a single-target project shares
    // one outDir, so a generator that stops emitting must not reach its siblings.
    generate("src/generated/Council.ts", "export const a = 1;\n");
    generate(STUB_A, "// stub a\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob()],
      dryRun: false,
    });

    expect(result.removed).toEqual([STUB_A]);
    expect(existsSync(join(root, "src/generated/Council.ts"))).toBe(true);
    expect(listGeneratedPaths(genStateDir)).toEqual(["src/generated/Council.ts"]);
  });

  test("never touches a path outside the generator's own output directory", () => {
    // Same-shaped relative path, different target. An `owns` predicate written
    // against one target's layout must not match another target's file.
    generate("web/requirements/a.object.entity.test.ts", "// other target\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob()],
      dryRun: false,
    });

    expect(result.removed).toEqual([]);
    expect(existsSync(join(root, "web/requirements/a.object.entity.test.ts"))).toBe(true);
  });

  test("forgets a record whose file a human already deleted, silently", () => {
    generate(STUB_A, "// stub a\n");
    rmSync(join(root, STUB_A));

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob()],
      dryRun: false,
    });

    // Nothing happened on disk, so nothing is reported — but the stale record is
    // cleared, or every future run re-examines a file that is already gone.
    expect(result.removed).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(listGeneratedPaths(genStateDir)).toEqual([]);
  });

  test("works with the snapshot BODY gone — the hash manifest is the evidence", () => {
    // The fresh-clone shape, and the reason the decision moved off the body: the
    // bodies are gitignored, so if cleanup needed one it could never prove a file
    // untouched on a clean checkout and would refuse forever.
    generate(STUB_A, "// stub a\n");
    rmSync(join(genStateDir, STUB_A), { force: true });

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob()],
      dryRun: false,
    });

    expect(result.removed).toEqual([STUB_A]);
    expect(existsSync(join(root, STUB_A))).toBe(false);
  });

  test("refuses when the manifest entry does not match the file", () => {
    // The manifest is the trust root. An entry that disagrees with the file on
    // disk means the file is not what we wrote, whatever the reason.
    generate(STUB_A, "// stub a\n");
    const hashesPath = join(genStateDir, ".hashes.json");
    const hashes = JSON.parse(readFileSync(hashesPath, "utf-8")) as Record<string, string>;
    hashes[STUB_A] = "0".repeat(64);
    writeFileSync(hashesPath, JSON.stringify(hashes, null, 2) + "\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob()],
      dryRun: false,
    });

    expect(result.refused).toEqual([STUB_A]);
    expect(existsSync(join(root, STUB_A))).toBe(true);
  });

  test("force deletes a hand-edited orphan, and reports it separately", () => {
    generate(STUB_A, "// stub a\n");
    writeFileSync(join(root, STUB_A), "// stub a\nexpect(realThing).toBe(true);\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob({ policy: { owns: (rel) => rel.startsWith("requirements/"), force: true } })],
      dryRun: false,
    });

    // Reported as `forced`, NOT folded into `removed`: losing a hand-written
    // assertion deserves a louder line than removing our own output.
    expect(result.forced).toEqual([STUB_A]);
    expect(result.removed).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(existsSync(join(root, STUB_A))).toBe(false);
    expect(listGeneratedPaths(genStateDir)).toEqual([]);
  });

  test("dryRun reports the same decision and changes NOTHING on disk", () => {
    generate(STUB_A, "// stub a\n");
    writeFileSync(join(root, STUB_B), "// untracked\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob()],
      dryRun: true,
    });

    expect(result.removed).toEqual([STUB_A]);
    expect(existsSync(join(root, STUB_A))).toBe(true);
    expect(listGeneratedPaths(genStateDir)).toEqual([STUB_A]);
  });

  test("a run with no opt-in generator reconciles nothing", () => {
    generate(STUB_A, "// stub a\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [],
      dryRun: false,
    });

    expect(result).toEqual({ removed: [], refused: [], forced: [] });
    expect(existsSync(join(root, STUB_A))).toBe(true);
  });

  test("two jobs claiming one path remove it once, not twice", () => {
    generate(STUB_A, "// stub a\n");

    const result = sweepOrphans({
      genStateDir,
      projectRoot: root,
      emittedRelPaths: [],
      jobs: [reqJob(), reqJob({ generatorName: "requirement-tests-ui" })],
      dryRun: false,
    });

    expect(result.removed).toEqual([STUB_A]);
    expect(existsSync(join(root, STUB_A))).toBe(false);
  });
});
