// Runs the `expectCheck` arm of the shared dependency corpus (FR-023) against the TypeScript
// reference implementation of `meta deps check` / `verify --deps`: for each declared dependency,
// resolve its `path`, read and validate the manifest, hash the artifact, and compare with the
// lock — `current`, `drifted` or `unresolved`. The check is a pure function of the config, the
// lock and the publisher's directory, so no loader and no snapshot is involved.
//
// Every port that gains a check runs THIS arm over the same file
// (fixtures/dependency-conformance/, see its README); the resolution arm is run by
// `sdk/test/dependency-conformance.test.ts`.
import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_METAOBJECTS_DIR, LOCK_FILE, loadConfig } from "@metaobjectsdev/sdk";
import { checkDependencies, readLockOrThrow } from "../src/lib/dependency-sync.js";

interface Case {
  readonly name: string;
  readonly tree: Record<string, string>;
  readonly treeFiles?: Record<string, string>;
  readonly config: unknown;
  readonly lock?: unknown;
  readonly resolveFrom?: string;
  readonly expectCheck?: Record<string, "current" | "drifted" | "unresolved">;
}

const CORPUS_DIR = resolve(import.meta.dir, "../../../../../fixtures/dependency-conformance");

async function materialize(c: Case): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mo-dep-check-"));
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
  const metaobjectsDir = join(resolveDir, DEFAULT_METAOBJECTS_DIR);
  await mkdir(metaobjectsDir, { recursive: true });
  await writeFile(join(metaobjectsDir, "config.json"), JSON.stringify(c.config, null, 2));
  if (c.lock !== undefined) await writeFile(join(metaobjectsDir, LOCK_FILE), JSON.stringify(c.lock, null, 2));
  return resolveDir;
}

const checkCases: Case[] = (JSON.parse(await readFile(join(CORPUS_DIR, "cases.json"), "utf8")).cases as Case[]).filter(
  (c) => c.expectCheck !== undefined,
);

describe("dependency conformance — the check arm", () => {
  test("the corpus carries check cases (a silent zero-case run is a failed gate)", () => {
    expect(checkCases.length).toBeGreaterThan(0);
  });

  for (const c of checkCases) {
    test(c.name, async () => {
      const dir = await materialize(c);
      const cfg = await loadConfig(join(dir, DEFAULT_METAOBJECTS_DIR));
      const results = await checkDependencies(dir, cfg.dependencies, await readLockOrThrow(dir));
      const got = Object.fromEntries(results.map((r) => [r.name, r.status]));
      expect(got).toEqual(c.expectCheck!);
    });
  }
});
