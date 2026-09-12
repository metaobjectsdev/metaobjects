// Runs the shared dependency corpus (FR-023) against the TypeScript reference
// implementation. Every port ships an equivalent runner reading this same file
// (fixtures/dependency-conformance/, see its README for the case schema).
//
// The predicates under test are the COMPOSED ones (DESIGN §11.1 item 2):
// `collection.imported` keys on the lock's `packages`, and `inScope` /
// `inMigrateScope` exclude what a dependency owns unless the project's own scope
// NAMES that package.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { TYPE_OBJECT } from "@metaobjectsdev/metadata";
import { resolveCollection, type Collection } from "../src/collection.js";
import { LOCK_FILE } from "../src/dependencies.js";
import { loadMemory, type LoadMemoryOptions } from "../src/memory.js";

/**
 * Everything a resolved collection contributes to a LOAD — the file list, the
 * `dep:<name>/<artifact>` source ids, and the two imported sets the ownership
 * refusal reads.
 *
 * All four, at every load this runner performs, because that is what the ported
 * runners and the CLI's own `collectionLoadOptions` do: a runner that passed
 * `files` alone would load a corpus case differently from the way production
 * loads the same project, and the `expectLoadError` arm would see no refusal to
 * assert.
 */
function loadOptions(collection: Collection): LoadMemoryOptions {
  return {
    files: collection.files,
    fileIds: collection.fileIds,
    importedPackages: collection.importedPackages,
    importedNodes: collection.importedNodes,
  };
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
        const loaded = await loadMemory(resolveDir, loadOptions(collection));
        const topLevel = loaded.childrenOfType(TYPE_OBJECT).map((n) => n.resolutionKey());

        if (c.expectImported !== undefined) {
          const imported = topLevel.filter((fqn) => collection.imported(fqn)).sort();
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
        const attempt = loadMemory(resolveDir, loadOptions(collection));
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
