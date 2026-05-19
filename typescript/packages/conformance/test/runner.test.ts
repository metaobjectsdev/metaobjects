import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixture } from "../src/runner.js";
import { discoverFixtures } from "../src/fixture.js";
import type { ConformanceAdapter } from "../src/adapter.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

// A fake adapter: the tree is the parsed input; serialization is JSON.stringify.
const fake: ConformanceAdapter = {
  language: "fake",
  async loadFixture() { return { tree: { ok: true }, errorCodes: [] }; },
  canonicalSerialize() { return '{"ok":true}'; },
  canonicalSerializeEffective() { return '{"ok":true}'; },
  navigate() { return { node: true }; },
  invoke() { return { scalar: true }; },
};

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mo-run-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, "fix", path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test("a matching expected.json check passes", async () => {
  const root = await fixture({ "input/m.json": "{}", "expected.json": '{"ok":true}' });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("pass");
  expect(report.checks[0]!.passed).toBe(true);
});

test("a mismatching expected.json check fails", async () => {
  const root = await fixture({ "input/m.json": "{}", "expected.json": '{"ok":false}' });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("fail");
});

test("an operation check compares the normalized result", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "script.json": JSON.stringify({
      operations: [{ navigate: ["object:X"], invoke: "x.y", expect: { scalar: true } }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const report = await runFixture(fix!, fake);
  expect(report.status).toBe("pass");
  expect(report.capabilities).toEqual(["x.y"]);
});
