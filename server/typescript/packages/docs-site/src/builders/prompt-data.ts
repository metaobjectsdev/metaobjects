import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { LinkGraph } from "../link-graph.js";
import type { CoverageTracker } from "../coverage.js";
import { highlightMustache } from "../mustache-highlight.js";
import { esc } from "../badges.js";
import { fmtAttrValue } from "./object-data.js";

// Template attrs rendered specifically (as their own badges) — everything else a
// template authors (e.g. a consumer's @dataflow) is rendered generically below.
const PROMPT_KNOWN_ATTRS = new Set(["format", "maxTokens", "requiredSlots", "model", "responseRef", "maxChars", "promptStyle", "payloadRef", "textRef", "description"]);

export interface PayloadTreeRow { indent: number; name: string; type: string; isArray: boolean; anchor: string; desc: string; refHtml: string; }
export interface PromptPageData { name: string; pkg: string; href: string; breadcrumbHtml: string; attrsHtml: string; desc: string; payloadName: string; payloadHref: string; payloadTree: PayloadTreeRow[]; sourceHtml?: string | undefined; sourceMissingNote?: string | undefined; tocHtml?: string | undefined; packageFiles: { file: string; html: string }[]; }

export function buildPromptPage(fqn: string, g: LinkGraph, cov: CoverageTracker, sourceDirs: string[]): PromptPageData {
  const dn = g.byFqn(fqn)!;
  const t = dn.node;
  cov.consumeNode(t);
  const attrs: string[] = [];
  for (const a of ["format", "maxTokens", "requiredSlots", "model", "responseRef", "maxChars", "promptStyle"]) {
    const v = t.attr(a); if (v !== undefined) { cov.consumeAttr(t, a); attrs.push(`<span class="badge badge-ghost badge-sm">@${esc(a)} ${esc(v)}</span>`); }
  }
  cov.consumeAttr(t, "payloadRef"); cov.consumeAttr(t, "textRef");
  // any other authored attrs (e.g. a consumer's @dataflow) rendered generically
  for (const [n, v] of [...t.ownAttrs()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (PROMPT_KNOWN_ATTRS.has(n)) continue;
    cov.consumeAttr(t, n);
    attrs.push(`<span class="badge badge-ghost badge-sm font-mono">@${esc(n)}=${esc(fmtAttrValue(v))}</span>`);
  }
  // payload tree (root + one nested level)
  const pRef = g.refsFrom(fqn).find((r) => r.kind === "payload");
  const payload = pRef ? g.byFqn(pRef.to) : undefined;
  const tree: PayloadTreeRow[] = [];
  const fieldsOf = (o: NonNullable<typeof payload>, indent: number, prefix: string) => {
    for (const f of o.node.childrenOfType("field")) {
      const ref = f.attr("objectRef");
      const target = typeof ref === "string" ? (g.byFqn(ref.includes("::") ? ref : `${o.pkg}::${ref}`) ?? g.byFqn(ref)) : undefined;
      tree.push({ indent, name: prefix + f.name, type: f.subType, isArray: f.resolvedIsArray(), anchor: `f-${prefix}${f.name}`,
        desc: esc(f.attr("description") ?? ""),
        refHtml: target ? `<a href="${esc(g.relHref(dn.href, target.href))}" class="link">${esc(target.name)}</a>` : "" });
      if (target && indent === 0) fieldsOf(target, 1, `${f.name}.`);
    }
  };
  if (payload) fieldsOf(payload, 0, "");
  const anchors = new Map(tree.map((r) => [r.name, `#${r.anchor}`]));
  // source resolution
  const textRef = String(t.attr("textRef") ?? "");
  let sourceHtml: string | undefined, tocHtml: string | undefined, sourceMissingNote: string | undefined;
  let pkgDir: string | undefined;
  for (const d of sourceDirs) {
    const p = join(d, ...textRef.split("/")) + ".mustache";
    if (existsSync(p)) { pkgDir = dirname(p);
      const r = highlightMustache(readFileSync(p, "utf8"), (path) => anchors.get(path));
      sourceHtml = r.html;
      tocHtml = r.toc.map((s) => `<a href="#${esc(s.anchor)}" class="link">${esc(s.name)}</a>`).join(" · ");
      break;
    }
  }
  if (!sourceHtml) sourceMissingNote = `text ref ${esc(textRef)} does not resolve under the metadata roots (forward-pointing ref).`;
  // other mustache files in the template's package dir
  const packageFiles: { file: string; html: string }[] = [];
  if (pkgDir) for (const f of readdirSync(pkgDir).filter((f) => f.endsWith(".mustache")).sort()) {
    if (join(pkgDir, f) === join(pkgDir, `${textRef.split("/").pop()}.mustache`)) continue;
    packageFiles.push({ file: f, html: highlightMustache(readFileSync(join(pkgDir, f), "utf8"), (p) => anchors.get(p)).html });
  }
  return { name: dn.name, pkg: dn.pkg, href: dn.href,
    breadcrumbHtml: `<a href="${esc(g.relHref(dn.href, "index.html"))}">index</a> / <a href="${esc("index.html")}">${esc(dn.pkg)}</a> / ${esc(dn.name)}`,
    attrsHtml: attrs.join(" "), desc: esc(t.attr("description") ?? ""),
    payloadName: payload?.name ?? "", payloadHref: payload ? esc(g.relHref(dn.href, payload.href)) : "",
    payloadTree: tree, sourceHtml, sourceMissingNote, tocHtml, packageFiles };
}
