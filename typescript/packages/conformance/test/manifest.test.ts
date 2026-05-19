import { test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveManifest } from "../src/manifest.js";
import { discoverFixtures } from "../src/fixture.js";

const dirs: string[] = [];
afterAll(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });

test("manifest is the sorted distinct set of invoked capability-ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "mo-man-"));
  dirs.push(root);
  for (const [name, caps] of [["f1", ["object.own-fields", "field.is-required"]],
                              ["f2", ["object.own-fields"]]] as const) {
    await mkdir(join(root, name, "input"), { recursive: true });
    await writeFile(join(root, name, "input", "m.json"), "{}");
    await writeFile(join(root, name, "script.json"), JSON.stringify({
      operations: caps.map((c) => ({ navigate: [], invoke: c, expect: {} })),
    }));
  }
  const manifest = deriveManifest(await discoverFixtures(root), root);
  expect(manifest.capabilities).toEqual(["field.is-required", "object.own-fields"]);
});
