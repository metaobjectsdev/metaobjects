// generateExplorerSite(): the model explorer (design report §3.3), written one of two ways.
//
// It reads one docs view (`buildDocsView` in `@metaobjectsdev/metadata`, and, for the prompt
// pages, the prompt texts).
//
// `output: "app"` (the default) writes a single-page browser app and the data it reads, and no
// pages at all. The app draws every page in the browser from the same page code (`core.ts`),
// works from `file://` with no server, and follows the model on disk: it polls the stamp file
// about once a second and reloads the data when the stamp moves, keeping the page it is on.
//
//   index.html                      the app's shell (the same file for every project)
//   assets/explorer-app.js          the app: the page code, the templates and the router
//   assets/explorer.css, explorer.js the theme (`meta eject docs-site` copies them)
//   assets/cytoscape.min.js         the graph library (MIT), so the graphs draw offline
//   assets/3d-force-graph.min.js    the map's 3D mode (MIT, bundles three.js), loaded on demand
//   explorer-model.js               the docs view, the prompt texts, the title and any owned
//                                   templates, as one script the shell loads
//   explorer-stamp.js               the model file's hash, which the app polls
//   explorer.json                   the docs view itself, byte for byte
//
// The app's files (everything but the three data files) are the canonical copy under
// `explorer-app/` at the repository root; every port ships the same bytes.
//
// `output: "static"` writes a page per screen instead, for a team that wants to publish the
// pages without scripts or index them for search:
//
//   index.html                      S1  what the project does
//   map.html                        S2  the model map (slices, colour-by)
//   model/<pkg>/<Name>.html         S3  an object page (entity, value, projection, report)
//                                   S4  a prompt page (and any other template)
//                                       a generic page for any other top-level type
//   model/<pkg>/<Name>.<type>-<subType>.html   the same, for a node whose name another
//                                       type's node holds in its package
//   requirements/{features,qualities}.html                S5
//   requirements/<pkg>/<dotted.path>.html                 S6
//   matrix.html, trace.html, gaps.html, api.html, prompts.html, model/index.html, model/<pkg>/index.html
//   assets/explorer.css, assets/explorer.js               the theme
//   assets/cytoscape.min.js, assets/3d-force-graph.min.js   unless `assetBase` names a mirror
//   assets/explorer-data.js         the graph and the search index the scripts read
//   explorer.json                   the docs view itself, byte for byte
//
// Either output depends on its inputs alone (no clock, no random layout seed in the files), so
// the site can sit under `meta verify --codegen`. Every build checks its own links.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serializeDocsView, type DocsView } from "@metaobjectsdev/metadata";
import { TEMPLATE_ATTR_TEXT_REF } from "@metaobjectsdev/metadata/constants";
import { checkLinks, checkLinksInMemory } from "../link-check.js";
import { EXPLORER_APP_FILES, EXPLORER_ASSET_NAMES, EXPLORER_TEMPLATE_NAMES } from "../scaffold.js";
import { CYTOSCAPE_ASSET, CYTOSCAPE_PATH, GRAPH3D_ASSET, GRAPH3D_PATH, createExplorer } from "./core.js";

export { EXPLORER_APP_FILES, EXPLORER_ASSET_NAMES, EXPLORER_TEMPLATE_NAMES, CYTOSCAPE_PATH, GRAPH3D_PATH };

/** The two ways the explorer is written. */
export const EXPLORER_OUTPUT_APP = "app";
export const EXPLORER_OUTPUT_STATIC = "static";
export type ExplorerOutput = typeof EXPLORER_OUTPUT_APP | typeof EXPLORER_OUTPUT_STATIC;

/** The data files the app reads, beside its shell. */
export const EXPLORER_MODEL_FILE = "explorer-model.js";
export const EXPLORER_STAMP_FILE = "explorer-stamp.js";
export const EXPLORER_VIEW_FILE = "explorer.json";

export interface ExplorerSiteOptions {
  /** The docs view of the model (`buildDocsView`). */
  view: DocsView;
  outDir: string;
  /** The project's name, as the header and the home page print it. */
  title: string;
  /** `app` (default): one browser app over the view. `static`: a page per screen. */
  output?: ExplorerOutput;
  /** Printed in every footer. Default none, so the pages depend on the model alone. */
  stamp?: string;
  /** Prompt text by template node id, for the prompt pages and the unused-payload check. */
  texts?: ReadonlyMap<string, string>;
  /** Override dirs: a file of the same basename there wins over the bundled one. */
  templatesDir?: string;
  assetsDir?: string;
  /** Static output only: where Cytoscape and the map's 3D library are loaded from, as a
   *  CDN-style base (`${assetBase}/cytoscape@3.30.2/dist/cytoscape.min.js`,
   *  `${assetBase}/3d-force-graph@1.77.0/dist/3d-force-graph.min.js`). Default: the copies the
   *  site ships in `assets/`. The app always uses its own copies. */
  assetBase?: string;
}

export interface ExplorerSiteResult {
  /** Every HTML page the site has, site-relative: written ones for `static`, the ones the app
   *  draws for `app`. */
  pages: string[];
  /** Every file written (pages, assets, data), site-relative, sorted. */
  files: string[];
}

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES = resolve(SELF_DIR, "../../templates");
const BUNDLED_ASSETS = resolve(SELF_DIR, "../../assets");
/** The package's copy of the repository's `explorer-app/` (scripts/sync-explorer-app.sh). */
export const BUNDLED_APP = resolve(SELF_DIR, "../../app");

function loadFrom(bundled: string, name: string, overrideDir?: string): string {
  if (overrideDir !== undefined) {
    const candidate = join(overrideDir, name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return readFileSync(join(bundled, name), "utf8");
}

/** Read each prompt's `.mustache` text from the directories the model's `@textRef` resolves in. */
export function readPromptTexts(view: DocsView, dirs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of view.nodes) {
    const ref = n.attrs.find((a) => a.name === TEMPLATE_ATTR_TEXT_REF)?.value;
    if (typeof ref !== "string") continue;
    // A ref names a file below one of the directories: an absolute ref, or one that climbs out
    // with `..`, is not read, so a model cannot pull an arbitrary file into a published page.
    const segments = ref.split(/[\\/]/);
    if (isAbsolute(ref) || segments.some((s) => s === ".." || s === "")) continue;
    for (const d of dirs) {
      const p = join(d, ...segments) + ".mustache";
      if (existsSync(p)) {
        out.set(n.id, readFileSync(p, "utf8"));
        break;
      }
    }
  }
  return out;
}

export function generateExplorerSite(opts: ExplorerSiteOptions): ExplorerSiteResult {
  const output = opts.output ?? EXPLORER_OUTPUT_APP;
  const templates: Record<string, string> = {};
  for (const name of EXPLORER_TEMPLATE_NAMES) templates[name] = loadFrom(BUNDLED_TEMPLATES, name, opts.templatesDir);
  const files: string[] = [];
  const written = new Set<string>();
  const write = (rel: string, content: string): void => {
    if (written.has(rel)) throw new Error(`docs-site explorer: two files map to ${rel}`);
    written.add(rel);
    const abs = join(opts.outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    files.push(rel);
  };
  const assetBase = opts.assetBase?.replace(/\/+$/, "");
  const core = createExplorer({
    view: opts.view,
    title: opts.title,
    templates,
    ...(opts.texts !== undefined && { texts: opts.texts }),
    ...(opts.stamp !== undefined && { stamp: opts.stamp }),
    assetBase: assetBase ?? "",
    cytoscapeSrc: (relRoot) => (assetBase !== undefined ? `${assetBase}/${CYTOSCAPE_PATH}` : `${relRoot}assets/${CYTOSCAPE_ASSET}`),
    graph3dSrc: (relRoot) => (assetBase !== undefined ? `${assetBase}/${GRAPH3D_PATH}` : `${relRoot}assets/${GRAPH3D_ASSET}`),
  });
  const pages = [...core.pages.keys()];
  const theme = (): void => {
    for (const a of EXPLORER_ASSET_NAMES) write(`assets/${a}`, loadFrom(BUNDLED_ASSETS, a, opts.assetsDir));
  };

  if (output === EXPLORER_OUTPUT_STATIC) {
    for (const [href, draw] of core.pages) write(href, draw());
    theme();
    if (assetBase === undefined) {
      for (const lib of [CYTOSCAPE_ASSET, GRAPH3D_ASSET]) write(`assets/${lib}`, readFileSync(join(BUNDLED_APP, "assets", lib), "utf8"));
    }
    write("assets/explorer-data.js", `window.MO_EXPLORER = ${JSON.stringify(core.graphData())};\n`);
    write(EXPLORER_VIEW_FILE, serializeDocsView(opts.view));
    const dangling = checkLinks(opts.outDir, pages);
    if (dangling.length > 0) throw new Error("explorer link check failed:\n" + dangling.join("\n"));
    return { pages, files: [...files].sort() };
  }

  // The app draws the pages in the browser, so their links are checked here, in memory, before
  // anything is written: a dangling link fails the build as it does for the static pages.
  const drawn = new Map<string, string>();
  for (const [href, draw] of core.pages) drawn.set(href, draw());
  // A page's head names the theme (`assets/explorer.css`), which the app ships.
  const dangling = checkLinksInMemory(drawn, new Set([...EXPLORER_APP_FILES, EXPLORER_VIEW_FILE]));
  if (dangling.length > 0) throw new Error("explorer link check failed:\n" + dangling.join("\n"));

  for (const f of EXPLORER_APP_FILES) {
    if (f === "assets/explorer.css" || f === "assets/explorer.js") continue;
    write(f, readFileSync(join(BUNDLED_APP, f), "utf8"));
  }
  theme();
  const owned: Record<string, string> = {};
  if (opts.templatesDir !== undefined) {
    for (const name of EXPLORER_TEMPLATE_NAMES) if (existsSync(join(opts.templatesDir, name))) owned[name] = templates[name]!;
  }
  const model = explorerModelScript({
    title: opts.title,
    view: opts.view,
    texts: opts.texts ?? new Map(),
    ...(opts.stamp !== undefined && opts.stamp !== "" && { footer: opts.stamp }),
    templates: owned,
  });
  write(EXPLORER_MODEL_FILE, model.script);
  write(EXPLORER_STAMP_FILE, stampScript(model.stamp));
  write(EXPLORER_VIEW_FILE, serializeDocsView(opts.view));
  return { pages, files: [...files].sort() };
}

export interface ExplorerModelInput {
  title: string;
  view: DocsView;
  texts: ReadonlyMap<string, string>;
  /** Footer text (`stamp` on the generator). */
  footer?: string;
  /** Owned templates by basename; the app uses them in place of its own. */
  templates?: Readonly<Record<string, string>>;
}

/** The app's data file: one script setting `window.MO_MODEL`. Its `stamp` is the first 16 hex
 *  digits of the SHA-256 of the model's JSON without the stamp, and the stamp file repeats it,
 *  so the app knows the model it loaded is the one the stamp names. A port writes the same
 *  shape (the key order below, compact JSON). */
export function explorerModelScript(m: ExplorerModelInput): { script: string; stamp: string } {
  const texts: Record<string, string> = {};
  for (const id of [...m.texts.keys()].sort()) texts[id] = m.texts.get(id)!;
  const templates: Record<string, string> = {};
  for (const name of Object.keys(m.templates ?? {}).sort()) templates[name] = m.templates![name]!;
  const rest = JSON.stringify({ title: m.title, footer: m.footer ?? "", texts, templates, view: m.view });
  const stamp = createHash("sha256").update(rest).digest("hex").slice(0, 16);
  return { script: `window.MO_MODEL = {"stamp":${JSON.stringify(stamp)},${rest.slice(1)};\n`, stamp };
}

/** The file the app polls. */
export function stampScript(stamp: string): string {
  return `window.MO_STAMP = ${JSON.stringify(stamp)};\n`;
}
