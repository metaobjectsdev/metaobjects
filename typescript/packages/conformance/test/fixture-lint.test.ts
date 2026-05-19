import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintFixture } from "../src/fixture-lint.js";
import { discoverFixtures } from "../src/fixture.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mo-lint-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, "fix", path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

const errorCodes = ["ERR_UNKNOWN_TYPE", "ERR_DUPLICATE_NAME"];

test("a clean fixture lints with no problems", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"metadata.root":{"children":[{"object.entity":{"name":"X"}}]}}',
    "script.json": JSON.stringify({
      operations: [{ navigate: ["object:X"], invoke: "object.own-fields", expect: {} }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  expect(lintFixture(fix!, errorCodes)).toEqual([]);
});

test("a navigate path absent from expected.json is flagged", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"metadata.root":{"children":[{"object.entity":{"name":"X"}}]}}',
    "script.json": JSON.stringify({
      operations: [{ navigate: ["object:Ghost"], invoke: "object.own-fields", expect: {} }],
    }),
  });
  const [fix] = await discoverFixtures(root);
  expect(lintFixture(fix!, errorCodes).join()).toMatch(/Ghost/);
});

test("an unregistered error code is flagged", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "expected-errors.json": '[{"code":"ERR_NOT_REAL"}]',
  });
  const [fix] = await discoverFixtures(root);
  expect(lintFixture(fix!, errorCodes).join()).toMatch(/ERR_NOT_REAL/);
});

// Fix 3a: bracket segments are valid and must not emit a false "absent node" problem.
test("a bracket segment navigate path lints clean (no false absent-node problem)", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"metadata.root":{"children":[{"object.entity":{"name":"Widget"}}]}}',
    "script.json": JSON.stringify({
      operations: [
        { navigate: ["object:Widget", "identity[primary]"], invoke: "object.own-fields", expect: {} },
      ],
    }),
  });
  const [fix] = await discoverFixtures(root);
  expect(lintFixture(fix!, errorCodes)).toEqual([]);
});

// Fix 3a: a segment that is neither `type:name` nor `type[subType]` is flagged.
test("a malformed navigate segment is flagged", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "expected.json": '{"metadata.root":{"children":[{"object.entity":{"name":"Widget"}}]}}',
    "script.json": JSON.stringify({
      operations: [
        { navigate: ["object:Widget", "not-a-valid-segment"], invoke: "object.own-fields", expect: {} },
      ],
    }),
  });
  const [fix] = await discoverFixtures(root);
  const problems = lintFixture(fix!, errorCodes);
  expect(problems.join()).toMatch(/malformed syntax/);
});

// Fix 1: a malformed expected-errors.json (object instead of array) is flagged.
test("malformed expected-errors.json is reported as a lint problem", async () => {
  const root = await fixture({
    "input/m.json": "{}",
    "expected-errors.json": '{"code":"ERR_UNKNOWN_TYPE"}',
  });
  const [fix] = await discoverFixtures(root);
  const problems = lintFixture(fix!, errorCodes);
  expect(problems.join()).toMatch(/malformed expected-errors\.json/);
});
