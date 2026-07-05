import type { MetaData } from "@metaobjectsdev/metadata";
import { LinkGraph, fqnOf } from "../link-graph.js";
import type { CoverageTracker } from "../coverage.js";
import { esc } from "../badges.js";
import { erDiagramRich, flowchartDomain, domainColor, RICH_MAX, type ErEdge, type ErAttr, type ErNode } from "../mermaid.js";
import { harvestPackageDocs, keyEntities } from "../package-docs.js";

// capped box attributes for the rich package ERD: PK → FKs(target) → enums → required, ≤6 + overflow count
// (mirrors neighborAttrs in object-data.ts — kept local to avoid cross-builder coupling)
function pkgAttrs(o: MetaData): { attrs: ErAttr[]; more: number } {
  const pk = new Set<string>(), fk = new Map<string, string>();
  for (const id of o.childrenOfType("identity")) {
    const flds = id.attr("fields");
    const names = Array.isArray(flds) ? flds.map(String) : flds !== undefined ? [String(flds)] : [];
    if (id.subType === "primary") names.forEach((n) => pk.add(n));
    if (id.subType === "reference") { const tgt = String(id.attr("references") ?? "").split("::").pop() ?? ""; names.forEach((n) => fk.set(n, tgt)); }
  }
  const fields = o.childrenOfType("field");
  const isEnum = (f: MetaData) => Array.isArray(f.attr("values"));
  const isReq = (f: MetaData) => f.attr("required") === true || f.attr("required") === "true";
  const attrs: ErAttr[] = []; const seen = new Set<string>();
  const push = (f: MetaData, key: ErAttr["key"], note: string) => { if (seen.has(f.name) || attrs.length >= 6) return; seen.add(f.name); attrs.push({ type: f.subType, name: f.name, key, note }); };
  for (const f of fields) if (pk.has(f.name)) push(f, "PK", "");
  for (const f of fields) if (fk.has(f.name)) push(f, "FK", fk.get(f.name)!);
  for (const f of fields) if (isEnum(f)) push(f, "", "enum");
  for (const f of fields) if (isReq(f)) push(f, "", "req");
  const relevant = fields.filter((f) => pk.has(f.name) || fk.has(f.name) || isEnum(f) || isReq(f)).length;
  return { attrs, more: Math.max(0, relevant - attrs.length) };
}

export interface ObjRow { name: string; href: string; kind: string; table: string; fieldCount: number; extendsName: string; }
export interface TplRow { name: string; href: string; payloadName: string; payloadHref: string; format: string; textRef: string; }
export interface PackagePageData {
  pkg: string; pkgPath: string; tree: string; breadcrumbHtml: string;
  title: string; descHtml: string;
  keyCards: { name: string; href: string; inbound: number }[];
  erdMermaid: string; erdLegend: { pkg: string; fill: string; stroke: string }[];
  abstracts: ObjRow[]; objects: ObjRow[]; prompts: TplRow[]; outputs: TplRow[];
  referencedBy: { pkg: string; href: string; n: number }[];
}

export function buildPackagePage(pkg: string, g: LinkGraph, cov: CoverageTracker, sourceDirs?: string[]): PackagePageData {
  const dirs = sourceDirs ?? [];
  const members = g.nodes().filter((n) => n.pkg === pkg);
  const pageHref = `${members[0]!.pkgPath}/index.html`;
  const objRow = (n: (typeof members)[0]): ObjRow => ({
    name: n.name, href: `${n.name}.html`, kind: n.node.subType,
    table: String(n.node.childrenOfType("source").map((s) => s.attr("table")).find((t) => t !== undefined) ?? ""),
    fieldCount: n.node.childrenOfType("field").length,
    extendsName: n.node.superResolved?.name ?? "",
  });
  const tplRow = (n: (typeof members)[0]): TplRow => {
    cov.consumeNode(n.node); cov.consumeAttr(n.node, "payloadRef"); cov.consumeAttr(n.node, "textRef"); cov.consumeAttr(n.node, "format");
    const p = g.refsFrom(fqnOf(n.node)).find((r) => r.kind === "payload");
    const pt = p ? g.byFqn(p.to) : undefined;
    return { name: n.name, href: `${n.name}.html`, payloadName: pt?.name ?? String(n.node.attr("payloadRef") ?? ""), payloadHref: pt ? g.relHref(pageHref, pt.href) : "", format: String(n.node.attr("format") ?? "text"), textRef: String(n.node.attr("textRef") ?? "") };
  };
  const objs = members.filter((m) => m.kind === "object");
  const abstracts = objs.filter((m) => m.node.isAbstract).map(objRow).sort((a, b) => a.name.localeCompare(b.name));
  const objects = objs.filter((m) => !m.node.isAbstract).map(objRow).sort((a, b) => a.name.localeCompare(b.name));
  const prompts = members.filter((m) => m.kind === "prompt").map(tplRow).sort((a, b) => a.name.localeCompare(b.name));
  const outputs = members.filter((m) => m.kind === "output").map(tplRow).sort((a, b) => a.name.localeCompare(b.name));

  // authored prose + key-entity cards
  const pd = harvestPackageDocs(dirs).get(pkg);
  const title = esc(pd?.title ?? pkg.split("::").pop() ?? pkg);
  const descHtml = esc(pd?.description ?? "");
  const keyCards = keyEntities(pkg, g).map((k) => ({ name: k.name, href: g.relHref(pageHref, k.href), inbound: k.inbound }));

  // package ERD — collect internal objects + external neighbor objects + edges
  const extNodes = new Map<string, typeof members[0]>();
  const erdEdges: ErEdge[] = [];
  for (const m of objs) {
    for (const r of g.refsFrom(fqnOf(m.node))) {
      if (r.kind === "extends") continue;
      const t = g.byFqn(r.to); if (!t || t.kind !== "object") continue;
      erdEdges.push({ parent: t.name, child: m.name, label: r.via });
      if (t.pkg !== pkg) extNodes.set(r.to, t);
    }
    for (const r of g.refsTo(fqnOf(m.node))) {
      if (r.kind === "extends") continue;
      const s = g.byFqn(r.from); if (!s || s.kind !== "object" || s.pkg === pkg) continue;
      erdEdges.push({ parent: m.name, child: s.name, label: r.via });
      extNodes.set(r.from, s);
    }
  }
  // deduplicate edges
  const deduped = erdEdges.filter((e, i) => erdEdges.findIndex((x) => x.parent === e.parent && x.child === e.child && x.label === e.label) === i);

  // mode switch: rich (≤RICH_MAX) vs domain flowchart (large)
  const totalNodes = objs.length + extNodes.size;
  let erdMermaid: string;
  let erdLegend: { pkg: string; fill: string; stroke: string }[] = [];
  if (totalNodes <= RICH_MAX) {
    const erNodes: ErNode[] = [
      ...objs.map((m) => { const { attrs, more } = pkgAttrs(m.node); return { name: m.name, pkg: m.pkg, role: "normal" as ErNode["role"], kind: m.node.subType, attrs, more }; }),
      ...[...extNodes.values()].map((m) => { const { attrs, more } = pkgAttrs(m.node); return { name: m.name, pkg: m.pkg, role: "external" as ErNode["role"], kind: m.node.subType, attrs, more }; }),
    ];
    erdMermaid = erDiagramRich(erNodes, deduped);
    // build legend from unique packages
    const pkgsSeen = new Map<string, typeof erdLegend[0]>();
    for (const n of erNodes) {
      if (!pkgsSeen.has(n.pkg)) {
        const dc = domainColor(n.pkg);
        pkgsSeen.set(n.pkg, { pkg: n.pkg, fill: dc.fill, stroke: dc.stroke });
      }
    }
    erdLegend = [...pkgsSeen.values()].sort((a, b) => a.pkg.localeCompare(b.pkg));
  } else {
    const flowNodes = [
      ...objs.map((m) => ({ name: m.name, pkg: m.pkg, kind: m.node.subType })),
      ...[...extNodes.values()].map((m) => ({ name: m.name, pkg: m.pkg, kind: m.node.subType })),
    ];
    const r = flowchartDomain(flowNodes, deduped.map((e) => ({ from: e.parent, to: e.child, label: e.label })));
    erdMermaid = r.mermaid;
    erdLegend = r.legend;
  }

  // inbound package backlinks
  const inbound = new Map<string, number>();
  for (const m of objs) for (const r of g.refsTo(fqnOf(m.node))) {
    const s = g.byFqn(r.from);
    if (s && s.pkg !== pkg && r.kind !== "extends") inbound.set(s.pkg, (inbound.get(s.pkg) ?? 0) + 1);
  }
  const referencedBy = [...inbound.entries()].sort().map(([p, n]) => ({ pkg: p, href: g.relHref(pageHref, `${p.split("::").join("/")}/index.html`), n }));

  return {
    pkg, pkgPath: members[0]!.pkgPath, tree: members[0]!.tree,
    breadcrumbHtml: `<a href="${g.relHref(pageHref, "index.html")}">index</a> / ${esc(pkg)}`,
    title, descHtml, keyCards,
    erdMermaid, erdLegend,
    abstracts, objects, prompts, outputs, referencedBy,
  };
}
