// Runs the shared source-resolution corpus against the TypeScript reference
// implementation. Every port ships an equivalent runner reading this same file.
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  readonly expectError?: string;
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
        let code: string | undefined;
        try {
          await resolveCollection(resolveDir, { explicitDir: resolveDir });
        } catch (e) {
          code = (e as { code?: string }).code;
        }
        expect(code).toBe(c.expectError);
        return;
      }
      const collection = await resolveCollection(resolveDir, { explicitDir: resolveDir });
      const got = collection.files.map((f) => relative(root, f).split(sep).join("/")).sort();
      expect(got).toEqual([...(c.expectFiles ?? [])].sort());
    });
  }
});
