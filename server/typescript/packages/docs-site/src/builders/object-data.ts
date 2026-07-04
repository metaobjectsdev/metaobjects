import type { MetaData } from "@metaobjectsdev/metadata";
import { LinkGraph, fqnOf, type Ref } from "../link-graph";
import type { CoverageTracker } from "../coverage";
import { esc, badge } from "../badges";
import { inheritanceTree, erDiagramRich, flowchartDomain, RICH_MAX, type ErEdge, type ErNode, type ErAttr } from "../mermaid";

// capped box attributes for the rich neighborhood ERD: PK → FKs(target) → enums → required, ≤6 + overflow count
function neighborAttrs(o: MetaData): { attrs: ErAttr[]; more: number } {
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

export interface EnumValue { value: string; deflt: boolean; desc: string; }
export interface FieldRow { name: string; type: string; isArray: boolean; required: boolean; badgesHtml: string; desc: string; enumValues: EnumValue[]; refHref?: string | undefined; refName?: string | undefined; inheritedFrom?: { name: string; href: string } | undefined; anchor: string; }
export interface IndexRow { name: string; kind: string; fields: string; extra: string; unique: boolean; }
export interface ValidatorRow { scope: "field" | "object"; subject: string; rule: string; // human-readable, HTML-escaped
}
export interface RelationRow { name: string; toName: string; toHref: string; cardinality: string; }
export interface OriginRow { field: string; from: string; via: string; }
export interface HierRow { name: string; href: string; level: number; self: boolean; }
export interface ObjectPageData {
  name: string; kindBadge: string; isAbstract: boolean; isView: boolean; generation: string;
  pkg: string; href: string; breadcrumbHtml: string; desc: string; tableName?: string | undefined; pkHtml?: string | undefined;
  ownFields: FieldRow[]; inheritedFields: FieldRow[]; indexes: IndexRow[]; validators: ValidatorRow[];
  relations: RelationRow[]; origins: OriginRow[]; hierarchy: HierRow[]; inheritanceMermaid?: string | undefined;
  neighborhoodMermaid?: string | undefined; neighborhoodLegend?: { pkg: string; fill: string; stroke: string }[] | undefined; neighborhoodMore?: number | undefined;
  referencedBy: { name: string; href: string; via: string }[];
  references: { name: string; href: string; via: string }[]; usedByTemplates: { name: string; href: string }[];
  sourceFile: string;
}

function fieldRow(f: MetaData, ownerHref: string, g: LinkGraph, cov: CoverageTracker, ctxPkg: string): FieldRow {
  cov.consumeNode(f);
  const a = (n: string) => { const v = f.attr(n); if (v !== undefined) cov.consumeAttr(f, n); return v; };
  const bits: string[] = [];
  const reqVal = a("required"); const required = reqVal === true || reqVal === "true";
  if (required) bits.push(badge({ text: "required", cls: "badge-soft badge-error" }));
  if (a("deprecated") !== undefined) bits.push(badge({ text: "deprecated", cls: "badge-soft badge-warning" }));
  const len = a("maxLength"); if (len !== undefined) bits.push(badge({ text: `≤${len}`, cls: "badge-soft badge-neutral" }));
  const dbt = a("dbColumnType"); if (dbt !== undefined) bits.push(badge({ text: String(dbt), cls: "badge-soft badge-neutral" }));
  const def = a("default"); if (def !== undefined) bits.push(badge({ text: `default ${def}`, cls: "badge-soft badge-neutral" }));
  if (a("xmlText") !== undefined) bits.push(badge({ text: "@xmlText", cls: "badge-soft badge-neutral" }));
  // enum values as data (rendered per-value in the template)
  const valuesAttr = a("values");
  const enumValues: EnumValue[] = Array.isArray(valuesAttr)
    ? valuesAttr.map((v) => ({ value: esc(String(v)), deflt: String(def ?? "") === String(v), desc: "" }))
    : [];
  if (enumValues.length) bits.push(badge({ text: "enum", cls: "badge-soft badge-accent" }));
  // field-level validators as badges
  for (const v of f.childrenOfType("validator")) {
    cov.consumeNode(v);
    if (v.subType === "regex") { cov.consumeAttr(v, "pattern"); bits.push(badge({ text: `regex ${v.attr("pattern")}`, cls: "badge-soft badge-neutral" })); }
    if (v.subType === "numeric") {
      const mm = ["min", "max"].filter((k) => v.attr(k) !== undefined).map((k) => { cov.consumeAttr(v, k); return `${k}=${v.attr(k)}`; });
      if (mm.length) bits.push(badge({ text: mm.join(" "), cls: "badge-soft badge-neutral" }));
    }
  }
  // reference vs containment badge. A field of subType `object` with an objectRef CONTAINS a nested
  // object (composition); a scalar field with an objectRef REFERENCES another object by id.
  let refHref: string | undefined, refName: string | undefined;
  const oref = a("objectRef");
  if (typeof oref === "string") {
    const t = g.byFqn(oref.includes("::") ? oref : `${ctxPkg}::${oref}`) ?? g.byFqn(oref);
    if (t) {
      refHref = g.relHref(ownerHref, t.href); refName = t.name;
      const contains = f.subType === "object";
      bits.push(badge({
        text: contains ? `⊃ ${t.name}` : `→ ${t.name}`,
        cls: contains ? "badge-soft badge-secondary" : "badge-soft badge-info",
        href: refHref,
        title: contains ? "contains (nested object)" : "reference",
      }));
    }
  }
  const desc = esc(a("description") ?? "");
  return { name: f.name, type: f.subType, isArray: f.resolvedIsArray(), required, badgesHtml: bits.join(" "), desc, enumValues, refHref, refName, inheritedFrom: undefined, anchor: `f-${f.name}` };
}

// Neighborhood edge label: relationship edges show their name + (M:N) junction + onDelete; extends/others show via.
function edgeLabelFor(r: Ref): string {
  if (r.kind === "extends") return "extends";
  if (r.kind === "relationship") {
    const junction = r.through ? ` · M:N via ${r.through.split("::").pop()}` : "";
    const od = r.onDelete ? ` · ${r.onDelete}` : "";
    return `${r.via}${junction}${od}`;
  }
  return r.via;
}

export function buildObjectPage(fqn: string, g: LinkGraph, cov: CoverageTracker): ObjectPageData {
  const dn = g.byFqn(fqn);
  if (!dn || dn.kind !== "object") throw new Error(`not an object: ${fqn}`);
  const o = dn.node;
  cov.consumeNode(o);
  cov.consumeAttr(o, "description");

  // inheritance hierarchy rows (ancestors nearest-last so level increases downward) + self + direct children
  const anc = g.ancestors(fqn);            // nearest-first
  const hierarchy: HierRow[] = [];
  anc.slice().reverse().forEach((n, i) => hierarchy.push({ name: n.name, href: g.relHref(dn.href, n.href), level: i, self: false }));
  const selfLevel = anc.length;
  hierarchy.push({ name: dn.name, href: "", level: selfLevel, self: true });
  const kids = g.extendedBy(fqn).slice().sort((a, b) => a.name.localeCompare(b.name));
  for (const k of kids) hierarchy.push({ name: k.name, href: g.relHref(dn.href, k.href), level: selfLevel + 1, self: false });
  const inheritanceMermaid = hierarchy.length > 1
    ? inheritanceTree(hierarchy.map((h) => ({ name: h.name, level: h.level, self: h.self }))) : undefined;

  // storage: table vs view, generation, pk
  let tableName: string | undefined, isView = false, pkHtml: string | undefined, generation = "";
  for (const s of o.childrenOfType("source")) {
    cov.consumeNode(s);
    const t = s.attr("table"); if (t !== undefined) { cov.consumeAttr(s, "table"); tableName = String(t); }
    const kind = s.attr("kind"); if (kind !== undefined) { cov.consumeAttr(s, "kind"); if (String(kind) === "view") isView = true; }
  }
  // indexes: identity (pk/secondary) + index.lookup with tuning detail
  const indexes: IndexRow[] = [];
  for (const id of o.childrenOfType("identity")) {
    cov.consumeNode(id);
    const flds = id.attr("fields"); if (flds !== undefined) cov.consumeAttr(id, "fields");
    const fields = Array.isArray(flds) ? flds.join(", ") : String(flds ?? "");
    if (id.subType === "primary") {
      pkHtml = `<code>${esc(fields)}</code>`;
      const gen = id.attr("generation"); if (gen !== undefined) { cov.consumeAttr(id, "generation"); generation = String(gen); }
      indexes.push({ name: id.name, kind: "primary", fields, extra: "", unique: true });
    } else if (id.subType === "secondary") {
      indexes.push({ name: id.name, kind: "unique", fields, extra: "", unique: true });
    } else if (id.subType === "reference") {
      const ref = id.attr("references"); if (ref !== undefined) cov.consumeAttr(id, "references");
      const enf = id.attr("enforce"); if (enf !== undefined) cov.consumeAttr(id, "enforce");
      indexes.push({ name: id.name, kind: "fk", fields, extra: [ref ? `→ ${esc(String(ref))}` : "", enf === false || enf === "false" ? "logical" : ""].filter(Boolean).join(" · "), unique: false });
    }
  }
  for (const ix of o.childrenOfType("index")) {
    cov.consumeNode(ix);
    const flds = ix.attr("fields"); if (flds !== undefined) cov.consumeAttr(ix, "fields");
    const fields = Array.isArray(flds) ? flds.join(", ") : String(flds ?? "");
    const extras: string[] = [];
    for (const k of ["orders", "where", "expr", "using"]) {
      const v = ix.attr(k); if (v !== undefined) { cov.consumeAttr(ix, k); extras.push(esc(`${k} ${Array.isArray(v) ? v.join(",") : v}`)); }
    }
    const uniq = ix.attr("unique"); if (uniq !== undefined) cov.consumeAttr(ix, "unique");
    indexes.push({ name: ix.name, kind: "index", fields, extra: extras.join(" · "), unique: uniq === true || uniq === "true" });
  }
  indexes.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));

  // validators: field-level shown as badges already; collect OBJECT-level here
  const validators: ValidatorRow[] = [];
  for (const v of o.childrenOfType("validator")) {
    cov.consumeNode(v);
    const at = (k: string) => { const x = v.attr(k); if (x !== undefined) cov.consumeAttr(v, k); return x; };
    let rule = "";
    if (v.subType === "comparison") rule = `${esc(String(at("left") ?? ""))} ${esc(String(at("op") ?? ""))} ${esc(String(at("right") ?? ""))}`;
    else if (v.subType === "requiredWhen") rule = `${esc(String(at("field") ?? ""))} required when ${esc(String(at("when") ?? ""))} = ${esc(String(at("equals") ?? ""))}`;
    else if (v.subType === "presentIff") rule = `${esc(String(at("field") ?? ""))} present iff ${esc(String(at("when") ?? ""))} = ${esc(String(at("equals") ?? ""))}`;
    else if (v.subType === "atLeastOne") { const fs = at("fields"); rule = `at least one of ${esc(Array.isArray(fs) ? fs.map(String).join(", ") : String(fs ?? ""))}`; }
    else rule = esc(v.subType);
    validators.push({ scope: "object", subject: v.name || v.subType, rule });
  }
  validators.sort((a, b) => a.subject.localeCompare(b.subject));

  // relationships
  const relations: RelationRow[] = g.relationshipsOf(fqn).map((r) => {
    const t = g.byFqn(r.toFqn);
    return { name: r.name, toName: t?.name ?? r.toFqn, toHref: t ? g.relHref(dn.href, t.href) : "", cardinality: r.cardinality };
  });
  for (const rel of o.childrenOfType("relationship")) { cov.consumeNode(rel); cov.consumeAttr(rel, "objectRef"); cov.consumeAttr(rel, "cardinality"); }

  // origin provenance
  const origins: OriginRow[] = g.originsOf(fqn).map((r) => ({ field: r.field, from: esc(r.from), via: esc(r.via) }))
    .sort((a, b) => a.field.localeCompare(b.field));
  for (const f of o.childrenOfType("field")) for (const org of f.childrenOfType("origin")) { cov.consumeNode(org); cov.consumeAttr(org, "from"); cov.consumeAttr(org, "via"); }

  // fields own vs inherited
  const ownNames = new Set(o.ownChildren().filter((c) => c.type === "field").map((c) => c.name));
  const ownFields: FieldRow[] = [], inheritedFields: FieldRow[] = [];
  for (const f of o.childrenOfType("field")) {
    const row = fieldRow(f, dn.href, g, cov, dn.pkg);
    if (ownNames.has(f.name)) ownFields.push(row);
    else {
      for (let s = o.superResolved; s; s = s.superResolved) {
        if (s.ownChildren().some((c) => c.type === "field" && c.name === f.name)) {
          const t = g.byFqn(fqnOf(s));
          row.inheritedFrom = t ? { name: t.name, href: g.relHref(dn.href, t.href) } : { name: s.name, href: "#" };
          break;
        }
      }
      inheritedFields.push(row);
    }
  }

  // neighborhood diagram — rich (attrs + domain-fill/role-stroke) when small, simple domain map when large.
  // Cap the neighbor count so hub entities (30+ neighbors) don't produce an unreadable megadiagram;
  // the full set is always available in the Referenced-by / References sections below.
  const NB_MAX = 16;
  // include every traversal kind (fk, field.object, origin, relationship, extends) so projections and
  // value objects are never orphaned; the dedicated Inheritance section still shows the full chain.
  const nbCandidates = new Map<string, { node: typeof dn; edge: ErEdge }>();
  for (const r of g.refsFrom(fqn)) { const t = g.byFqn(r.to); if (t && !nbCandidates.has(r.to)) nbCandidates.set(r.to, { node: t, edge: { parent: t.name, child: dn.name, label: edgeLabelFor(r), cardinality: r.cardinality } }); }
  for (const r of g.refsTo(fqn)) { const s = g.byFqn(r.from); if (s && s.kind === "object" && !nbCandidates.has(r.from)) nbCandidates.set(r.from, { node: s, edge: { parent: dn.name, child: s.name, label: edgeLabelFor(r), cardinality: r.cardinality } }); }
  const sortedNeighbors = [...nbCandidates.entries()].sort(([, a], [, b]) => a.node.name.localeCompare(b.node.name));
  const neighborhoodMore = Math.max(0, sortedNeighbors.length - NB_MAX);
  const nbNodes = new Map<string, typeof dn>(); const nbEdges: ErEdge[] = [];
  nbNodes.set(fqn, dn);
  for (const [k, { node, edge }] of sortedNeighbors.slice(0, NB_MAX)) { nbNodes.set(k, node); nbEdges.push(edge); }
  const roleOf = (n: typeof dn): ErNode["role"] =>
    fqnOf(n.node) === fqn ? "focal"
      : n.node.childrenOfType("source").some((s) => String(s.attr("kind") ?? "") === "view") ? "view"
      : n.pkg !== dn.pkg ? "external" : "normal";
  let neighborhoodMermaid: string | undefined;
  let neighborhoodLegend: { pkg: string; fill: string; stroke: string }[] | undefined;
  if (nbEdges.length > 0) {
    if (nbNodes.size <= RICH_MAX) {
      const erNodes: ErNode[] = [...nbNodes.values()].map((n) => { const { attrs, more } = neighborAttrs(n.node); return { name: n.name, pkg: n.pkg, role: roleOf(n), kind: n.node.subType, attrs, more }; });
      neighborhoodMermaid = erDiagramRich(erNodes, nbEdges);
    } else {
      const r = flowchartDomain([...nbNodes.values()].map((n) => ({ name: n.name, pkg: n.pkg, kind: n.node.subType })), nbEdges.map((e) => ({ from: e.parent, to: e.child, label: e.label, ...(e.cardinality === "many" ? { style: "dashed" as const } : {}) })));
      neighborhoodMermaid = r.mermaid; neighborhoodLegend = r.legend;
    }
  }

  // backlinks / forward refs (non-extends)
  const referencedBy = g.refsTo(fqn).filter((r) => r.kind !== "extends").map((r) => { const s = g.byFqn(r.from)!; return { name: s.name, href: g.relHref(dn.href, s.href), via: r.via }; }).sort((a, b) => a.name.localeCompare(b.name) || a.via.localeCompare(b.via));
  const references = g.refsFrom(fqn).filter((r) => r.kind !== "extends").map((r) => { const t = g.byFqn(r.to)!; return { name: t.name, href: g.relHref(dn.href, t.href), via: r.via }; }).sort((a, b) => a.name.localeCompare(b.name) || a.via.localeCompare(b.via));

  // used-by templates (unchanged BFS)
  const usedByTemplates: { name: string; href: string }[] = [];
  for (const t of g.nodes().filter((n) => n.kind !== "object")) {
    const seen = new Set<string>(); const q = g.refsFrom(fqnOf(t.node)).filter((r) => r.kind === "payload").map((r) => r.to); let hit = false;
    while (q.length && seen.size < 100) { const cur = q.shift()!; if (seen.has(cur)) continue; seen.add(cur); if (cur === fqn) { hit = true; break; } for (const r of g.refsFrom(cur)) if (r.kind === "field") q.push(r.to); }
    if (hit) usedByTemplates.push({ name: t.name, href: g.relHref(dn.href, t.href) });
  }

  const src = (o.source as { files?: string[] }).files?.[0] ?? "";
  const crumbs = [
    `<a href="${esc(g.relHref(dn.href, "index.html"))}">index</a>`,
    `<a href="${esc(g.relHref(dn.href, `${dn.pkgPath}/index.html`))}">${esc(dn.pkg)}</a>`,
    esc(dn.name),
  ];
  return {
    name: dn.name, kindBadge: o.subType, isAbstract: o.isAbstract, isView, generation,
    pkg: dn.pkg, href: dn.href, breadcrumbHtml: crumbs.join(" / "), desc: esc(o.attr("description") ?? ""),
    tableName, pkHtml, ownFields, inheritedFields, indexes, validators, relations, origins,
    hierarchy, inheritanceMermaid, neighborhoodMermaid, neighborhoodLegend, neighborhoodMore, referencedBy, references, usedByTemplates, sourceFile: src,
  };
}
