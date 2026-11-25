// Runs the shared reference-source corpus (fixtures/reference-source-conformance/)
// against the TypeScript reference implementation. Every port ships an equivalent
// runner reading this same file; see its README for the case schema.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadMemory } from "../src/memory.js";

interface Case {
  readonly name: string;
  readonly tree: Record<string, string>;
  readonly config: unknown;
  readonly expectReference?: readonly string[];
  readonly expectLoadError?: string;
}

const CORPUS = resolve(import.meta.dir, "../../../../../fixtures/reference-source-conformance/cases.json");
const cases = (JSON.parse(await readFile(CORPUS, "utf8")) as { cases: Case[] }).cases;
const scratch = await mkdtemp(join(process.env["DEV_SCRATCH"] ?? tmpdir(), "mo-ref-src-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function materialize(c: Case): Promise<string> {
  const root = join(scratch, c.name);
  for (const [rel, content] of Object.entries(c.tree)) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  await mkdir(join(root, ".metaobjects"), { recursive: true });
  await writeFile(join(root, ".metaobjects", "config.json"), JSON.stringify(c.config));
  return root;
}

describe("reference-source-conformance", () => {
  test("the corpus is not empty", () => {
    expect(cases.length).toBeGreaterThan(0);
  });

  for (const c of cases) {
    test(c.name, async () => {
      const root = await materialize(c);
      // The project-aware arm: loadMemory resolves the collection itself, reference ids included.
      const load = loadMemory(root);
      if (c.expectLoadError !== undefined) {
        await expect(load).rejects.toMatchObject({ code: c.expectLoadError });
        return;
      }
      const loaded = await load;
      expect([...loaded.referenceNodes].sort()).toEqual([...(c.expectReference ?? [])].sort());
    });
  }
});
