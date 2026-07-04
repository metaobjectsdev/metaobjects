import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { render, InMemoryProvider } from "@metaobjectsdev/render";
import { loadModel } from "./load";
import { LinkGraph, fqnOf } from "./link-graph";
import { CoverageTracker } from "./coverage";
import type { CoverageReport } from "./coverage";
import { harvestComments } from "./yaml-comments";
import { buildIndexPage } from "./builders/index-data";
import type { CoreConfig } from "./builders/index-data";
import { buildPackagePage } from "./builders/package-data";
import { buildObjectPage } from "./builders/object-data";
import { buildPromptPage } from "./builders/prompt-data";
import { buildOutputPage } from "./builders/output-data";
import { buildEnumsPage, findAnomalies, buildSearchIndex } from "./builders/extras";
import type { Anomaly } from "./builders/extras";
import { checkLinks } from "./link-check";
import { legendHtml, esc as escBadge } from "./badges";
import type { ObjectPageData } from "./builders/object-data";
import type { PromptPageData } from "./builders/prompt-data";
import type { OutputPageData } from "./builders/output-data";

// ─── Public API ────────────────────────────────────────────────────────────────

export interface SiteOptions {
  sourceDirs: string[];
  outDir: string;
  title: string;
  stamp: string;
  commit: string;
  core?: CoreConfig;
  /** Override dir; if a file of the same basename exists here, it wins over the bundled templates/ dir. */
  templatesDir?: string;
  /** Override dir for assets; if a file of the same basename exists here, it wins over the bundled assets/ dir. */
  assetsDir?: string | undefined;
}

export interface SiteResult {
  pages: string[];
  coverage: CoverageReport;
  anomalies: Anomaly[];
  dangling: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Relative-root prefix: "" for root pages, "../../" for depth-2 pages. */
function relRootFor(href: string): string {
  const depth = href.split("/").length - 1;
  return "../".repeat(depth);
}

/** Write a file, creating parent dirs as needed. */
function writeOut(outDir: string, relPath: string, content: string | Uint8Array): string {
  const abs = join(outDir, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return relPath;
}

// ─── Template loading ──────────────────────────────────────────────────────────

const BUNDLED_TEMPLATES = resolve(import.meta.dir, "../templates");

function loadTemplate(name: string, overrideDir?: string): string {
  if (overrideDir) {
    const candidate = join(overrideDir, name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return readFileSync(join(BUNDLED_TEMPLATES, name), "utf8");
}

const BUNDLED_ASSETS = resolve(import.meta.dir, "../assets");

function loadAsset(name: string, overrideDir?: string): string {
  if (overrideDir) {
    const candidate = join(overrideDir, name);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
  }
  return readFileSync(join(BUNDLED_ASSETS, name), "utf8");
}

// ─── Nav HTML ─────────────────────────────────────────────────────────────────

/**
 * Build the sidebar nav HTML for a specific page as a collapsible tree.
 * Each package is a <details> element (open if it's the current page's package).
 * Members are listed as links within each package. Deterministic: sorted packages, sorted members.
 */
function buildNavHtml(
  g: LinkGraph,
  relRoot: string,
  currentPkgPath: string,
  dataPackages: { pkg: string; pkgPath: string }[],
  promptPackages: { pkg: string; pkgPath: string }[],
): string {
  const nodes = g.nodes();

  const renderGroup = (label: string, pkgList: { pkg: string; pkgPath: string }[]): string => {
    if (pkgList.length === 0) return "";
    const parts: string[] = [`<div class="text-xs font-semibold opacity-50 mt-3 mb-1">${label}</div>`];
    for (const p of pkgList) {
      const isOpen = p.pkgPath === currentPkgPath;
      const pkgHref = escBadge(relRoot + p.pkgPath + "/index.html");
      const pkgLabel = escBadge(p.pkg);
      const members = nodes
        .filter((n) => n.pkg === p.pkg)
        .sort((a, b) => a.name.localeCompare(b.name));
      const memberLinks = members.map((m) =>
        `<a href="${escBadge(relRoot + m.href)}" class="link font-mono text-xs opacity-70 hover:opacity-100 pl-3 block">${escBadge(m.name)}</a>`
      ).join("\n");
      parts.push(
        `<details${isOpen ? " open" : ""}>\n` +
        `<summary class="cursor-pointer font-mono text-xs opacity-70 hover:opacity-100"><a href="${pkgHref}">${pkgLabel}</a></summary>\n` +
        memberLinks + `\n</details>`
      );
    }
    return parts.join("\n");
  };

  return [
    renderGroup("Data", dataPackages),
    renderGroup("Prompts", promptPackages),
  ].filter(Boolean).join("\n");
}

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export async function generateSite(opts: SiteOptions): Promise<SiteResult> {
  // 1. Load + graph + comments
  const loaded = await loadModel(opts.sourceDirs);
  const g = new LinkGraph(loaded);
  const docs = harvestComments(opts.sourceDirs);
  const cov = new CoverageTracker();

  // 2. Derive package lists (deterministic sort)
  const nodes = g.nodes();
  const allPkgs = [...new Set(nodes.map((n) => n.pkg))].sort();
  const promptPkgSet = new Set(nodes.filter((n) => n.kind !== "object").map((n) => n.pkg));
  const dataPkgList = allPkgs
    .filter((p) => !promptPkgSet.has(p))
    .map((p) => ({ pkg: p, pkgPath: p.split("::").join("/") }));
  const promptPkgList = allPkgs
    .filter((p) => promptPkgSet.has(p))
    .map((p) => ({ pkg: p, pkgPath: p.split("::").join("/") }));

  // 3. Load chrome templates (fixed)
  const chromeHead = loadTemplate("chrome-head.mustache", opts.templatesDir);
  const chromeFoot = loadTemplate("chrome-foot.mustache", opts.templatesDir);

  // 4. Rendering helper: concat chrome + page template, render with payload + shared fields
  const provider = new InMemoryProvider({});
  const pages: string[] = [];

  const legend = legendHtml();

  // TOC builders — only list sections with non-empty data; ids must match id="s-..." in templates
  const objectTocHtml = (d: ObjectPageData): string => {
    const sections: { id: string; label: string; present: boolean }[] = [
      { id: "s-overview", label: "Overview", present: !!d.desc },
      { id: "s-fields", label: "Fields", present: d.ownFields.length > 0 },
      { id: "s-indexes", label: "Indexes &amp; keys", present: d.indexes.length > 0 },
      { id: "s-validators", label: "Validators", present: d.validators.length > 0 },
      { id: "s-relationships", label: "Relationships", present: d.relations.length > 0 },
      { id: "s-provenance", label: "Field provenance", present: d.origins.length > 0 },
      { id: "s-inheritance", label: "Inheritance", present: !!d.inheritanceMermaid },
      { id: "s-neighborhood", label: "Neighborhood", present: !!d.neighborhoodMermaid },
      { id: "s-referenced-by", label: "Referenced by", present: d.referencedBy.length > 0 },
    ];
    return sections
      .filter((s) => s.present)
      .map((s) => `<a href="#${s.id}" class="link opacity-70 hover:opacity-100">${s.label}</a>`)
      .join("\n");
  };

  const promptTocHtml = (d: PromptPageData): string => {
    const sections: { id: string; label: string; present: boolean }[] = [
      { id: "s-payload", label: "Payload tree", present: d.payloadTree.length > 0 },
      { id: "s-source", label: "Source", present: !!d.sourceHtml },
    ];
    return sections
      .filter((s) => s.present)
      .map((s) => `<a href="#${s.id}" class="link opacity-70 hover:opacity-100">${s.label}</a>`)
      .join("\n");
  };

  const outputTocHtml = (d: OutputPageData): string => {
    const sections: { id: string; label: string; present: boolean }[] = [
      { id: "s-contract", label: "Parse contract", present: d.fields.length > 0 },
    ];
    return sections
      .filter((s) => s.present)
      .map((s) => `<a href="#${s.id}" class="link opacity-70 hover:opacity-100">${s.label}</a>`)
      .join("\n");
  };

  const renderPage = (
    pageTemplateName: string,
    href: string,
    pageData: Record<string, unknown>,
    tocHtml: string = "",
    currentPkgPath: string = "",
  ): void => {
    const relRoot = relRootFor(href);
    const navHtml = buildNavHtml(g, relRoot, currentPkgPath, dataPkgList, promptPkgList);
    const pageTpl = loadTemplate(pageTemplateName, opts.templatesDir);
    const template = chromeHead + pageTpl + chromeFoot;
    const payload = {
      ...pageData,
      title: opts.title,
      stamp: opts.stamp,
      commit: opts.commit,
      relRoot,
      navHtml,
      tocHtml,
      legendHtml: legend,
    };
    const html = render({ template, payload, provider, format: "text" });
    writeOut(opts.outDir, href, html);
    pages.push(href);
  };

  // 5. Index page
  const indexData = buildIndexPage(g, cov, {
    title: opts.title,
    stamp: opts.stamp,
    commit: opts.commit,
    core: opts.core,
    sourceDirs: opts.sourceDirs,
  });
  renderPage("index.html.mustache", "index.html", indexData as unknown as Record<string, unknown>);

  // 6. Enums page
  const enumRows = buildEnumsPage(g);
  renderPage("enums.html.mustache", "enums.html", { rows: enumRows } as Record<string, unknown>);

  // 7. Anomalies + coverage (deferred until all pages built — build now, write after member pages)
  const anomalies = findAnomalies(g, opts.sourceDirs);

  // 8. Package + member pages (deterministic: pkgs sorted, then members sorted)
  for (const pkg of allPkgs) {
    const pkgData = buildPackagePage(pkg, g, cov, opts.sourceDirs);
    const pkgHref = `${pkgData.pkgPath}/index.html`;
    renderPage("package.html.mustache", pkgHref, pkgData as unknown as Record<string, unknown>, "", pkgData.pkgPath);

    // Member pages sorted by name
    const pkgNodes = nodes.filter((n) => n.pkg === pkg).sort((a, b) => a.name.localeCompare(b.name));
    for (const n of pkgNodes) {
      const fqn = fqnOf(n.node);
      const pkgPath = n.pkgPath;
      if (n.kind === "object") {
        const data = buildObjectPage(fqn, g, cov);
        renderPage("object.html.mustache", n.href, data as unknown as Record<string, unknown>, objectTocHtml(data), pkgPath);
      } else if (n.kind === "prompt") {
        const data = buildPromptPage(fqn, g, cov, opts.sourceDirs);
        renderPage("prompt.html.mustache", n.href, data as unknown as Record<string, unknown>, promptTocHtml(data), pkgPath);
      } else if (n.kind === "output") {
        const data = buildOutputPage(fqn, g, cov, docs, opts.sourceDirs);
        renderPage("output.html.mustache", n.href, data as unknown as Record<string, unknown>, outputTocHtml(data), pkgPath);
      }
    }
  }

  // 9. Coverage page (after all member pages so cov is fully populated)
  const coverage = cov.report(loaded.root);
  const coverageData = {
    kinds: coverage.kinds,
    attrs: coverage.attrs,
    anomalies,
  };
  renderPage("coverage.html.mustache", "coverage.html", coverageData as Record<string, unknown>);

  // 10. Write assets (consumer assetsDir wins over the bundled dir)
  writeOut(opts.outDir, "assets/site.css", loadAsset("site.css", opts.assetsDir));
  writeOut(opts.outDir, "assets/site.js", loadAsset("site.js", opts.assetsDir));

  // 11. Search index
  const searchIndex = buildSearchIndex(g);
  writeOut(opts.outDir, "assets/search-index.json", JSON.stringify(searchIndex));

  // 12. Link check (throws if any dangling links found)
  const dangling = checkLinks(opts.outDir, pages);
  if (dangling.length) throw new Error("link check failed:\n" + dangling.join("\n"));

  return { pages, coverage, anomalies, dangling };
}
