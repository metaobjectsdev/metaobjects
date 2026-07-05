import { LinkGraph, fqnOf } from "../link-graph.js";
import type { CoverageTracker } from "../coverage.js";
import { flowchartDomain, packageFlowchart } from "../mermaid.js";
import { harvestPackageDocs } from "../package-docs.js";
import { esc } from "../badges.js";

export interface PkgCard { pkg: string; href: string; objectCount: number; promptCount: number; contractCount: number; purpose: string; }
export interface CoreConfig { pin?: string[]; exclude?: string[]; n?: number; }
export interface IndexPageData { title: string; stamp: string; commit: string; stats: { objects: number; tables: number; packages: number; promptVos: number; prompts: number; contracts: number; enums: number }; coreMermaid: string; coreCaption: string; coreLegend: { pkg: string; fill: string; stroke: string }[]; packageMermaid: string; fullEdges: { from: string; to: string; n: number }[]; dataPackages: PkgCard[]; promptPackages: PkgCard[]; }

export function buildIndexPage(g: LinkGraph, cov: CoverageTracker, opts: { title: string; stamp: string; commit: string; core?: CoreConfig | undefined; sourceDirs?: string[] | undefined }): IndexPageData {
  const objs = g.nodes().filter((n) => n.kind === "object");
  const tpls = g.nodes().filter((n) => n.kind !== "object");
  const pkgs = [...new Set(g.nodes().map((n) => n.pkg))].sort();
  const promptPkgSet = new Set(tpls.map((t) => t.pkg));
  const shortPkg = (p: string) => p.split("::").pop()!;
  // core map = a CONNECTED cluster of the most-connected objects of ALL kinds (entities, projections,
  // value objects), traversing every edge type (fk, field.object, origin, extends, relationship).
  // Seed by total degree, pull in the seeds' neighbors so nothing dangles, cap the total, drop isolates.
  const CORE_MAX = opts.core?.n ?? 28;
  const excluded = new Set(opts.core?.exclude ?? []);
  const degOf = (fqn: string) => g.refsFrom(fqn).length + g.refsTo(fqn).length;
  // seed a BALANCED mix so all object kinds appear (payload VOs otherwise dominate by degree):
  // top entities (data-model backbone) + top value objects (payload structure) + projections (views).
  const topByType = (st: string, k: number) => objs.filter((n) => !n.node.isAbstract && n.node.subType === st && !excluded.has(fqnOf(n.node)))
    .map((dn) => ({ dn, fqn: fqnOf(dn.node), deg: degOf(fqnOf(dn.node)) }))
    .sort((a, b) => b.deg - a.deg || a.dn.name.localeCompare(b.dn.name)).slice(0, k);
  const seeds = [...topByType("entity", 8), ...topByType("value", 5), ...topByType("projection", 3)];
  const shown = new Map<string, (typeof seeds)[0]["dn"]>();
  // pinned objects are force-included (author override), never excluded.
  for (const f of opts.core?.pin ?? []) {
    if (excluded.has(f)) continue;
    const dn = g.byFqn(f); if (dn && dn.kind === "object") shown.set(f, dn);
  }
  for (const s of seeds) { if (shown.size >= CORE_MAX) break; if (!shown.has(s.fqn)) shown.set(s.fqn, s.dn); }
  // rank candidate neighbors by how many shown nodes touch them, add until the cap
  const cand = new Map<string, number>();
  for (const f of shown.keys()) {
    for (const e of g.refsFrom(f)) cand.set(e.to, (cand.get(e.to) ?? 0) + 1);
    for (const e of g.refsTo(f)) cand.set(e.from, (cand.get(e.from) ?? 0) + 1);
  }
  for (const [f] of [...cand.entries()].filter(([f]) => !shown.has(f) && !excluded.has(f)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (shown.size >= CORE_MAX) break;
    const dn = g.byFqn(f); if (dn && dn.kind === "object") shown.set(f, dn);
  }
  // edges among the shown set — collapse parallel edges between a pair to ONE unlabeled edge
  // (a projection can join a source object on 6-12 fields; the overview only needs the connection).
  const heroEdges: { from: string; to: string; label: string; style?: "dashed" }[] = [];
  const seenEdge = new Set<string>();
  for (const [f, dn] of shown) for (const e of g.refsFrom(f)) if (shown.has(e.to)) {
    const to = g.byFqn(e.to)!.name;
    const key = `${dn.name}|${to}`;
    if (!seenEdge.has(key)) { seenEdge.add(key); heroEdges.push({ from: dn.name, to, label: "", ...(e.cardinality === "many" ? { style: "dashed" as const } : {}) }); }
  }
  const connected = new Set(heroEdges.flatMap((e) => [e.from, e.to]));
  const heroNodes = [...shown.values()].filter((dn) => connected.has(dn.name));
  const hero = flowchartDomain(heroNodes.map((dn) => ({ name: dn.name, pkg: dn.pkg, kind: dn.node.subType })), heroEdges);
  const coreMermaid = hero.mermaid, coreLegend = hero.legend;
  const coreCaption = `${heroNodes.length} of the most-connected objects (entities, views, and payloads), colored by domain.`;
  // package docs for purpose cards
  const pdocs = harvestPackageDocs(opts.sourceDirs ?? []);
  // package edges
  const pkgEdges = new Map<string, number>();
  for (const o of objs) for (const r of g.refsFrom(fqnOf(o.node))) {
    if (r.kind === "extends") continue;
    const t = g.byFqn(r.to); if (!t || t.pkg === o.pkg) continue;
    const k = `${shortPkg(o.pkg)}→${shortPkg(t.pkg)}`; pkgEdges.set(k, (pkgEdges.get(k) ?? 0) + 1);
  }
  const fullEdges = [...pkgEdges.entries()].sort().map(([k, n]) => { const [from = "", to = ""] = k.split("→"); return { from, to, n }; });
  const counts = new Map<string, number>(); for (const o of objs) counts.set(shortPkg(o.pkg), (counts.get(shortPkg(o.pkg)) ?? 0) + 1);
  const card = (p: string): PkgCard => {
    const doc = pdocs.get(p);
    const purpose = esc((doc?.title ? doc.title + " — " : "") + (doc?.description ?? "")).slice(0, 160);
    return { pkg: p, href: `${p.split("::").join("/")}/index.html`,
      objectCount: objs.filter((o) => o.pkg === p).length,
      promptCount: tpls.filter((t) => t.pkg === p && t.kind === "prompt").length,
      contractCount: tpls.filter((t) => t.pkg === p && t.kind === "output").length,
      purpose };
  };
  const enums = objs.reduce((n, o) => n + o.node.childrenOfType("field").filter((f) => Array.isArray(f.attr("values"))).length, 0);
  return { title: opts.title, stamp: opts.stamp, commit: opts.commit,
    stats: { objects: objs.length,
      tables: objs.filter((o) => o.node.childrenOfType("source").length > 0).length,
      packages: pkgs.length,
      promptVos: objs.filter((o) => promptPkgSet.has(o.pkg)).length,
      prompts: tpls.filter((t) => t.kind === "prompt").length,
      contracts: tpls.filter((t) => t.kind === "output").length, enums },
    coreMermaid,
    coreCaption,
    coreLegend,
    packageMermaid: packageFlowchart(fullEdges.filter((e) => e.n >= 2), counts),
    fullEdges,
    dataPackages: pkgs.filter((p) => !promptPkgSet.has(p)).map(card),
    promptPackages: pkgs.filter((p) => promptPkgSet.has(p)).map(card) };
}
