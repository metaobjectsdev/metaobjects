// The explorer's page table, with no file system: one entry per page, rendered when asked for.
//
// Both ways the explorer reaches a reader go through this module:
//   - the browser app (`app/main.ts`, bundled into `explorer-app.js`) renders a page when it is
//     visited, from the docs view it loaded;
//   - the static export (`generateExplorerSite` in `site.ts`) renders every page once and
//     writes it.
// So a page is the same bytes either way. Nothing here imports Node: the app bundle carries it.

import { render, InMemoryProvider } from "@metaobjectsdev/render";
import {
  DOC_ATTR_DESCRIPTION,
  REQUIREMENT_SUBTYPE_ARCHITECTURAL,
  REQUIREMENT_SUBTYPE_FUNCTIONAL,
  TYPE_REQUIREMENT,
} from "@metaobjectsdev/metadata/constants";
import type { DocsView } from "@metaobjectsdev/metadata";
import { ViewIndex } from "./view-index.js";
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

/** The graph library the map, mini-maps and trace load, under a CDN-style base. */
export const CYTOSCAPE_PATH = "cytoscape@3.30.2/dist/cytoscape.min.js";

/** The file name the app and the static export ship Cytoscape under, in `assets/`. */
export const CYTOSCAPE_ASSET = "cytoscape.min.js";

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

export interface ExplorerCoreOptions {
  view: DocsView;
  /** The project's name, as the header and the home page print it. */
  title: string;
  /** Every explorer template by basename (`EXPLORER_TEMPLATE_NAMES`). */
  templates: Readonly<Record<string, string>>;
  /** Prompt text by template node id. */
  texts?: ReadonlyMap<string, string> | Readonly<Record<string, string>>;
  /** Printed in every footer. */
  stamp?: string;
  /** Where a graph page loads Cytoscape from, relative to the page or absolute. A function of
   *  the page's root-relative prefix (`relRoot`), since a relative path differs per page. */
  cytoscapeSrc: (relRoot: string) => string;
  /** Kept on every page's payload for an owned template that reads it. */
  assetBase: string;
}

export interface ExplorerCore {
  /** Every page by its site-relative path, in the order the static export writes them. */
  pages: ReadonlyMap<string, () => string>;
  /** The data the map, mini-maps, trace and search read (`window.MO_EXPLORER`). */
  graphData(): Record<string, unknown>;
}

function textsMap(t: ExplorerCoreOptions["texts"]): ReadonlyMap<string, string> {
  if (t === undefined) return new Map();
  if (t instanceof Map) return t;
  return new Map(Object.entries(t as Readonly<Record<string, string>>));
}

export function createExplorer(opts: ExplorerCoreOptions): ExplorerCore {
  const ix = new ViewIndex(opts.view);
  const pagesModel = new Pages(ix);
  const texts = textsMap(opts.texts);
  for (const [id, text] of texts) pagesModel.texts.set(id, text);
  const tpl = (name: string): string => {
    const t = opts.templates[name];
    if (t === undefined) throw new Error(`docs-site explorer: no template ${name}`);
    return t;
  };
  // The one partial: the requirement card S1 repeats (`{{> card}}`).
  const provider = new InMemoryProvider({ card: tpl("explorer-card.mustache") });
  const head = tpl("explorer-head.mustache");
  const foot = tpl("explorer-foot.mustache");
  const legend = legendHtml(ix.hasClaims());
  const pages = new Map<string, () => string>();

  const page = (template: string, href: string, nav: string, pageTitle: string, data: () => Record<string, unknown>, graph = false): void => {
    // Two nodes that map to one page would silently keep only the last; refuse instead.
    if (pages.has(href)) throw new Error(`docs-site explorer: two pages map to ${href}`);
    const body = tpl(template);
    pages.set(href, () => {
      const relRoot = relHref(href, "");
      const payload = {
        ...data(),
        siteTitle: esc(opts.title),
        pageTitle: esc(pageTitle),
        stamp: esc(opts.stamp ?? ""),
        relRoot,
        assetBase: opts.assetBase,
        cytoscapeSrc: opts.cytoscapeSrc(relRoot),
        needsGraph: graph,
        pageKey: nav,
        nav: NAV.map((n) => ({ label: n.label, href: relHref(href, n.href), on: n.key === nav })),
        legendHtml: legend,
      };
      return render({ template: head + body + foot, payload, provider, format: "text" });
    });
  };

  // S1 and the indexes.
  page("explorer-overview.html.mustache", PAGE_OVERVIEW, "overview", "Overview", () => pagesModel.overview(opts.title));
  page("explorer-map.html.mustache", PAGE_MAP, "map", "Model map", () => pagesModel.map(), true);
  page("explorer-requirements.html.mustache", PAGE_FEATURES, "requirements", "Features", () => pagesModel.requirements(REQUIREMENT_SUBTYPE_FUNCTIONAL, PAGE_FEATURES));
  page("explorer-requirements.html.mustache", PAGE_QUALITIES, "requirements", "Qualities", () => pagesModel.requirements(REQUIREMENT_SUBTYPE_ARCHITECTURAL, PAGE_QUALITIES));
  page("explorer-matrix.html.mustache", PAGE_MATRIX, "matrix", "Matrix", () => pagesModel.matrix());
  page("explorer-trace.html.mustache", PAGE_TRACE, "trace", "Trace", () => pagesModel.trace(), true);
  page("explorer-prompts.html.mustache", PAGE_PROMPTS, "prompts", "Prompts", () => pagesModel.prompts());
  page("explorer-api.html.mustache", PAGE_API, "api", "API", () => pagesModel.api());
  page("explorer-gaps.html.mustache", PAGE_GAPS, "gaps", "Gaps", () => pagesModel.gaps());
  page("explorer-model.html.mustache", PAGE_MODEL, "map", "Packages", () => pagesModel.model());

  for (const pkg of ix.packages) {
    page("explorer-package.html.mustache", pagesModel.packagePage(pkg), "map", pkg === "" ? "(no package)" : pkg, () => pagesModel.packageIndex(pkg));
  }
  for (const n of ix.objects) page("explorer-object.html.mustache", pagesModel.objectPage(n), "map", n.name, () => pagesModel.object(n), true);
  for (const t of ix.templates) page("explorer-prompt.html.mustache", pagesModel.objectPage(t), "prompts", t.name, () => pagesModel.prompt(t, texts.get(t.id)));
  for (const n of ix.others) page("explorer-node.html.mustache", pagesModel.objectPage(n), "map", n.name, () => pagesModel.node(n));
  for (const r of ix.requirements) page("explorer-requirement.html.mustache", pagesModel.reqPage(r), "requirements", pagesModel.reqLabel(r), () => pagesModel.requirement(r));

  return { pages, graphData: () => graphData(ix, pagesModel) };
}

/** The data the map, mini-maps, trace and search read. Every value comes off the index. */
function graphData(ix: ViewIndex, p: Pages): Record<string, unknown> {
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
  for (const s of ix.view.slices) slices[s.id] = [...new Set(s.nodes.map((x) => ix.ownerOf(x)).filter((x) => ids.has(x)))].sort();
  const reqs = ix.requirements.map((r) => ({
    id: r.node.id,
    label: p.reqLabel(r),
    path: p.reqPath(r),
    level: r.level ?? 0,
    status: r.status,
    kind: r.kind,
    parent: r.parent?.node.id ?? "",
    href: p.reqPage(r),
    targets: ix.linkTargets(r).map((id) => ix.ownerOf(id)),
    statement: r.req.statement,
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
  for (const n of ix.others) {
    const desc = typeof n.attrs[DOC_ATTR_DESCRIPTION] === "string" ? (n.attrs[DOC_ATTR_DESCRIPTION] as string) : "";
    search.push({ t: n.name, s: `${n.type}.${n.subType}${n.package !== "" ? ` · ${n.package}` : ""}`, h: p.objectPage(n), k: `${n.name} ${n.id} ${desc}`.toLowerCase() });
  }
  for (const r of ix.requirements) {
    search.push({
      t: p.reqLabel(r),
      s: `${r.level !== undefined ? `L${r.level}` : "—"} ${r.kind}${r.status !== "" ? ` · ${r.status}` : ""} · ${p.reqPath(r)}`,
      h: p.reqPage(r),
      k: `${p.reqPath(r)} ${r.node.id} ${p.reqLabel(r)} ${r.req.statement}`.toLowerCase(),
    });
  }
  return {
    nodes,
    // Every reference the view lists between two nodes on the map, labelled by the attribute
    // that carries it (a report's `@from` among them, so a report is not an island). The map
    // draws objects and prompts, and an edge to a node it does not draw would not load.
    edges: ix
      .modelEdges()
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ s: e.from, t: e.to, k: e.kind, ...(e.via !== undefined ? { v: localTail(e.via) } : {}) })),
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
