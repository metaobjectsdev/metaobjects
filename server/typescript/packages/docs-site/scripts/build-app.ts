// Build the model explorer app into the repository's canonical copy, `explorer-app/`.
//
//   bun server/typescript/packages/docs-site/scripts/build-app.ts           # rebuild
//   bun server/typescript/packages/docs-site/scripts/build-app.ts --check   # exit 1 when stale
//
// It bundles `app-src/main.ts` (the router around the explorer's page code, `src/explorer/`) with
// every explorer template for the browser, as one classic script, and copies the shell and the
// theme beside it. Cytoscape (`assets/cytoscape.min.js`) is vendored in `explorer-app/` and is
// not touched here. Run `scripts/sync-explorer-app.sh` afterwards to refresh every port's copy.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXPLORER_ASSET_NAMES, EXPLORER_TEMPLATE_NAMES } from "../src/scaffold.js";

const PKG = resolve(import.meta.dir, "..");
const REPO = resolve(PKG, "../../../..");
const OUT = join(REPO, "explorer-app");
const RENDER_SRC = resolve(PKG, "../render/src");

/** The bundle's files by path under `explorer-app/`. */
export async function buildExplorerApp(): Promise<Map<string, string>> {
  const templates: Record<string, string> = {};
  for (const name of EXPLORER_TEMPLATE_NAMES) templates[name] = readFileSync(join(PKG, "templates", name), "utf8");
  const result = await Bun.build({
    entrypoints: [join(PKG, "app-src/main.ts")],
    target: "browser",
    format: "iife",
    minify: true,
    // Bundle the workspace packages from their sources (the `bun` export condition), never from
    // a `dist/` that may be stale or missing.
    conditions: ["bun"],
    plugins: [
      {
        name: "explorer-app",
        setup(b) {
          b.onResolve({ filter: /^explorer-templates$/ }, () => ({ path: "explorer-templates", namespace: "explorer-app" }));
          b.onLoad({ filter: /.*/, namespace: "explorer-app" }, () => ({ contents: `export default ${JSON.stringify(templates)};`, loader: "js" }));
          // The renderer's package root also exports its file-system provider; the app needs the
          // Mustache renderer and the in-memory provider only.
          b.onResolve({ filter: /^@metaobjectsdev\/render$/ }, () => ({ path: "render-shim", namespace: "explorer-app-render" }));
          b.onLoad({ filter: /.*/, namespace: "explorer-app-render" }, () => ({
            contents: `export { render } from ${JSON.stringify(join(RENDER_SRC, "render.ts"))};\nexport { InMemoryProvider } from ${JSON.stringify(join(RENDER_SRC, "provider.ts"))};\n`,
            loader: "ts",
            resolveDir: RENDER_SRC,
          }));
          // Jinja is a prompt engine; the explorer's templates are Mustache, so the app never
          // reaches it.
          b.onResolve({ filter: /^nunjucks$/ }, () => ({ path: "nunjucks", namespace: "explorer-app-nunjucks" }));
          b.onLoad({ filter: /.*/, namespace: "explorer-app-nunjucks" }, () => ({
            contents: `const unavailable = () => { throw new Error("the explorer app renders Mustache only"); };\nexport default new Proxy({}, { get: () => unavailable });\n`,
            loader: "js",
          }));
        },
      },
    ],
  });
  if (!result.success) throw new Error("explorer app build failed:\n" + result.logs.map(String).join("\n"));
  const js = await result.outputs[0]!.text();
  const files = new Map<string, string>();
  files.set("assets/explorer-app.js", js.endsWith("\n") ? js : js + "\n");
  files.set("index.html", readFileSync(join(PKG, "app-src/index.html"), "utf8"));
  for (const a of EXPLORER_ASSET_NAMES) files.set(`assets/${a}`, readFileSync(join(PKG, "assets", a), "utf8"));
  return files;
}

if (import.meta.main) {
  const check = process.argv.includes("--check");
  const files = await buildExplorerApp();
  const stale: string[] = [];
  for (const [rel, content] of files) {
    const abs = join(OUT, rel);
    const same = existsSync(abs) && readFileSync(abs, "utf8") === content;
    if (same) continue;
    if (check) {
      stale.push(rel);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    console.log(`wrote explorer-app/${rel}`);
  }
  if (check && stale.length > 0) {
    console.error(`explorer-app/ is stale (rebuild with scripts/build-app.ts): ${stale.join(", ")}`);
    process.exit(1);
  }
  if (!check) console.log(`explorer app built: ${files.size} files under explorer-app/ (bundle ${files.get("assets/explorer-app.js")!.length} bytes)`);
}
