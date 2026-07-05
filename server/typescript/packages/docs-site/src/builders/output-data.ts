import { existsSync } from "node:fs";
import { join } from "node:path";
import { LinkGraph } from "../link-graph.js";
import type { CoverageTracker } from "../coverage.js";
import type { CommentDocs } from "../yaml-comments.js";
import { esc } from "../badges.js";
import { fmtAttrValue } from "./object-data.js";

// Rendered specifically (own fields/badges); everything else a template authors
// (e.g. a consumer's @dataflow) is rendered generically as extraAttrsHtml.
const OUTPUT_KNOWN_ATTRS = new Set(["payloadRef", "textRef", "format", "kind", "description"]);

export interface OutputPageData { name: string; pkg: string; href: string; breadcrumbHtml: string; format: string; kind: string; textRef: string; textRefResolves: boolean; payloadName: string; payloadHref: string; desc: string; extraAttrsHtml: string; fields: { name: string; type: string; isArray: boolean; wire: string; note: string; refHtml: string }[]; }

export function buildOutputPage(fqn: string, g: LinkGraph, cov: CoverageTracker, docs: CommentDocs, sourceDirs: string[] = []): OutputPageData {
  const dn = g.byFqn(fqn)!;
  const t = dn.node;
  cov.consumeNode(t); cov.consumeAttr(t, "payloadRef"); cov.consumeAttr(t, "textRef"); cov.consumeAttr(t, "format"); cov.consumeAttr(t, "kind");
  const format = String(t.attr("format") ?? "text");
  // any other authored template attrs (e.g. @maxChars, @requiredTags, a consumer's @dataflow)
  const extraAttrsHtml = [...t.ownAttrs()]
    .filter(([n]) => !OUTPUT_KNOWN_ATTRS.has(n))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([n, v]) => { cov.consumeAttr(t, n); return `<span class="badge badge-ghost badge-sm font-mono">@${esc(n)}=${esc(fmtAttrValue(v))}</span>`; })
    .join(" ");
  const pRef = g.refsFrom(fqn).find((r) => r.kind === "payload");
  const payload = pRef ? g.byFqn(pRef.to) : undefined;
  const fields = (payload?.node.childrenOfType("field") ?? []).map((f) => {
    const ref = f.attr("objectRef");
    const target = typeof ref === "string" ? (g.byFqn(ref.includes("::") ? ref : `${dn.pkg}::${ref}`) ?? g.byFqn(ref)) : undefined;
    const hasXmlText = f.attr("xmlText") !== undefined;
    const wire = hasXmlText ? "@xmlText body" : target ? "nested" : format === "xml" ? (f.resolvedIsArray() ? "element" : "attr") : "property";
    const noteAttr = f.attr("description");
    const note = esc(noteAttr ?? docs.fieldNote.get(`${payload!.name}.${f.name}`) ?? "");
    if (noteAttr !== undefined) cov.consumeAttr(f, "description");
    return { name: f.name, type: f.subType, isArray: f.resolvedIsArray(), wire, note,
      refHtml: target ? `<a href="${esc(g.relHref(dn.href, target.href))}" class="link">${esc(target.name)}</a>` : "" };
  });
  const textRef = String(t.attr("textRef") ?? "");
  const textRefResolves = sourceDirs.some((d) => existsSync(join(d, ...textRef.split("/")) + ".mustache"));
  return { name: dn.name, pkg: dn.pkg, href: dn.href,
    breadcrumbHtml: `<a href="${esc(g.relHref(dn.href, "index.html"))}">index</a> / <a href="${esc("index.html")}">${esc(dn.pkg)}</a> / ${esc(dn.name)}`,
    format, kind: String(t.attr("kind") ?? "document"), textRef, textRefResolves, extraAttrsHtml,
    payloadName: payload?.name ?? "", payloadHref: payload ? esc(g.relHref(dn.href, payload.href)) : "",
    desc: payload ? esc(payload.node.attr("description") ?? docs.objectDesc.get(payload.name) ?? "") : "", fields };
}
