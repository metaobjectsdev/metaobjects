// generateExplorerSite(): the model explorer as a static site (design report §3.3, phase P1).
//
// It reads one `explorer.json` (and, for the prompt pages, the prompt texts), renders a page per
// screen through the bundled Mustache templates, and writes:
//
//   index.html                      S1  what the project does
//   map.html                        S2  the model map (slices, colour-by)
//   model/<pkg>/<Name>.html         S3  an object page (entity, value, projection, report)
//                                   S4  a prompt page (and any other template)
//   requirements/{features,qualities}.html                S5
//   requirements/<pkg>/<dotted.path>.html                 S6
//   matrix.html, trace.html, gaps.html, api.html, prompts.html, model/index.html, model/<pkg>/index.html
//   assets/explorer.css, assets/explorer.js               the theme (`meta eject docs-site` copies them)
//   assets/explorer-data.js         the graph and the search index the scripts read
//   explorer.json                   the data spine itself, byte for byte
//
// The output depends on its inputs alone (no clock, no random layout seed in the files), so the
// site can sit under `meta verify --codegen`. Search works offline from explorer-data.js; when the
// published site has been indexed with Pagefind (`npx pagefind --site <dir>`), the search box uses
// that index instead. The pages carry Pagefind's markup for it.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render, InMemoryProvider } from "@metaobjectsdev/render";
import { REQUIREMENT_ATTR_STATEMENT, REQUIREMENT_SUBTYPE_ARCHITECTURAL, REQUIREMENT_SUBTYPE_FUNCTIONAL } from "@metaobjectsdev/metadata";
import { TEMPLATE_ATTR_TEXT_REF, TYPE_REQUIREMENT, DOC_ATTR_DESCRIPTION, OBJECT_SUBTYPE_REPORT, OBJECT_REPORT_ATTR_FROM } from "@metaobjectsdev/metadata/constants";
import { checkLinks } from "../link-check.js";
import { EXPLORER_ASSET_NAMES, EXPLORER_TEMPLATE_NAMES } from "../scaffold.js";
import { ExplorerIndex } from "./index-model.js";
import { serializeExplorer } from "./build.js";
import { esc, legendHtml, relHref } from "./html.js";
import {
  PAGE_API,
  PAGE_FEATURES,
  PAGE_GAPS,
  PAGE_MAP,
  PAGE_MATRIX,
  PAGE_MODEL,
  PAGE_OVERVIEW,
  PAGE_PROMPTS,
  PAGE_QUALITIES,
  PAGE_TRACE,
  Pages,
} from "./pages.js";
import type { ExplorerJson } from "./types.js";

export { EXPLORER_ASSET_NAMES, EXPLORER_TEMPLATE_NAMES };

/** The graph library the map, mini-maps and trace load from `assetBase`. */
export const CYTOSCAPE_PATH = "cytoscape@3.30.2/dist/cytoscape.min.js";

const DEFAULT_ASSET_BASE = "https://cdn.jsdelivr.net/npm";

export interface ExplorerSiteOptions {
  explorer: ExplorerJson;
  outDir: string;
  /** The project's name, as the header and the home page print it. */
  title: string;
  /** Printed in every footer. Default none, so the pages depend on the model alone. */
  stamp?: string;
  /** Prompt text by template node id, for the prompt pages and the unused-payload check. */
  texts?: ReadonlyMap<string, string>;
  /** Override dirs: a file of the same basename there wins over the bundled one. */
  templatesDir?: string;
  assetsDir?: string;
  /** Where Cytoscape is loaded from. Default `https://cdn.jsdelivr.net/npm`. */
  assetBase?: string;
}

export interface ExplorerSiteResult {
  /** Every HTML page written, site-relative, in write order. */
  pages: string[];
  /** Every file written (pages, assets, data), site-relative, sorted. */
  files: string[];
}

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const BUNDLED_TEMPLATES = resolve(SELF_DIR, "../../templates");
const BUNDLED_ASSETS = resolve(SELF_DIR, "../../assets");

function loadFrom(bundled: string, name: string, overrideDir?: string): string {
  if (overrideDir !== undefined) {
    const candidate = join(overrideDir, name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return readFileSync(join(bundled, name), "utf8");
}

interface NavItem {
  key: string;
  label: string;
  href: string;
}

const NAV: readonly NavItem[] = [
  { key: "overview", label: "Overview", href: PAGE_OVERVIEW },
  { key: "map", label: "Model map", href: PAGE_MAP },
  { key: "requirements", label: "Requirements", href: PAGE_FEATURES },
  { key: "matrix", label: "Matrix", href: PAGE_MATRIX },
  { key: "trace", label: "Trace", href: PAGE_TRACE },
  { key: "prompts", label: "Prompts", href: PAGE_PROMPTS },
  { key: "api", label: "API", href: PAGE_API },
  { key: "gaps", label: "Gaps", href: PAGE_GAPS },
];

/** Read each prompt's `.mustache` text from the directories the model's `@textRef` resolves in. */
export function readPromptTexts(explorer: ExplorerJson, dirs: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of explorer.nodes) {
    const ref = n.attrs[TEMPLATE_ATTR_TEXT_REF];
    if (n.parent !== undefined || typeof ref !== "string") continue;
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
  const ix = new ExplorerIndex(opts.explorer);
  const pagesModel = new Pages(ix);
  for (const [id, text] of opts.texts ?? []) pagesModel.texts.set(id, text);
  // The one partial: the requirement card S1 repeats (`{{> card}}`).
  const provider = new InMemoryProvider({ card: loadFrom(BUNDLED_TEMPLATES, "explorer-card.mustache", opts.templatesDir) });
  const head = loadFrom(BUNDLED_TEMPLATES, "explorer-head.mustache", opts.templatesDir);
  const foot = loadFrom(BUNDLED_TEMPLATES, "explorer-foot.mustache", opts.templatesDir);
  const assetBase = (opts.assetBase ?? DEFAULT_ASSET_BASE).replace(/\/+$/, "");
  const legend = legendHtml(ix.hasClaims());
  const pages: string[] = [];
  const files: string[] = [];

  const written = new Set<string>();
  const write = (rel: string, content: string): void => {
    // Two nodes that map to one page would silently keep only the last; refuse instead.
    if (written.has(rel)) throw new Error(`docs-site explorer: two pages map to ${rel}`);
    written.add(rel);
    const abs = join(opts.outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    files.push(rel);
  };

  const page = (template: string, href: string, nav: string, pageTitle: string, data: Record<string, unknown>, graph = false): void => {
    const relRoot = relHref(href, "");
    const body = loadFrom(BUNDLED_TEMPLATES, template, opts.templatesDir);
    const payload = {
      ...data,
      siteTitle: esc(opts.title),
      pageTitle: esc(pageTitle),
      stamp: esc(opts.stamp ?? ""),
      relRoot,
      assetBase,
      cytoscapeSrc: `${assetBase}/${CYTOSCAPE_PATH}`,
      needsGraph: graph,
      pageKey: nav,
      nav: NAV.map((n) => ({ label: n.label, href: relHref(href, n.href), on: n.key === nav })),
      legendHtml: legend,
    };
    write(href, render({ template: head + body + foot, payload, provider, format: "text" }));
    pages.push(href);
  };

  // S1 and the indexes.
  page("explorer-overview.html.mustache", PAGE_OVERVIEW, "overview", "Overview", pagesModel.overview(opts.title));
  page("explorer-map.html.mustache", PAGE_MAP, "map", "Model map", pagesModel.map(), true);
  page("explorer-requirements.html.mustache", PAGE_FEATURES, "requirements", "Features", pagesModel.requirements(REQUIREMENT_SUBTYPE_FUNCTIONAL, PAGE_FEATURES));
  page("explorer-requirements.html.mustache", PAGE_QUALITIES, "requirements", "Qualities", pagesModel.requirements(REQUIREMENT_SUBTYPE_ARCHITECTURAL, PAGE_QUALITIES));
  page("explorer-matrix.html.mustache", PAGE_MATRIX, "matrix", "Matrix", pagesModel.matrix());
  page("explorer-trace.html.mustache", PAGE_TRACE, "trace", "Trace", pagesModel.trace(), true);
  page("explorer-prompts.html.mustache", PAGE_PROMPTS, "prompts", "Prompts", pagesModel.prompts());
  page("explorer-api.html.mustache", PAGE_API, "api", "API", pagesModel.api());
  page("explorer-gaps.html.mustache", PAGE_GAPS, "gaps", "Gaps", pagesModel.gaps());
  page("explorer-model.html.mustache", PAGE_MODEL, "map", "Packages", pagesModel.model());

  for (const pkg of ix.packages) {
    const data = pagesModel.packageIndex(pkg);
    page("explorer-package.html.mustache", pagesModel.packagePage(pkg), "map", pkg === "" ? "(no package)" : pkg, data);
  }
  for (const n of ix.objects) page("explorer-object.html.mustache", pagesModel.objectPage(n), "map", n.name, pagesModel.object(n), true);
  for (const t of ix.templates) page("explorer-prompt.html.mustache", pagesModel.objectPage(t), "prompts", t.name, pagesModel.prompt(t, opts.texts?.get(t.id)));
  for (const r of ix.requirements) page("explorer-requirement.html.mustache", pagesModel.reqPage(r), "requirements", pagesModel.reqLabel(r), pagesModel.requirement(r));

  for (const a of EXPLORER_ASSET_NAMES) write(`assets/${a}`, loadFrom(BUNDLED_ASSETS, a, opts.assetsDir));
  write("assets/explorer-data.js", `window.MO_EXPLORER = ${JSON.stringify(graphData(ix, pagesModel))};\n`);
  write("explorer.json", serializeExplorer(opts.explorer));

  const dangling = checkLinks(opts.outDir, pages);
  if (dangling.length > 0) throw new Error("explorer link check failed:\n" + dangling.join("\n"));
  return { pages, files: [...files].sort() };
}

/** The data the map, mini-maps, trace and search read. Every value comes off the index. */
function graphData(ix: ExplorerIndex, p: Pages): Record<string, unknown> {
  const features = ix.features();
  const top = [...ix.objects, ...ix.templates];
  const nodes = top.map((n) => {
    const feature = ix.featureOf(n.id);
    const claims = ix.claims(n.id);
    return {
      id: n.id,
      name: n.name,
      kind: ix.kindOf(n),
      pkg: n.package,
      href: p.objectPage(n),
      abstract: n.abstract === true ? 1 : 0,
      fields: ix.fields(n.id).length,
      claims: claims.length,
      status: ix.claimStatus(n.id),
      feature: feature !== undefined ? features.indexOf(feature) : -1,
      quality: claims.length > 0 && claims.every((c) => c.req.kind === REQUIREMENT_SUBTYPE_ARCHITECTURAL) ? 1 : 0,
      unclaimed: p.unclaimedEntity(n) ? 1 : 0,
      api: ix.routes(n.id).map((r) => `${r.method} ${r.path}`),
      gen: ix.generated(n.id).length,
      storage: ix.storage(n.id)?.kind ?? "",
    };
  });
  const ids = new Set(top.map((n) => n.id));
  const slices: Record<string, string[]> = {};
  for (const s of ix.doc.slices) slices[s.id] = [...new Set(s.nodes.map((x) => ix.ownerOf(x)).filter((x) => ids.has(x)))].sort();
  const reqs = ix.requirements.map((r) => ({
    id: r.node.id,
    label: p.reqLabel(r),
    path: p.reqPath(r),
    level: r.level ?? 0,
    status: r.status,
    kind: r.kind,
    parent: r.parent?.node.id ?? "",
    href: p.reqPage(r),
    targets: (r.row?.implementedBy ?? []).filter((l) => l.target !== undefined && ix.byId.has(l.target)).map((l) => ix.ownerOf(l.target!)),
    statement: typeof r.node.attrs[REQUIREMENT_ATTR_STATEMENT] === "string" ? r.node.attrs[REQUIREMENT_ATTR_STATEMENT] : "",
    rollup: ix.rollup(r),
    claimed: ix.targetsOf(r).length,
  }));
  const generated: Record<string, [string, number][]> = {};
  for (const n of top) {
    const by = new Map<string, number>();
    for (const f of ix.generated(n.id)) by.set(f.generatedBy, (by.get(f.generatedBy) ?? 0) + 1);
    if (by.size > 0) generated[n.id] = [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }
  const search: { t: string; s: string; h: string; k: string }[] = [];
  for (const n of top) {
    const desc = typeof n.attrs[DOC_ATTR_DESCRIPTION] === "string" ? (n.attrs[DOC_ATTR_DESCRIPTION] as string) : "";
    search.push({ t: n.name, s: `${n.type}.${n.subType}${n.package !== "" ? ` · ${n.package}` : ""}`, h: p.objectPage(n), k: `${n.name} ${n.id} ${desc}`.toLowerCase() });
    for (const f of ix.fields(n.id)) {
      if (f.inheritedFrom !== undefined) continue;
      search.push({ t: `${n.name}.${f.name}`, s: `field.${f.subType}`, h: p.pageOf(f.id) ?? p.objectPage(n), k: `${n.name}.${f.name} ${f.id}`.toLowerCase() });
    }
  }
  for (const r of ix.requirements) {
    search.push({
      t: p.reqLabel(r),
      s: `${r.level !== undefined ? `L${r.level}` : "—"} ${r.kind}${r.status !== "" ? ` · ${r.status}` : ""} · ${p.reqPath(r)}`,
      h: p.reqPage(r),
      k: `${p.reqPath(r)} ${r.node.id} ${p.reqLabel(r)} ${String(r.node.attrs[REQUIREMENT_ATTR_STATEMENT] ?? "")}`.toLowerCase(),
    });
  }
  return {
    nodes,
    edges: [
      ...ix.modelEdges().map((e) => ({ s: e.from, t: e.to, k: e.kind, ...(e.via !== undefined ? { v: localTail(e.via) } : {}) })),
      // A report reads its rows from the `@from` entity: drawn so a report is not an island.
      ...ix.objects
        .filter((n) => n.subType === OBJECT_SUBTYPE_REPORT && typeof n.attrs[OBJECT_REPORT_ATTR_FROM] === "string" && ix.byId.has(n.attrs[OBJECT_REPORT_ATTR_FROM] as string))
        .map((n) => ({ s: n.id, t: n.attrs[OBJECT_REPORT_ATTR_FROM] as string, k: "from" })),
    ],
    slices,
    features: features.map((f) => ({ id: f.node.id, label: p.reqLabel(f) })),
    reqs,
    generated,
    search,
    hasClaims: ix.hasClaims(),
    requirementType: TYPE_REQUIREMENT,
  };
}

function localTail(id: string): string {
  const i = id.lastIndexOf(".");
  return i < 0 ? id : id.slice(i + 1);
}
