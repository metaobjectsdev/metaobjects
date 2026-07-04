import { existsSync } from "node:fs";
import { join } from "node:path";
import { LinkGraph, fqnOf } from "../link-graph";

export interface EnumRow { owner: string; ownerHref: string; field: string; values: string[]; deflt: string; }
export function buildEnumsPage(g: LinkGraph): EnumRow[] {
  const rows: EnumRow[] = [];
  for (const o of g.nodes().filter((n) => n.kind === "object")) {
    for (const f of o.node.childrenOfType("field")) {
      const values = f.attr("values");
      if (Array.isArray(values)) rows.push({ owner: o.name, ownerHref: o.href, field: f.name, values: values.map(String), deflt: String(f.attr("default") ?? "") });
    }
  }
  return rows.sort((a, b) => (a.owner + a.field).localeCompare(b.owner + b.field));
}

export interface Anomaly { kind: string; subject: string; href: string; detail: string; }
export function findAnomalies(g: LinkGraph, sourceDirs: string[]): Anomaly[] {
  const out: Anomaly[] = [];
  const objs = g.nodes().filter((n) => n.kind === "object");
  for (const o of objs) {
    const fqn = fqnOf(o.node);
    if (!o.node.isAbstract && g.degree(fqn) === 0) out.push({ kind: "orphan", subject: o.name, href: o.href, detail: "no inbound or outbound references" });
    if (o.node.isAbstract && g.extendedBy(fqn).length === 0) out.push({ kind: "unextended-abstract", subject: o.name, href: o.href, detail: "abstract with no descendants" });
    const fkFields = new Set<string>();
    for (const i of o.node.childrenOfType("identity").filter((i) => i.subType === "reference")) {
      const fv = i.attr("fields");
      const names = Array.isArray(fv) ? fv.map(String) : [String(fv ?? "")];
      for (const n of names) fkFields.add(n);
    }
    for (const f of o.node.childrenOfType("field")) {
      if (/(^|[a-z])Id$/.test(f.name) && (f.subType === "string" || f.subType === "uuid") && f.attr("objectRef") === undefined && !fkFields.has(f.name) && !o.node.isAbstract)
        out.push({ kind: "implied-ref", subject: `${o.name}.${f.name}`, href: `${o.href}#f-${f.name}`, detail: "looks like a reference but declares none" });
    }
  }
  // unreachable payload VOs: object.value not reached from any template payload tree
  const reachable = new Set<string>();
  for (const t of g.nodes().filter((n) => n.kind !== "object")) {
    const q = g.refsFrom(fqnOf(t.node)).filter((r) => r.kind === "payload").map((r) => r.to);
    while (q.length) { const cur = q.shift()!; if (reachable.has(cur)) continue; reachable.add(cur); for (const r of g.refsFrom(cur)) if (r.kind === "field") q.push(r.to); }
  }
  for (const o of objs.filter((o) => o.node.subType === "value" && g.nodes().some((t) => t.kind !== "object" && t.pkg === o.pkg)))
    if (!reachable.has(fqnOf(o.node)) && g.degree(fqnOf(o.node)) === 0)
      out.push({ kind: "unreachable-vo", subject: o.name, href: o.href, detail: "value object not reachable from any template payload" });
  for (const t of g.nodes().filter((n) => n.kind !== "object")) {
    const ref = String(t.node.attr("textRef") ?? "");
    if (ref && !sourceDirs.some((d) => existsSync(join(d, ...ref.split("/")) + ".mustache")))
      out.push({ kind: "unresolved-textref", subject: t.name, href: t.href, detail: `@textRef ${ref} does not resolve (forward-pointing)` });
  }
  return out.sort((a, b) => (a.kind + a.subject).localeCompare(b.kind + b.subject));
}

export interface SearchEntry { t: string; h: string; k: "object" | "prompt" | "output" | "field"; }
export function buildSearchIndex(g: LinkGraph): SearchEntry[] {
  const out: SearchEntry[] = [];
  for (const n of g.nodes()) {
    out.push({ t: `${n.pkg}::${n.name}`, h: n.href, k: n.kind });
    if (n.kind === "object") for (const f of n.node.childrenOfType("field")) out.push({ t: `${n.name}.${f.name}`, h: `${n.href}#f-${f.name}`, k: "field" });
  }
  return out.sort((a, b) => a.t.localeCompare(b.t));
}
