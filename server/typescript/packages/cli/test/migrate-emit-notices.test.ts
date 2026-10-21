// The emitter's notices (EmitResult.notices) reach `meta migrate` output, dry run and write.
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const model = (viewFields: string[]) => ({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Thing",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "name" } },
            { "field.string": { name: "note" } },
            { "source.rdb": { name: "src", "@table": "things" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.projection": {
          name: "ThingView",
          children: [
            { "source.rdb": { "@kind": "view", "@table": "v_things" } },
            { "field.long": { name: "id", extends: "Thing.id" } },
            { "identity.primary": { name: "pk", extends: "Thing.pk" } },
            ...viewFields.map((f) => ({ "field.string": { name: f, extends: `Thing.${f}` } })),
          ],
        },
      },
    ],
  },
});

async function write(root: string, viewFields: string[]): Promise<void> {
  await writeFile(join(root, "metaobjects", "meta.things.json"), JSON.stringify(model(viewFields)), "utf8");
}

const cfg = (dryRun: boolean) =>
  ({ dialect: "postgres", outDir: "./.metaobjects/migrations", onAmbiguous: "abort", allow: [], slug: "recreate", dryRun } as any);

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const oe = console.error, ol = console.log;
  console.error = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try { await fn(); } finally { console.error = oe; console.log = ol; }
  return lines.join("\n");
}

describe("meta migrate prints the emitter's notices", () => {
  for (const dryRun of [true, false]) {
    test(`offline ${dryRun ? "dry run" : "write"} says the recreated view's grants are carried over`, async () => {
      const root = await mkdtemp(join(tmpdir(), "mts-notice-"));
      dirs.push(root);
      await mkdir(join(root, "metaobjects"), { recursive: true });
      await write(root, ["name"]);
      await runBaseline(cfg(false), root);
      await write(root, ["note"]);
      const out = await capture(() => runOfflineGenerate(cfg(dryRun), root));
      expect(out).toContain("dropped and recreated; its grants are carried over");
    });
  }
});
