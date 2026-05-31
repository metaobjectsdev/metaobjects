import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";

const dirs: string[] = [];
const ENTITY = (fields: string) => ({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "Order",
        children: [
          { "field.long": { name: "id" } },
          ...JSON.parse(fields),
          { "source.rdb": { name: "src", "@table": "orders" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
        ],
      },
    }],
  },
});

async function project(fields: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-gen-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.orders.json"), JSON.stringify(ENTITY(fields)), "utf8");
  return root;
}
async function rewrite(root: string, fields: string): Promise<void> {
  await writeFile(join(root, "metaobjects", "meta.orders.json"), JSON.stringify(ENTITY(fields)), "utf8");
}

afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const cfg = (root: string) =>
  ({ dialect: "sqlite", outDir: "./.metaobjects/migrations", onAmbiguous: "abort", allow: [], slug: "auto", dryRun: false } as any);

describe("runOfflineGenerate", () => {
  test("errors when no baseline snapshot exists", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    expect(await runOfflineGenerate(cfg(root), root)).toBe(2);
  });

  test("no changes right after baseline", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    await runBaseline(cfg(root), root);
    expect(await runOfflineGenerate(cfg(root), root)).toBe(0);
    // baseline writes only the snapshot, no migration dir
    const entries = await readdir(join(root, ".metaobjects/migrations"));
    expect(entries.filter((e) => !e.startsWith("."))).toHaveLength(0);
  });

  test("emits a migration when a field is added — offline, no DB", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    await runBaseline(cfg(root), root);
    await rewrite(root, '[{"field.string":{"name":"ref"}},{"field.string":{"name":"note"}}]');
    expect(await runOfflineGenerate(cfg(root), root)).toBe(0);
    const entries = (await readdir(join(root, ".metaobjects/migrations"))).filter((e) => !e.startsWith("."));
    expect(entries).toHaveLength(1);
    // snapshot advanced: a second generate sees no changes
    expect(await runOfflineGenerate(cfg(root), root)).toBe(0);
    const after = (await readdir(join(root, ".metaobjects/migrations"))).filter((e) => !e.startsWith("."));
    expect(after).toHaveLength(1);
  });
});
