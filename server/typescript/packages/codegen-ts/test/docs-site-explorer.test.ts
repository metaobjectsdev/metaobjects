// docsSiteFile() builds the model explorer by default: explorer.json (the docs view,
// docs/features/docs-view.md) from the loaded model, the requirement ledger the caller hands
// the run, the files the run wrote and the routes it mounts. It runs after the generators declared beside it, whatever their order.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { MetaDataLoader, type DocsView, type MetaRoot } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import { runGen } from "../src/runner.js";
import { defineConfig } from "../src/metaobjects-config.js";
import type { Generator } from "../src/generator.js";
import { docsSiteFile, entityFile, routesFile } from "../src/generators/index.js";
import { makeScratchDir, removeTree } from "../src/scratch-dir.js";

const FIXTURE = resolve(import.meta.dir, "fixtures", "single-entity.json");

let tmp: string;
let root: MetaRoot;
// The run's one metadata source directory (the classic site loads whole directories).
let sources: string;
beforeEach(async () => {
  tmp = makeScratchDir("codegen-docs-site-");
  sources = join(tmp, "metaobjects");
  mkdirSync(sources);
  copyFileSync(FIXTURE, join(sources, "meta.blog.json"));
  root = (await new MetaDataLoader().load([new FileSource(FIXTURE)])).root;
});
afterEach(() => { removeTree(tmp); });

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

const explorerOf = (): DocsView =>
  JSON.parse(readFileSync(join(tmp, "docs", "site", "explorer.json"), "utf8")) as DocsView;

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
    const post = ex.nodes.find((n) => n.id.endsWith("Post"));
    expect(ex.sources.files).toBe(true);
    expect(post?.files.map((g) => g.generatedBy)).toEqual(expect.arrayContaining(["entity-file", "routes-file"]));
    expect(ex.sources.routes).toBe(true);
    expect(post?.routes.some((r) => r.method === "GET" && r.path.startsWith("/api/"))).toBe(true);
    expect(readFileSync(join(tmp, "docs", "site", "api.html"), "utf8")).toContain("/api/");
  });

  test("without a routes generator in the run, the site says no routes were recorded, not that none are mounted", async () => {
    await runGen({ config: config([entityFile(), docsSiteFile()]), metadata: root, projectRoot: tmp, sourceRoots: [sources] });
    const ex = explorerOf();
    expect(ex.sources.routes).toBe(false);
    expect(ex.nodes.every((n) => n.routes.length === 0)).toBe(true);
    expect(readFileSync(join(tmp, "docs", "site", "api.html"), "utf8")).toContain("recorded no routes");
  });

  test("a requirement ledger that throws leaves the ledger out with a warning, and the site still builds", async () => {
    const result = await runGen({
      config: config([docsSiteFile()]),
      metadata: root,
      projectRoot: tmp,
      sourceRoots: [sources],
      requirementLedger: () => { throw new Error("gate exploded"); },
    });
    expect(explorerOf().sources.requirements).toBe(false);
    expect(result.warnings.some((w) => w.includes("gate exploded"))).toBe(true);
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
    expect(explorerOf().sources.requirements).toBe(true);
  });

  test("site: \"classic\" builds the earlier site and no explorer.json", async () => {
    await runGen({ config: config([docsSiteFile({ site: "classic" })]), metadata: root, projectRoot: tmp, sourceRoots: [sources] });
    expect(existsSync(join(tmp, "docs", "site", "assets", "site.css"))).toBe(true);
    expect(existsSync(join(tmp, "docs", "site", "explorer.json"))).toBe(false);
  });
});
