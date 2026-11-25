import { afterAll, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCorpus } from "../src/corpus.js";
import type { ConformanceAdapter } from "../src/adapter.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

// The tree is fixed, so expected.json decides each verdict.
const fake: ConformanceAdapter = {
  language: "fake",
  async loadFixture() { return { tree: {}, errorCodes: [], warnings: [] }; },
  canonicalSerialize() { return '{"ok":true}'; },
  canonicalSerializeEffective() { return '{"ok":true}'; },
  navigate() { return undefined; },
  invoke() { return { scalar: true }; },
};

async function corpus(scenarios: Record<string, Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(process.env.DEV_SCRATCH ?? tmpdir(), "mo-corpus-"));
  dirs.push(root);
  for (const [name, files] of Object.entries(scenarios)) {
    for (const [path, content] of Object.entries({ "input/m.json": "{}", ...files })) {
      const full = join(root, name, path);
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content);
    }
  }
  return root;
}

test("runs every scenario under any root and reports one verdict each", async () => {
  const root = await corpus({
    good: { "expected.json": '{"ok":true}' },
    bad: { "expected.json": '{"ok":false}' },
    gap: { "expected.json": '{"ok":false}' },
  });
  const r = await runCorpus({ corpusRoot: root, adapter: fake, errorCodes: [], ledger: ["gap"] });
  expect(r.fixtures.map((f) => `${f.name}:${f.status}`)).toEqual(["bad:fail", "gap:known-gap", "good:pass"]);
  expect(r.passed).toBe(false);
});

test("a ledger entry that now passes fails the run", async () => {
  const root = await corpus({ fixed: { "expected.json": '{"ok":true}' } });
  const r = await runCorpus({ corpusRoot: root, adapter: fake, errorCodes: [], ledger: ["fixed"] });
  expect(r.fixtures[0]?.status).toBe("fixed-but-listed");
  expect(r.passed).toBe(false);
});

test("requireProviders fails a scenario whose providers.json leaves the provider out", async () => {
  const root = await corpus({
    names: { "expected.json": '{"ok":true}', "providers.json": '["metaobjects-core-types", "metaobjects-demo"]' },
    omits: { "expected.json": '{"ok":true}' },
  });
  const r = await runCorpus({ corpusRoot: root, adapter: fake, errorCodes: [], requireProviders: ["metaobjects-demo"] });
  expect(r.fixtures.map((f) => `${f.name}:${f.status}`)).toEqual(["names:pass", "omits:fail"]);
  expect(r.fixtures[1]?.problems[0]).toContain('providers.json must name "metaobjects-demo"');
});
