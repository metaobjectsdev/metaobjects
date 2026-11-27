// The explorer as one browser app (`generateExplorerSite`'s default output): the files it writes,
// the data files a port writes beside them, and the COMMITTED bundle held page for page to the
// static export built from the same sources. The bundle runs here in a bare VM context, with no
// DOM, exactly as `globalThis.MoExplorer` documents.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { MetaDataLoader, buildDocsView, type DocsView } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";
import {
  EXPLORER_APP_FILES,
  EXPLORER_MODEL_FILE,
  EXPLORER_STAMP_FILE,
  EXPLORER_VIEW_FILE,
  explorerModelScript,
  generateExplorerSite,
  readPromptTexts,
} from "../src/index.js";
import { buildExplorerApp } from "../scripts/build-app.js";
import { corpusView } from "./fixture/views.js";

const PKG = resolve(import.meta.dir, "..");
const REPO = resolve(PKG, "../../../..");
const ROOT_APP = join(REPO, "explorer-app");
const PKG_APP = join(PKG, "app");
const SHOP = join(REPO, "fixtures/explorer-conformance/shop");
const FITNESS = join(REPO, "fixtures/persistence-conformance/canonical");

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(process.env.DEV_SCRATCH ?? tmpdir(), "explorer-app-"));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile())
    .map((f) => relative(dir, join(f.parentPath, f.name)).split("\\").join("/"))
    .sort();
}

interface BundleExplorer {
  pages: Map<string, () => string>;
  graphData(): Record<string, unknown>;
}
interface Bundle {
  explorerFor(model: unknown): BundleExplorer;
}

/** The committed bundle, loaded as a browser would load it but with no document. */
function loadBundle(file = join(PKG_APP, "assets/explorer-app.js")): Bundle {
  const ctx: Record<string, unknown> = {};
  runInNewContext(readFileSync(file, "utf8"), ctx);
  return ctx.MoExplorer as Bundle;
}

function parseModel(script: string): unknown {
  const prefix = "window.MO_MODEL = ";
  expect(script.startsWith(prefix)).toBe(true);
  return JSON.parse(script.slice(prefix.length).replace(/;\n$/, ""));
}

interface Case {
  name: string;
  view: DocsView;
  title: string;
  texts: Map<string, string>;
}

const shopView = await corpusView("shop");
const fitnessRoot = (await new MetaDataLoader().load([new FileSource(join(FITNESS, "meta.fitness.json"))])).root;
const fitnessView = buildDocsView({ root: fitnessRoot });
const CASES: Case[] = [
  { name: "shop", view: shopView, title: "Shop", texts: readPromptTexts(shopView, [join(SHOP, "project/prompts"), join(SHOP, "project")]) },
  { name: "crm", view: await corpusView("crm"), title: "Acme", texts: new Map() },
  { name: "fitness", view: fitnessView, title: "Fitness", texts: readPromptTexts(fitnessView, [join(FITNESS, "prompts"), FITNESS]) },
];

describe("the explorer app's files", () => {
  test("explorer-app/ is what the sources build", async () => {
    const built = await buildExplorerApp();
    for (const [rel, content] of built) expect(readFileSync(join(ROOT_APP, rel), "utf8")).toBe(content);
  });

  test("the package's copy equals the repository's canonical copy", () => {
    const want = filesUnder(ROOT_APP).filter((f) => f !== "README.md");
    expect(filesUnder(PKG_APP)).toEqual(want);
    for (const f of want) expect(readFileSync(join(PKG_APP, f))).toEqual(readFileSync(join(ROOT_APP, f)));
    expect([...EXPLORER_APP_FILES].sort()).toEqual(want);
  });
});

describe("explorer app output", () => {
  const c = CASES[0]!;
  const build = (opts: { templatesDir?: string; assetsDir?: string; stamp?: string; view?: DocsView } = {}) => {
    const out = scratch();
    const r = generateExplorerSite({ view: opts.view ?? c.view, outDir: out, title: c.title, texts: c.texts, ...opts });
    return { out, ...r, file: (p: string) => readFileSync(join(out, p), "utf8") };
  };
  const site = build();

  test("writes the app's files and three data files, and no page", () => {
    expect(site.files).toEqual([...EXPLORER_APP_FILES, EXPLORER_MODEL_FILE, EXPLORER_STAMP_FILE, EXPLORER_VIEW_FILE].sort());
    expect(filesUnder(site.out)).toEqual(site.files);
    for (const f of EXPLORER_APP_FILES) expect(site.file(f)).toBe(readFileSync(join(PKG_APP, f), "utf8"));
    // The pages the app draws are listed, though none is written.
    expect(site.pages).toContain("model/acme/shop/Order.html");
  });

  test("the view file is the docs view, byte for byte, as the static export writes it", () => {
    expect(site.file(EXPLORER_VIEW_FILE)).toBe(readFileSync(join(SHOP, "expected.json"), "utf8"));
  });

  test("the stamp file names the model it sits beside", () => {
    const model = parseModel(site.file(EXPLORER_MODEL_FILE)) as { stamp: string; title: string; texts: Record<string, string> };
    expect(site.file(EXPLORER_STAMP_FILE)).toBe(`window.MO_STAMP = ${JSON.stringify(model.stamp)};\n`);
    expect(model.stamp).toMatch(/^[0-9a-f]{16}$/);
    expect(model.title).toBe("Shop");
    expect(Object.keys(model.texts).length).toBeGreaterThan(0);
  });

  test("is deterministic, and the stamp moves when the model does", async () => {
    const again = build();
    for (const f of site.files) expect(again.file(f)).toBe(site.file(f));
    const edited = await corpusView("shop", (input) => {
      input.routes = [];
    });
    const changed = build({ view: edited });
    expect(changed.file(EXPLORER_STAMP_FILE)).not.toBe(site.file(EXPLORER_STAMP_FILE));
    expect(build({ stamp: "v1" }).file(EXPLORER_STAMP_FILE)).not.toBe(site.file(EXPLORER_STAMP_FILE));
  });

  test("an owned template travels in the model file and the app draws with it", () => {
    const templatesDir = scratch();
    const head = readFileSync(join(PKG, "templates/explorer-head.mustache"), "utf8").replace("model explorer</small>", "owned explorer</small>");
    writeFileSync(join(templatesDir, "explorer-head.mustache"), head);
    const owned = build({ templatesDir });
    const model = parseModel(owned.file(EXPLORER_MODEL_FILE)) as { templates: Record<string, string> };
    expect(Object.keys(model.templates)).toEqual(["explorer-head.mustache"]);
    expect(loadBundle().explorerFor(model).pages.get("index.html")!()).toContain("owned explorer</small>");
  });

  test("an owned theme replaces the packaged one in the written site", () => {
    const assetsDir = scratch();
    writeFileSync(join(assetsDir, "explorer.css"), "/* owned */\n");
    expect(build({ assetsDir }).file("assets/explorer.css")).toBe("/* owned */\n");
  });

  test("a dangling link fails the build as it does for the static pages", () => {
    const templatesDir = scratch();
    writeFileSync(join(templatesDir, "explorer-gaps.html.mustache"), `<a href="nowhere.html">x</a>`);
    expect(() => build({ templatesDir })).toThrow(/explorer link check failed:\ngaps.html -> nowhere.html/);
  });

  test("the model script is the documented shape", () => {
    const { script, stamp } = explorerModelScript({ title: "T", view: c.view, texts: new Map([["b", "2"], ["a", "1"]]) });
    expect(script.startsWith(`window.MO_MODEL = {"stamp":"${stamp}","title":"T","footer":"","texts":{"a":"1","b":"2"},"templates":{},"view":{`)).toBe(true);
  });
});

describe("the committed bundle draws every page the static export writes, byte for byte", () => {
  const bundle = loadBundle();
  for (const c of CASES) {
    test(c.name, () => {
      const out = scratch();
      const r = generateExplorerSite({ output: "static", view: c.view, outDir: out, title: c.title, texts: c.texts });
      const model = parseModel(explorerModelScript({ title: c.title, view: c.view, texts: c.texts }).script);
      const app = bundle.explorerFor(model);
      expect([...app.pages.keys()]).toEqual(r.pages);
      let same = 0;
      for (const p of r.pages) {
        // The one deliberate difference: a static page loads Cytoscape itself, the app's shell
        // loads it once for every page.
        const want = readFileSync(join(out, p), "utf8").replace(/<script src="[^"]*cytoscape\.min\.js"><\/script>/, `<script src=""></script>`);
        expect(app.pages.get(p)!()).toBe(want);
        same++;
      }
      expect(same).toBe(r.pages.length);
      const data = readFileSync(join(out, "assets/explorer-data.js"), "utf8");
      expect(`window.MO_EXPLORER = ${JSON.stringify(app.graphData())};\n`).toBe(data);
    });
  }
});
