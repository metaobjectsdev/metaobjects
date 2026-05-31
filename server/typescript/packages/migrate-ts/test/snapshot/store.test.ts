// test/snapshot/store.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { serializeSnapshot, parseSnapshot } from "../../src/snapshot/serialize.js";
import { snapshotPath, readSnapshot, writeSnapshot } from "../../src/snapshot/store.js";

const META = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadJson(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

const tmpDirs: string[] = [];
async function makeDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mts-snap-"));
  tmpDirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

describe("snapshot store", () => {
  test("snapshotPath names the file per dialect, with d1 sharing sqlite", () => {
    expect(snapshotPath("/m", "postgres").endsWith(".schema.postgres.json")).toBe(true);
    expect(snapshotPath("/m", "sqlite").endsWith(".schema.sqlite.json")).toBe(true);
    expect(snapshotPath("/m", "d1").endsWith(".schema.sqlite.json")).toBe(true);
  });

  test("readSnapshot returns null when the file does not exist", async () => {
    const dir = await makeDir();
    expect(await readSnapshot(snapshotPath(dir, "postgres"))).toBeNull();
  });

  test("write then read round-trips the snapshot", async () => {
    const dir = await makeDir();
    const path = snapshotPath(dir, "postgres");
    const snap = buildExpectedSchema(await loadJson(META), { dialect: "postgres" });
    await writeSnapshot(path, snap);
    expect(await readSnapshot(path)).toEqual(parseSnapshot(serializeSnapshot(snap)));
  });

  test("writeSnapshot creates a missing parent directory", async () => {
    const dir = await makeDir();
    const path = snapshotPath(join(dir, "nested", "deeper"), "postgres");
    const snap = buildExpectedSchema(await loadJson(META), { dialect: "postgres" });
    await writeSnapshot(path, snap);
    expect(await readSnapshot(path)).toEqual(parseSnapshot(serializeSnapshot(snap)));
  });
});
