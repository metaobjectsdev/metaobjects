// Runs the shared dependency corpus (FR-023) against the TypeScript reference
// implementation. Every port ships an equivalent runner reading this same file
// (fixtures/dependency-conformance/, see its README for the case schema).
//
// This runner is written AHEAD of the implementation (TDD): the `classify` arm
// is skipped until the classifier lands (Task 14), and the `expectFiles` arm
// already calls `collection.foreignOwner` / `collection.governs` /
// `collection.overrides`, none of which exist on `Collection` yet — those
// calls are expected to fail with a TypeError until later tasks add them.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TYPE_OBJECT } from "@metaobjectsdev/metadata";
import { resolveCollection } from "../src/collection.js";
import { loadMemory } from "../src/memory.js";

interface ClassifyCase {
  readonly old: unknown;
  readonly new: unknown;
  readonly footprint: Record<string, "whole" | "key" | "existence">;
  readonly expectChanges: ReadonlyArray<{
    readonly fqn: string;
    readonly path: string;
    readonly kind: "breaking" | "compatible" | "info";
  }>;
}

interface Case {
  readonly name: string;
  readonly tree: Record<string, string>;
  /** OPTIONAL: project-root-relative path -> a path under this corpus dir
   *  (`artifacts/<file>`), copied byte-for-byte. See the corpus README. */
  readonly treeFiles?: Record<string, string>;
  readonly config: unknown | null;
  /** OPTIONAL: written to `<resolveFrom>/.metaobjects/deps.lock.json`. */
  readonly lock?: unknown;
  /** OPTIONAL: written to `<resolveFrom>/.metaobjects/deps.local.json` (D10). */
  readonly localOverrides?: unknown;
  readonly resolveFrom?: string;
  readonly expectFiles?: readonly string[];
  readonly expectForeign?: readonly string[];
  readonly expectGoverned?: readonly string[];
  readonly expectOverrides?: readonly string[];
  readonly expectLoadError?: string;
  readonly expectErrorFiles?: readonly string[];
  readonly expectError?: string;
  readonly classify?: ClassifyCase;
}

const CORPUS_DIR = resolve(import.meta.dir, "../../../../../fixtures/dependency-conformance");
const CORPUS = join(CORPUS_DIR, "cases.json");

/** Materializes `c.tree` (and `c.treeFiles`, copied byte-for-byte) under a
 *  fresh temp root, then writes `config` / `lock` / `localOverrides` (each
 *  when non-null/present) under `<resolveFrom>/.metaobjects/`. Mirrors
 *  `source-resolution-conformance.test.ts`'s `materialize`, extended for the
 *  dependency-corpus-only fields. */
async function materialize(c: Case): Promise<{ root: string; resolveDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "mo-dep-conf-"));
  for (const [rel, content] of Object.entries(c.tree)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  for (const [rel, corpusRel] of Object.entries(c.treeFiles ?? {})) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await copyFile(join(CORPUS_DIR, corpusRel), abs);
  }
  const resolveDir = resolve(root, c.resolveFrom ?? ".");
  const metaobjectsDir = join(resolveDir, ".metaobjects");
  if (c.config !== null) {
    await mkdir(metaobjectsDir, { recursive: true });
    await writeFile(join(metaobjectsDir, "config.json"), JSON.stringify(c.config, null, 2));
  }
  if (c.lock !== undefined) {
    await mkdir(metaobjectsDir, { recursive: true });
    await writeFile(join(metaobjectsDir, "deps.lock.json"), JSON.stringify(c.lock, null, 2));
  }
  if (c.localOverrides !== undefined) {
    await mkdir(metaobjectsDir, { recursive: true });
    await writeFile(join(metaobjectsDir, "deps.local.json"), JSON.stringify(c.localOverrides, null, 2));
  }
  return { root, resolveDir };
}

const cases: Case[] = JSON.parse(await readFile(CORPUS, "utf8")).cases;

describe("dependency conformance", () => {
  test("corpus is non-empty (a silent zero-case run is a failed gate)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    // The classifier arm has no runner machinery yet (Task 14 fills it in) —
    // skipped rather than failed, so the corpus can carry classify cases
    // ahead of the classifier existing.
    if (c.classify !== undefined) {
      test.skip(c.name, () => {});
      continue;
    }

    test(c.name, async () => {
      const { root, resolveDir } = await materialize(c);

      if (c.expectError !== undefined) {
        await expect(resolveCollection(resolveDir, { explicitDir: resolveDir })).rejects.toMatchObject({
          code: c.expectError,
        });
        return;
      }

      // A case with neither expectFiles, expectError, nor classify is a malformed
      // corpus entry, not "expect zero files" — fail loudly rather than silently
      // passing it (same discipline as source-resolution-conformance).
      if (c.expectFiles === undefined) {
        throw new Error(`corpus case "${c.name}" has neither expectFiles, expectError, nor classify`);
      }

      const collection = await resolveCollection(resolveDir, { explicitDir: resolveDir });
      const got = collection.files.map((f) => relative(root, f).split(sep).join("/")).sort();
      expect(got).toEqual([...c.expectFiles].sort());

      if (c.expectForeign !== undefined) {
        for (const fqn of c.expectForeign) {
          expect(collection.foreignOwner(fqn)).not.toBeUndefined();
        }
      }

      if (c.expectGoverned !== undefined) {
        const loaded = await loadMemory(resolveDir, { files: collection.files });
        const governed = loaded
          .childrenOfType(TYPE_OBJECT)
          .map((n) => n.resolutionKey())
          .filter((fqn) => collection.governs(fqn))
          .sort();
        expect(governed).toEqual([...c.expectGoverned].sort());
      }

      if (c.expectOverrides !== undefined) {
        expect([...collection.overrides].sort()).toEqual([...c.expectOverrides].sort());
      }

      if (c.expectLoadError !== undefined) {
        const attempt = loadMemory(resolveDir, { files: collection.files, fileIds: collection.fileIds });
        await expect(attempt).rejects.toMatchObject({ code: c.expectLoadError });
        if (c.expectErrorFiles !== undefined) {
          let thrown: unknown;
          try {
            await attempt;
          } catch (e) {
            thrown = e;
          }
          expect((thrown as { source?: { files?: readonly string[] } }).source?.files).toEqual(
            c.expectErrorFiles,
          );
        }
      }
    });
  }
});
