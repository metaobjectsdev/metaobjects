// docsSiteFile() builds the model explorer by default: explorer.json from the effective model,
// the requirement ledger the caller hands the run, the files the run wrote and the routes it
// mounts. It runs after the generators declared beside it, whatever their order.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetaDataLoader, type MetaRoot } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import type { Generator } from "../src/generator.js";
import { docsSiteFile, entityFile, routesFile } from "../src/generators/index.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

interface ExplorerShape {
  generated?: { node: string; files: { path: string; generatedBy: string }[] }[];
  api?: { node: string; method: string; path: string }[];
  ledger?: unknown;
}

let tmp: string;
let root: MetaRoot;
// The run's one metadata source directory (the classic site loads whole directories).
let sources: string;
beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "codegen-docs-site-"));
  sources = join(tmp, "metaobjects");
  mkdirSync(sources);
  copyFileSync(FIXTURE, join(sources, "meta.blog.json"));
  root = (await new MetaDataLoader().load([new FileSource(FIXTURE)])).root;
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const config = (generators: Generator[]) =>
  defineConfig({
    outDir: join(tmp, "src"),
    extStyle: "none",
    dbImport: "../db",
    dialect: "sqlite",
    apiPrefix: "/api",
    targets: { docs: { outDir: join(tmp, "docs") } },
    generators,
  });

const explorerOf = (): ExplorerShape =>
  JSON.parse(readFileSync(join(tmp, "docs", "site", "explorer.json"), "utf8")) as ExplorerShape;

describe("docsSiteFile() builds the model explorer", () => {
  test("declared first, it still sees what the code generators wrote, and the routes they mount", async () => {
    await runGen({
      config: config([docsSiteFile(), entityFile(), routesFile()]),
      metadata: root,
      projectRoot: tmp,
      sourceRoots: [sources],
    });
    expect(existsSync(join(tmp, "docs", "site", "index.html"))).toBe(true);
    const ex = explorerOf();
    const post = ex.generated?.find((g) => g.node.endsWith("Post"));
    expect(post?.files.map((f) => f.generatedBy)).toEqual(expect.arrayContaining(["entity-file", "routes-file"]));
    expect(ex.api?.some((r) => r.node.endsWith("Post") && r.method === "GET" && r.path.startsWith("/api/"))).toBe(true);
    expect(readFileSync(join(tmp, "docs", "site", "api.html"), "utf8")).toContain("/api/");
  });

  test("without a routes generator in the run, no route is listed", async () => {
    await runGen({ config: config([entityFile(), docsSiteFile()]), metadata: root, projectRoot: tmp, sourceRoots: [sources] });
    expect(explorerOf().api ?? []).toEqual([]);
  });

  test("the requirement ledger comes from the caller, asked for once", async () => {
    let calls = 0;
    await runGen({
      config: config([docsSiteFile()]),
      metadata: root,
      projectRoot: tmp,
      sourceRoots: [sources],
      requirementLedger: () => {
        calls += 1;
        return { requirementLedger: [], requirementCounts: { total: 0 }, requirements: { rows: [] } };
      },
    });
    expect(calls).toBe(1);
    expect(explorerOf().ledger).toBeDefined();
  });

  test("site: \"classic\" builds the earlier site and no explorer.json", async () => {
    await runGen({ config: config([docsSiteFile({ site: "classic" })]), metadata: root, projectRoot: tmp, sourceRoots: [sources] });
    expect(existsSync(join(tmp, "docs", "site", "assets", "site.css"))).toBe(true);
    expect(existsSync(join(tmp, "docs", "site", "explorer.json"))).toBe(false);
  });
});
