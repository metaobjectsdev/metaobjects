// The point of ADR-0064 Amendment 1, proven with real git: two branches that change generated
// files in DIFFERENT packages produce manifests that merge with nothing to resolve. With the
// single `.hashes.json` the same two branches conflict on that one file.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import { perEntity, perModel, type Generator } from "../src/generator.js";
import { makeScratchDir, removeTree } from "../src/scratch-dir.js";

let tmp: string;
beforeEach(() => { tmp = makeScratchDir("manifest-merge-"); });
afterEach(() => { removeTree(tmp); });

const entity = (pkg: string, name: string): string => JSON.stringify({
  "metadata.root": { package: pkg, children: [{ "object.entity": { name, children: [
    { "source.rdb": { "@table": name.toLowerCase() } },
    { "field.long": { name: "id" } },
    { "identity.primary": { name: "primary", "@fields": ["id"], "@generation": "increment" } },
  ] } }] },
});

const git = (...args: string[]): { status: number; out: string } => {
  const r = spawnSync("git", ["-C", tmp, ...args], { encoding: "utf-8" });
  return { status: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
};

/** Run `meta gen` for the project, with each entity's output taken from `bodies`. */
async function gen(bodies: Record<string, string>): Promise<void> {
  mkdirSync(join(tmp, "metaobjects"), { recursive: true });
  writeFileSync(join(tmp, "metaobjects", "shop.json"), entity("acme::shop", "Order"));
  writeFileSync(join(tmp, "metaobjects", "crm.json"), entity("acme::crm", "Customer"));
  const loader = new MetaDataLoader();
  const { root } = await loader.load([
    new FileSource(join(tmp, "metaobjects", "shop.json")),
    new FileSource(join(tmp, "metaobjects", "crm.json")),
  ]);
  const own: Generator = { name: "own", generate: perEntity((e) => ({ path: `${e.name}.ts`, content: bodies[e.name] ?? "// base\n" })) };
  const barrel: Generator = { name: "barrel", generate: perModel(() => ({ path: "index.ts", content: "// index\n" })) };
  await runGen({
    config: defineConfig({ outDir: join(tmp, "gen"), extStyle: "none", dbImport: "../db", dialect: "sqlite", generators: [own, barrel] }),
    metadata: root,
    projectRoot: tmp,
  });
}

describe("two branches, two packages", () => {
  test("the manifests merge with no conflict", async () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    await gen({});
    const manifestDir = join(tmp, ".metaobjects", ".gen-state", ".hashes");
    expect(existsSync(join(manifestDir, "acme.shop.json"))).toBe(true);
    expect(existsSync(join(manifestDir, "acme.crm.json"))).toBe(true);
    // Nothing else under .gen-state is committed in a real project; mimic its .gitignore.
    writeFileSync(join(tmp, ".metaobjects", ".gitignore"), ".gen-state/*\n!.gen-state/.hashes/\n");
    git("add", "-A");
    expect(git("commit", "-q", "-m", "base").status).toBe(0);
    expect(git("ls-files", ".metaobjects/.gen-state").out).toContain(".hashes/acme.shop.json");

    git("checkout", "-q", "-b", "orders");
    await gen({ Order: "// orders changed\n" });
    git("add", "-A");
    expect(git("commit", "-q", "-m", "orders").status).toBe(0);

    git("checkout", "-q", "main");
    git("checkout", "-q", "-b", "customers");
    await gen({ Customer: "// customers changed\n" });
    git("add", "-A");
    expect(git("commit", "-q", "-m", "customers").status).toBe(0);

    const merged = git("merge", "--no-edit", "orders");
    expect(merged.out).not.toContain("CONFLICT");
    expect(merged.status).toBe(0);

    // The merged manifests record both changes, and match what a fresh run produces.
    const shop = JSON.parse(readFileSync(join(manifestDir, "acme.shop.json"), "utf-8")) as Record<string, string>;
    const crm = JSON.parse(readFileSync(join(manifestDir, "acme.crm.json"), "utf-8")) as Record<string, string>;
    expect(Object.keys(shop)).toEqual(["gen/Order.ts"]);
    expect(Object.keys(crm)).toEqual(["gen/Customer.ts"]);
    const rootBefore = readFileSync(join(manifestDir, ".root.json"), "utf-8");
    await gen({ Order: "// orders changed\n", Customer: "// customers changed\n" });
    const rerun = git("status", "--porcelain");
    expect(rerun.out.trim()).toBe("");
    expect(readFileSync(join(manifestDir, ".root.json"), "utf-8")).toBe(rootBefore);
  }, 60_000);

  test("the same two branches conflict on the single legacy manifest", () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("config", "commit.gpgsign", "false");
    const file = join(tmp, "hashes.json");
    const write = (o: string, c: string): void => writeFileSync(file, JSON.stringify({
      "gen/Customer.ts": c, "gen/Order.ts": o,
    }, null, 2) + "\n");
    write("o0", "c0");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    git("checkout", "-q", "-b", "a"); write("o1", "c0"); git("commit", "-qam", "a");
    git("checkout", "-q", "main"); git("checkout", "-q", "-b", "b"); write("o0", "c1"); git("commit", "-qam", "b");
    // Adjacent lines of one file: git cannot tell they are independent.
    expect(git("merge", "--no-edit", "a").out).toContain("CONFLICT");
  });
});
