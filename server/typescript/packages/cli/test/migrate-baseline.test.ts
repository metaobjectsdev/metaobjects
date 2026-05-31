import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, snapshotPath } from "@metaobjectsdev/migrate-ts";
import { runBaseline } from "../src/commands/migrate.js";

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-cli-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.orders.json"),
    JSON.stringify({
      "metadata.root": {
        children: [{
          "object.entity": {
            name: "Order",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "ref" } },
              { "source.rdb": { name: "src", "@table": "orders" } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        }],
      },
    }),
    "utf8",
  );
  return root;
}

afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe("runBaseline --from-metadata", () => {
  test("writes a per-dialect snapshot from metadata, no DB", async () => {
    const root = await project();
    const code = await runBaseline(
      { dialect: "postgres", outDir: "./.metaobjects/migrations", fromDb: false } as any,
      root,
    );
    expect(code).toBe(0);
    const snap = await readSnapshot(snapshotPath(join(root, ".metaobjects/migrations"), "postgres"));
    expect(snap?.tables.map((t) => t.name)).toEqual(["orders"]);
  });
});
