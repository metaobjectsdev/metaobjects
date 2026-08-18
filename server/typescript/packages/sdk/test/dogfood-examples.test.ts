// server/typescript/packages/sdk/test/dogfood-examples.test.ts
//
// Dogfoods `resolveCollection` (reach) + `matchesScope` (scope) against a
// real metadata tree already committed in this repo — zero new metadata
// authored. Three angles, per the task-13 addendum:
//   1. a synthetic consumer elsewhere in a repo reaching the examples tree
//      via an absolute-path `sources` entry (the general cross-tree case);
//   2. the examples project's OWN committed config, whose `sources: []` is
//      the exact shape every `meta init` scaffold produces — nothing else on
//      this branch pins that empty-array-falls-back-to-metaobjects/ path
//      against a real committed config;
//   3. scope patterns evaluated over the FQNs the loader actually produced
//      for that tree, not string literals invented for the test.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolveCollection } from "../src/collection.js";
import { DEFAULT_METADATA_DIR, listMetadataFiles, loadMemory } from "../src/memory.js";
import { compileScope, matchesScope } from "../src/scope.js";

// Located relative to this test file (never a hardcoded absolute home path —
// this repo is public) so the test runs unchanged on any checkout.
const EXAMPLES_PROJECT = resolve(import.meta.dir, "../../../../../examples/advanced-modeling");
// `DEFAULT_METADATA_DIR`, not the literal: this file dogfoods the rule that no
// call site may assume that directory name, so it must not assume it either.
const EXAMPLES = join(EXAMPLES_PROJECT, DEFAULT_METADATA_DIR);

// The tree holds exactly these three files today (verified at HEAD by the
// controller before dispatching this task) — asserted as a floor ("contains
// all three"), never as an exact `length`, since the example tree is
// documentation and may legitimately grow.
const KNOWN_BASENAMES = ["meta.catalog.yaml", "meta.content.yaml", "meta.prompts.yaml"];

/** Shared shape for both dogfood file-set assertions (F22): every resolved
 *  path sits under `under`, the known files are all present, and the order is
 *  exactly the walk order the toolchain has always used — asserted by calling
 *  `listMetadataFiles` on the same tree rather than restating a rule, so a
 *  consumer reaching this collection from elsewhere gets byte-identical
 *  generated output to a consumer sitting on top of it. */
async function assertKnownFileSet(files: readonly string[], under: string): Promise<void> {
  expect(files.every((f) => f.startsWith(under))).toBe(true);
  const names = files.map((f) => basename(f));
  for (const known of KNOWN_BASENAMES) expect(names).toContain(known);
  expect([...files]).toEqual(await listMetadataFiles(under));
}

describe("dogfood: a consumer reaches the in-repo examples tree", () => {
  let consumer: string;
  beforeEach(() => {
    consumer = mkdtempSync(join(tmpdir(), "metaobjects-dogfood-"));
    mkdirSync(join(consumer, ".git"));
    mkdirSync(join(consumer, "apps/ui/.metaobjects"), { recursive: true });
    writeFileSync(
      join(consumer, "apps/ui/.metaobjects/config.json"),
      JSON.stringify({ schema_version: 1, sources: [{ path: EXAMPLES }] }),
      "utf8",
    );
  });
  afterEach(() => {
    rmSync(consumer, { recursive: true, force: true });
  });

  test("resolves every metadata file in it", async () => {
    const c = await resolveCollection(join(consumer, "apps/ui"));
    await assertKnownFileSet(c.files, EXAMPLES);
  });

  test("the resolved set loads without errors", async () => {
    const c = await resolveCollection(join(consumer, "apps/ui"));
    const root = await loadMemory(c.configDir, { files: c.files });
    expect(root.children().length).toBeGreaterThan(0);
  });
});

describe("dogfood: the examples project's own committed config (sources: [])", () => {
  test("falls back to metaobjects/ under the project root, exactly like every adopter's default config", async () => {
    const c = await resolveCollection(EXAMPLES_PROJECT);
    expect(c.configDir).toBe(EXAMPLES_PROJECT);
    await assertKnownFileSet(c.files, EXAMPLES);
  });
});

describe("dogfood: scope evaluated over real loaded FQNs", () => {
  test("acme::learn::** matches every loaded object; acme::* (one segment) matches none; excluding Program* narrows without emptying", async () => {
    const c = await resolveCollection(EXAMPLES_PROJECT);
    const root = await loadMemory(c.configDir, { files: c.files });
    // Derived from the loaded root, not a hardcoded object-name list — this
    // must keep working the moment someone edits the example tree.
    const fqns = root.children().map((child) => child.resolutionKey());
    expect(fqns.length).toBeGreaterThan(0);

    const broad = compileScope({ include: ["acme::learn::**"] });
    expect(fqns.every((f) => matchesScope(f, broad))).toBe(true);

    // The discriminating case: `*` never crosses `::`, and every object here
    // sits two segments below `acme` — a port that treated `*` as "any
    // characters" would pass the assertion above and fail this one.
    const tooNarrow = compileScope({ include: ["acme::*"] });
    expect(fqns.every((f) => !matchesScope(f, tooNarrow))).toBe(true);

    const excludingProgram = compileScope({
      include: ["acme::learn::**"],
      exclude: ["acme::learn::Program*"],
    });
    const actualIncluded = fqns.filter((f) => matchesScope(f, excludingProgram));
    const actualExcluded = fqns.filter((f) => !matchesScope(f, excludingProgram));

    // Expected sets computed from the same FQN list (never a hardcoded name
    // list), by the same rule the pattern encodes: the last `::`-segment
    // starts with "Program".
    const expectedExcluded = fqns.filter((f) => f.split("::").at(-1)!.startsWith("Program"));
    const expectedIncluded = fqns.filter((f) => !f.split("::").at(-1)!.startsWith("Program"));
    expect([...actualExcluded].sort()).toEqual([...expectedExcluded].sort());
    expect([...actualIncluded].sort()).toEqual([...expectedIncluded].sort());

    // Non-vacuous on both sides of the exclude — the example tree does carry
    // Program-prefixed and non-Program-prefixed objects today.
    expect(expectedExcluded.length).toBeGreaterThan(0);
    expect(expectedIncluded.length).toBeGreaterThan(0);
  });
});
