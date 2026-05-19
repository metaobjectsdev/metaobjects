import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverFixtures } from "../src/fixture.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

async function corpus(layout: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mo-corpus-"));
  dirs.push(root);
  for (const [path, content] of Object.entries(layout)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content);
  }
  return root;
}

test("discovers a behavioral-only scenario", async () => {
  const root = await corpus({
    "loader-basic/input/meta.json": "{}",
    "loader-basic/expected.json": "{}",
  });
  const fixtures = await discoverFixtures(root);
  expect(fixtures.map((f) => f.name)).toEqual(["loader-basic"]);
  expect(fixtures[0]!.hasExpected).toBe(true);
  expect(fixtures[0]!.hasScript).toBe(false);
});

test("discovers a scenario with a script and reports its providers", async () => {
  const root = await corpus({
    "api-fields/input/meta.json": "{}",
    "api-fields/script.json": '{"operations":[]}',
    "api-fields/providers.json": '["metaobjects-core-types","geo-types"]',
  });
  const fixtures = await discoverFixtures(root);
  expect(fixtures[0]!.hasScript).toBe(true);
  expect(fixtures[0]!.providers).toEqual(["metaobjects-core-types", "geo-types"]);
});

test("a scenario with no input directory is a discovery error", async () => {
  const root = await corpus({ "broken/expected.json": "{}" });
  await expect(discoverFixtures(root)).rejects.toThrow(/input/);
});

test("fixtures are returned sorted by name", async () => {
  const root = await corpus({
    "b-fix/input/m.json": "{}", "a-fix/input/m.json": "{}",
  });
  const fixtures = await discoverFixtures(root);
  expect(fixtures.map((f) => f.name)).toEqual(["a-fix", "b-fix"]);
});
