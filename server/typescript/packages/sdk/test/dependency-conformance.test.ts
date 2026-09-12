// Runs the shared dependency corpus (FR-023) against the TypeScript reference
// implementation. Every port ships an equivalent runner reading this same file
// (fixtures/dependency-conformance/, see its README for the case schema).
//
// This runner is written AHEAD of the implementation (TDD): `collection.imported`
// does not exist on `Collection` yet (a later task adds the exclusion-key
// composition, DESIGN §11.1 item 2), so any case carrying `expectImported` /
// `expectSelected` / `expectMigrateGoverned` is expected to fail until then.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TYPE_OBJECT } from "@metaobjectsdev/metadata";
import { resolveCollection, type Collection } from "../src/collection.js";
import { LOCK_FILE } from "../src/dependencies.js";
import { loadMemory, type LoadMemoryOptions } from "../src/memory.js";

/**
 * `imported` lands on `Collection` in a later task (DESIGN §11.1 item 2's
 * exclusion-key composition) — this narrow extension lets the corpus runner
 * reference it ahead of the implementation without an `any` escape hatch.
 * Until that task, the runtime object has no such member, so the cast below
 * compiles clean but the call throws (`collection.imported is not a
 * function`) — exactly the failure DESIGN decision #3 (Task 6) expects for
 * the one case that exercises it.
 */
interface CollectionWithImported extends Collection {
  readonly imported: (fqn: string) => boolean;
}

/**
 * `fileIds` (path -> `FileSource` id, carried on `Collection` and threaded
 * through to `loadMemory`) lands ahead of Task 6 in the FR-023 sequence, same
 * ahead-of-implementation situation as `imported` above. Optional here
 * (unlike `imported`) because this corpus's `expectLoadError` arm only wants
 * provenance to flow through WHEN it exists — it does not need the absence to
 * throw.
 */
interface CollectionWithFileIds extends Collection {
  readonly fileIds?: ReadonlyMap<string, string> | undefined;
}
interface LoadMemoryOptionsWithFileIds extends LoadMemoryOptions {
  readonly fileIds?: ReadonlyMap<string, string> | undefined;
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
  readonly resolveFrom?: string;
  readonly expectFiles?: readonly string[];
  /** OPTIONAL, exhaustive over every loaded top-level object: the FQNs for
   *  which `collection.imported(fqn)` is true. */
  readonly expectImported?: readonly string[];
  /** OPTIONAL, exhaustive over every loaded top-level object: the FQNs for
   *  which `collection.inScope(fqn)` is true. */
  readonly expectSelected?: readonly string[];
  /** OPTIONAL, exhaustive over every loaded top-level object: the FQNs
   *  `collection.inMigrateScope` admits (undefined admits everything). */
  readonly expectMigrateGoverned?: readonly string[];
  readonly expectLoadError?: string;
  readonly expectErrorFiles?: readonly string[];
  readonly expectError?: string;
}

const CORPUS_DIR = resolve(import.meta.dir, "../../../../../fixtures/dependency-conformance");
const CORPUS = join(CORPUS_DIR, "cases.json");

/** Materializes `c.tree` (and `c.treeFiles`, copied byte-for-byte) under a
 *  fresh temp root, then writes `config` / `lock` (each when non-null/present)
 *  under `<resolveFrom>/.metaobjects/`. Mirrors
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
    await writeFile(join(metaobjectsDir, LOCK_FILE), JSON.stringify(c.lock, null, 2));
  }
  return { root, resolveDir };
}

const cases: Case[] = JSON.parse(await readFile(CORPUS, "utf8")).cases;

describe("dependency conformance", () => {
  test("corpus is non-empty (a silent zero-case run is a failed gate)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, async () => {
      const { root, resolveDir } = await materialize(c);

      if (c.expectError !== undefined) {
        await expect(resolveCollection(resolveDir, { explicitDir: resolveDir })).rejects.toMatchObject({
          code: c.expectError,
        });
        return;
      }

      // A case with neither expectFiles nor expectError is a malformed corpus
      // entry, not "expect zero files" — fail loudly rather than silently
      // passing it (same discipline as source-resolution-conformance).
      if (c.expectFiles === undefined) {
        throw new Error(`corpus case "${c.name}" has neither expectFiles nor expectError`);
      }

      const collection = await resolveCollection(resolveDir, { explicitDir: resolveDir });
      const got = collection.files.map((f) => relative(root, f).split(sep).join("/")).sort();
      expect(got).toEqual([...c.expectFiles].sort());

      if (
        c.expectImported !== undefined ||
        c.expectSelected !== undefined ||
        c.expectMigrateGoverned !== undefined
      ) {
        const loaded = await loadMemory(resolveDir, { files: collection.files });
        const topLevel = loaded.childrenOfType(TYPE_OBJECT).map((n) => n.resolutionKey());

        if (c.expectImported !== undefined) {
          const withImported = collection as CollectionWithImported;
          const imported = topLevel.filter((fqn) => withImported.imported(fqn)).sort();
          expect(imported).toEqual([...c.expectImported].sort());
        }
        if (c.expectSelected !== undefined) {
          const selected = topLevel.filter((fqn) => collection.inScope(fqn)).sort();
          expect(selected).toEqual([...c.expectSelected].sort());
        }
        if (c.expectMigrateGoverned !== undefined) {
          const migrateGoverned = topLevel
            .filter((fqn) => collection.inMigrateScope?.(fqn) ?? true)
            .sort();
          expect(migrateGoverned).toEqual([...c.expectMigrateGoverned].sort());
        }
      }

      if (c.expectLoadError !== undefined) {
        const options: LoadMemoryOptionsWithFileIds = {
          files: collection.files,
          fileIds: (collection as CollectionWithFileIds).fileIds,
        };
        const attempt = loadMemory(resolveDir, options);
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
