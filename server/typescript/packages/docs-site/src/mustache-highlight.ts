export interface HighlightResult { html: string; toc: { name: string; anchor: string }[]; refs: string[]; }

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function highlightMustache(src: string, resolveHref: (p: string) => string | undefined): HighlightResult {
  let out = "";
  const toc: { name: string; anchor: string }[] = [];
  const refs: string[] = [];
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{{", i);
    if (open === -1) { out += esc(src.slice(i)); break; }
    out += esc(src.slice(i, open));
    const triple = src.startsWith("{{{", open);
    const close = src.indexOf(triple ? "}}}" : "}}", open);
    if (close === -1) { out += esc(src.slice(open)); break; }
    const end = close + (triple ? 3 : 2);
    const rawTok = src.slice(open, end);
    const inner = src.slice(open + (triple ? 3 : 2), close).trim();
    const sigil = triple ? "{" : inner[0] ?? "";
    const name = triple ? inner : inner.replace(/^[#^\/>!&]\s*/, "");
    const span = (cls: string, extra = "") => `<span class="${cls}"${extra}>${esc(rawTok)}</span>`;
    if (!triple && sigil === "!") out += span("mu-com");
    else if (!triple && sigil === ">") out += span("mu-par");
    else if (!triple && (sigil === "#" || sigil === "^")) {
      refs.push(name);
      const href = resolveHref(name);
      if (depth === 0 && sigil === "#") { toc.push({ name, anchor: `sec-${name}` }); }
      const idAttr = depth === 0 && sigil === "#" ? ` id="sec-${esc(name)}"` : "";
      out += href ? `<a href="${esc(href)}" class="mu-sec"${idAttr}>${esc(rawTok)}</a>` : span("mu-sec mu-unresolved", idAttr);
      depth++;
    } else if (!triple && sigil === "/") { depth = Math.max(0, depth - 1); out += span("mu-sec"); }
    else {
      refs.push(name);
      const cls = triple || sigil === "&" ? "mu-raw" : "mu-var";
      const href = resolveHref(name);
      out += href ? `<a href="${esc(href)}" class="${cls}">${esc(rawTok)}</a>` : span(`${cls} mu-unresolved`);
    }
    i = end;
  }
  return { html: out, toc, refs };
}
