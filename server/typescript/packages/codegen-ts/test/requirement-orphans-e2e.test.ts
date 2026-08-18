// FR-038 §8, end to end — deletion integrity through the real runner.
//
// The decision logic and its filesystem binding are unit-tested elsewhere. What
// this file gates is the part neither of those can see: that `runGen` actually
// CALLS them. The mechanism shipped inert once already — committed, tested, and
// wired to nothing — so a test that stops at `sweepOrphans` would have passed
// against a runner that never invoked it.
//
// Every case here drives two real `runGen` runs against a real project directory,
// deleting a requirement between them, and asserts on the files left on disk.

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { runGen } from "../src/runner.js";
import { requirementTests } from "../src/generators/requirement-tests.js";

const OUT_DIR = "tests";

/** A model carrying `keep` plus, optionally, `drop` — so "delete a requirement"
 *  is expressed the way an author expresses it: the node is simply not there. */
function model(withDrop: boolean): string {
  const req = (name: string) => ({
    "requirement.functional": {
      name,
      "@level": 4,
      "@status": "live",
      "@statement": `${name} works.`,
      "@violation": `${name} does not work`,
      "@implementedBy": ["Council"],
    },
  });
  return JSON.stringify({
    "metadata.root": {
      package: "acme::probe",
      children: [
        {
          "object.entity": {
            name: "Council",
            children: [{ "field.string": { name: "slug" } }],
          },
        },
        req("keep"),
        ...(withDrop ? [req("drop")] : []),
      ],
    },
  });
}

async function load(withDrop: boolean): Promise<MetaRoot> {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(model(withDrop))]);
  if (r.errors.length > 0) {
    throw new Error(r.errors.map((e) => e.message).join("\n"));
  }
  return r.root;
}

let projectRoot: string;

const KEEP_STUB = join(OUT_DIR, "requirements", "keep.object.entity.test.ts");
const DROP_STUB = join(OUT_DIR, "requirements", "drop.object.entity.test.ts");

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "req-orphan-e2e-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

interface GenOpts {
  withDrop: boolean;
  dryRun?: boolean;
  generatorOpts?: Parameters<typeof requirementTests>[0];
}

async function gen(opts: GenOpts) {
  return runGen({
    config: {
      outDir: OUT_DIR,
      extStyle: "js",
      // No dialect/dbImport on purpose: the model's one entity is sourceless, so
      // nothing here generates database code and the runner's #194 guard has
      // nothing to demand — which also keeps this fixture about requirements.
      generators: [requirementTests(opts.generatorOpts ?? {})],
    },
    metadata: await load(opts.withDrop),
    projectRoot,
    ...(opts.dryRun === true && { dryRun: true }),
  });
}

const abs = (rel: string): string => join(projectRoot, rel);

describe("a filtered run never reconciles deletions", () => {
  test("meta gen <entity> skips the sweep and says why", async () => {
    // A partial run's emitted set is a subset BY CONSTRUCTION, so every unselected
    // entity's output looks like an orphan. Deleting on that basis wipes files the run
    // was never asked to consider.
    await gen({ withDrop: true });
    expect(existsSync(abs(DROP_STUB))).toBe(true);

    const { root } = await new MetaDataLoader().load([
      new InMemoryStringSource(model(false)),
    ]);
    const result = await runGen({
      config: {
        outDir: OUT_DIR,
        extStyle: "js",
        generators: [requirementTests({})],
      },
      metadata: root,
      projectRoot,
      entityFilter: ["Council"],
    });

    // The requirement is gone from the model, but this run cannot prove that is why.
    expect(existsSync(abs(DROP_STUB))).toBe(true);
    expect(result.files.filter((f) => f.status === "removed")).toEqual([]);
    expect(result.warnings.some((w) => w.includes("Skipped orphan cleanup"))).toBe(true);
  });

  test("the same model on an UNFILTERED run does reconcile", async () => {
    // Proves the guard is about the filter, not about the model.
    await gen({ withDrop: true });
    const result = await gen({ withDrop: false });
    expect(existsSync(abs(DROP_STUB))).toBe(false);
    expect(result.files.some((f) => f.status === "removed")).toBe(true);
  });
});

describe("requirement stub deletion integrity, through runGen", () => {
  test("both stubs are written on the first run", async () => {
    const result = await gen({ withDrop: true });
    expect(existsSync(abs(KEEP_STUB))).toBe(true);
    expect(existsSync(abs(DROP_STUB))).toBe(true);
    // Nothing to reconcile on a first run — there is no previous output.
    expect(result.files.filter((f) => f.status === "removed")).toEqual([]);
  });

  test("deleting a requirement removes its UNTOUCHED stub, and only its own", async () => {
    await gen({ withDrop: true });
    const result = await gen({ withDrop: false });

    expect(existsSync(abs(DROP_STUB))).toBe(false);
    expect(existsSync(abs(KEEP_STUB))).toBe(true);
    expect(result.files.filter((f) => f.status === "removed").map((f) => f.path)).toEqual([
      abs(DROP_STUB),
    ]);
    // A removal is not a problem — it should not masquerade as one.
    expect(result.warnings.filter((w) => w.includes("no longer produced"))).toEqual([]);
  });

  test("REFUSES to delete a stub whose body was filled in, and says why", async () => {
    await gen({ withDrop: true });
    const filled = readFileSync(abs(DROP_STUB), "utf-8").replace(
      /expect\.unreachable\([^)]*\);/,
      "expect(council.slug).toBeDefined();",
    );
    // Guard the fixture itself: if the renderer stops emitting expect.unreachable
    // this replace silently no-ops and the test would assert on an untouched file.
    expect(filled).not.toBe(readFileSync(abs(DROP_STUB), "utf-8"));
    writeFileSync(abs(DROP_STUB), filled);

    const result = await gen({ withDrop: false });

    expect(existsSync(abs(DROP_STUB))).toBe(true);
    expect(readFileSync(abs(DROP_STUB), "utf-8")).toContain("expect(council.slug)");
    expect(result.files.filter((f) => f.status === "removed")).toEqual([]);
    const refusal = result.warnings.find((w) => w.includes("no longer produced"));
    expect(refusal).toBeDefined();
    // Naming the file is the requirement — a refusal nobody can act on gets the
    // file deleted by hand, which is the outcome the refusal exists to prevent.
    expect(refusal).toContain("drop.object.entity.test.ts");
    expect(refusal).toContain("renamed");
  });

  test("the refusal REPEATS until resolved, rather than lapsing into silence", async () => {
    await gen({ withDrop: true });
    writeFileSync(abs(DROP_STUB), "// hand-written\n");
    await gen({ withDrop: false });

    const third = await gen({ withDrop: false });
    expect(third.warnings.some((w) => w.includes("no longer produced"))).toBe(true);
    expect(existsSync(abs(DROP_STUB))).toBe(true);
  });

  test("forceOrphanDelete deletes the filled stub, and says so loudly", async () => {
    await gen({ withDrop: true });
    writeFileSync(abs(DROP_STUB), "// hand-written\n");

    const result = await gen({
      withDrop: false,
      generatorOpts: { forceOrphanDelete: true },
    });

    expect(existsSync(abs(DROP_STUB))).toBe(false);
    expect(
      result.warnings.some((w) => w.includes("Hand-written content in them is gone")),
    ).toBe(true);
  });

  test("--dry-run reports the pending deletion and performs none", async () => {
    await gen({ withDrop: true });
    const result = await gen({ withDrop: false, dryRun: true });

    expect(result.files.filter((f) => f.status === "removed").map((f) => f.path)).toEqual([
      abs(DROP_STUB),
    ]);
    expect(existsSync(abs(DROP_STUB))).toBe(true);

    // And the preview left gen-state intact, so the real run still deletes it.
    const real = await gen({ withDrop: false });
    expect(real.files.filter((f) => f.status === "removed").map((f) => f.path)).toEqual([
      abs(DROP_STUB),
    ]);
    expect(existsSync(abs(DROP_STUB))).toBe(false);
  });

  test("reconcileOrphans: false leaves the orphan alone", async () => {
    await gen({ withDrop: true, generatorOpts: { reconcileOrphans: false } });
    const result = await gen({
      withDrop: false,
      generatorOpts: { reconcileOrphans: false },
    });

    expect(existsSync(abs(DROP_STUB))).toBe(true);
    expect(result.files.filter((f) => f.status === "removed")).toEqual([]);
  });

  test("a custom path with no owns warns, and deletes nothing", async () => {
    const generatorOpts = {
      path: (v: { path: string }, c: string) => `spec/${v.path}__${c}.spec.ts`,
    };
    const first = await gen({ withDrop: true, generatorOpts });
    expect(first.warnings.some((w) => w.includes("without a matching 'owns'"))).toBe(true);

    const custom = join(OUT_DIR, "spec", "drop__object.entity.spec.ts");
    expect(existsSync(abs(custom))).toBe(true);

    // Claiming nothing is the safe degradation: it can only ever delete less.
    const result = await gen({ withDrop: false, generatorOpts });
    expect(existsSync(abs(custom))).toBe(true);
    expect(result.files.filter((f) => f.status === "removed")).toEqual([]);
  });

  test("a custom path WITH owns reconciles correctly and stops warning", async () => {
    const generatorOpts = {
      path: (v: { path: string }, c: string) => `spec/${v.path}__${c}.spec.ts`,
      owns: (rel: string) => rel.startsWith("spec/"),
    };
    const first = await gen({ withDrop: true, generatorOpts });
    expect(first.warnings.some((w) => w.includes("without a matching 'owns'"))).toBe(false);

    const custom = join(OUT_DIR, "spec", "drop__object.entity.spec.ts");
    const result = await gen({ withDrop: false, generatorOpts });

    expect(existsSync(abs(custom))).toBe(false);
    expect(result.files.filter((f) => f.status === "removed").map((f) => f.path)).toEqual([
      abs(custom),
    ]);
  });

  test("a hand-written file the generator never produced is untouched", async () => {
    // Nothing outside gen-state is a candidate: reconciliation reasons only about
    // paths a previous run recorded, never about whatever else is in the tree.
    await gen({ withDrop: true });
    const stray = join(OUT_DIR, "requirements", "hand-written.test.ts");
    writeFileSync(abs(stray), "// mine\n");

    await gen({ withDrop: false });
    expect(existsSync(abs(stray))).toBe(true);
  });
});
