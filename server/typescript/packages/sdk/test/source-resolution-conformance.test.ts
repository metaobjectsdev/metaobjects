// Runs the shared source-resolution corpus against the TypeScript reference
// implementation. Every port ships an equivalent runner reading this same file.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { resolveCollection } from "../src/collection.js";

interface Case {
  readonly name: string;
  readonly tree: Record<string, string>;
  readonly config: unknown | null;
  /** Project-root-relative directory the resolver is invoked against; default
   *  ".". `config` (when non-null) is written under this directory's
   *  `.metaobjects/config.json`. See the corpus README, "Shape". */
  readonly resolveFrom?: string;
  readonly expectFiles?: readonly string[];
  /** A string pins the exact error code raised; `true` pins only that
   *  resolution RAISES — the malformed-config error code is deliberately not
   *  pinned cross-port (see the corpus README). */
  readonly expectError?: string | true;
  /** Optional: linkPath -> targetPath, both project-root-relative, materialized
   *  AFTER `tree` (I1 — a symlinked source root, or a symlinked subdirectory
   *  inside a walked tree). */
  readonly symlinks?: Record<string, string>;
}

const CORPUS = resolve(
  import.meta.dir,
  "../../../../../fixtures/source-resolution-conformance/cases.json",
);

/** Materializes `c.tree` under a fresh temp root and, when `c.config` is
 *  non-null, writes it to `<resolveDir>/.metaobjects/config.json`. Returns
 *  both the project root (`expectFiles` is relative to this) and the
 *  directory the resolver should be invoked against (`resolveFrom`-relative
 *  to the root, defaulting to the root itself). */
async function materialize(c: Case): Promise<{ root: string; resolveDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "mo-src-conf-"));
  for (const [rel, content] of Object.entries(c.tree)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  // Materialized AFTER tree — see the Case.symlinks doc.
  for (const [linkRel, targetRel] of Object.entries(c.symlinks ?? {})) {
    const linkAbs = join(root, linkRel);
    await mkdir(dirname(linkAbs), { recursive: true });
    await symlink(join(root, targetRel), linkAbs, "dir");
  }
  const resolveDir = resolve(root, c.resolveFrom ?? ".");
  if (c.config !== null) {
    await mkdir(join(resolveDir, ".metaobjects"), { recursive: true });
    await writeFile(
      join(resolveDir, ".metaobjects", "config.json"),
      JSON.stringify(c.config, null, 2),
    );
  }
  return { root, resolveDir };
}

const cases: Case[] = JSON.parse(await readFile(CORPUS, "utf8")).cases;

describe("source-resolution conformance", () => {
  test("corpus is non-empty (a silent zero-case run is a failed gate)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, async () => {
      const { root, resolveDir } = await materialize(c);
      if (c.expectError !== undefined) {
        let thrown: unknown;
        let threw = false;
        try {
          await resolveCollection(resolveDir, { explicitDir: resolveDir });
        } catch (e) {
          threw = true;
          thrown = e;
        }
        expect(threw).toBe(true);
        // A string pins the exact code; `true` only pins that it raises — see
        // the `expectError` type doc above.
        if (typeof c.expectError === "string") {
          expect((thrown as { code?: string }).code).toBe(c.expectError);
        }
        return;
      }
      // A case with neither `expectFiles` nor `expectError` is a malformed corpus
      // entry, not "expect zero files" — `?? []` here would silently pass such a
      // case instead of failing loudly on it (this is the TS-runner-specific half
      // of the "assert count, not just presence" family of fixes; see the C#/Java/
      // Python runners' analogous length assertions below the set comparison).
      if (c.expectFiles === undefined) {
        throw new Error(`corpus case "${c.name}" has neither expectFiles nor expectError`);
      }
      const collection = await resolveCollection(resolveDir, { explicitDir: resolveDir });
      const got = collection.files.map((f) => relative(root, f).split(sep).join("/")).sort();
      expect(got).toEqual([...c.expectFiles].sort());
    });
  }
});
