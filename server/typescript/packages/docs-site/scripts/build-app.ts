// Build the model explorer app into the repository's canonical copy, `explorer-app/`.
//
//   bun server/typescript/packages/docs-site/scripts/build-app.ts           # rebuild
//   bun server/typescript/packages/docs-site/scripts/build-app.ts --check   # exit 1 when stale
//
// It bundles `app-src/main.ts` (the router around the explorer's page code, `src/explorer/`) with
// every explorer template for the browser, as one classic script, and copies the shell and the
// theme beside it. Cytoscape (`assets/cytoscape.min.js`) is vendored in `explorer-app/` and is
// not touched here. Run `scripts/sync-explorer-app.sh` afterwards to refresh every port's copy.
//
// The committed bundle is minified (whitespace and syntax only; identifiers keep their names, so
// the bytes do not depend on the minifier's naming), and minified output follows the Bun version,
// so it is built and checked with one Bun only: the version the workflows pin (`bun-version` in
// `.github/workflows/`). Any other Bun refuses rather than reporting a stale bundle.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { EXPLORER_ASSET_NAMES, EXPLORER_TEMPLATE_NAMES } from "../src/scaffold.js";

const PKG = resolve(import.meta.dir, "..");
const REPO = resolve(PKG, "../../../..");
const OUT = join(REPO, "explorer-app");
const RENDER_SRC = resolve(PKG, "../render/src");

// The bundle inlines mustache.js, whose MIT licence asks for its notice in every copy.
const MUSTACHE_NOTICE = `/*!
 * mustache.js, inlined in this bundle. The MIT License
 *
 * Copyright (c) 2009 Chris Wanstrath (Ruby)
 * Copyright (c) 2010-2014 Jan Lehnardt (JavaScript)
 * Copyright (c) 2010-2015 The mustache.js community
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */`;

/** The Bun that builds the committed bundle. */
export const EXPLORER_APP_BUN = "1.3.14";

/** The bundle's files by path under `explorer-app/`. */
export async function buildExplorerApp(): Promise<Map<string, string>> {
  if (Bun.version !== EXPLORER_APP_BUN) {
    throw new Error(`the explorer app is built with Bun ${EXPLORER_APP_BUN}, the version CI pins; this is Bun ${Bun.version}. Run it with Bun ${EXPLORER_APP_BUN}.`);
  }
  const templates: Record<string, string> = {};
  for (const name of EXPLORER_TEMPLATE_NAMES) templates[name] = readFileSync(join(PKG, "templates", name), "utf8");
  const result = await Bun.build({
    entrypoints: [join(PKG, "app-src/main.ts")],
    target: "browser",
    format: "iife",
    // Identifier renaming is off: Bun's choice of short names is not stable from one build to
    // the next, so a renamed bundle would fail the committed-bytes check on unchanged sources.
    minify: { whitespace: true, syntax: true, identifiers: false },
    banner: MUSTACHE_NOTICE,
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
