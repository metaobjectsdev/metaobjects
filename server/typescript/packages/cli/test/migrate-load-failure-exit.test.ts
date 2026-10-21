// docs/features/cli.md: every command exits 1 on a metadata load failure (2 is a usage error).
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";
import { run } from "../src/index.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

async function brokenProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-loadfail-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.orders.json"), "{ not json", "utf8");
  return root;
}
const cfg = () =>
  ({ dialect: "sqlite", outDir: "./.metaobjects/migrations", onAmbiguous: "abort", allow: [], slug: "auto", dryRun: false } as any);

describe("meta migrate on metadata that does not load", () => {
  test("offline generate exits 1", async () => {
    expect(await runOfflineGenerate(cfg(), await brokenProject())).toBe(1);
  });
  test("baseline exits 1", async () => {
    expect(await runBaseline(cfg(), await brokenProject())).toBe(1);
  });
  test("the CLI entry exits 1 (offline and --db)", async () => {
    const root = await brokenProject();
    expect(await run(["migrate", "--dialect", "sqlite", "--cwd", root])).toBe(1);
    expect(await run(["migrate", "--dialect", "sqlite", "--db", `file:${join(root, "x.sqlite")}`, "--cwd", root])).toBe(1);
  });
});
