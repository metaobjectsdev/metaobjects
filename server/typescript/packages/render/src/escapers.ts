// Format-driven escaping (FR-004 R7/R8). The render engine OWNS escaping (it does
// not rely on the Mustache lib's HTML-only default), so behavior is identical
// across language ports. `{{var}}` is escaped per format; `{{{var}}}` is raw.
//
// RenderFormat is defined here, independent of the metadata package's
// TEMPLATE_FORMATS, to keep this engine a zero-core-dependency module. The two
// sets are kept in lock-step by the render-conformance corpus.

export type RenderFormat =
  | "text"
  | "html"
  | "xml"
  | "csv"
  | "json"
  | "markdown"
  | "spreadsheet";

const xml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

// OWASP CSV/Excel formula-injection guard: neutralize a leading active char.
const injectionGuard = (s: string): string => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);

const csv = (s: string): string => {
  const v = injectionGuard(s);
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

const json = (s: string): string => JSON.stringify(s).slice(1, -1);

const raw = (s: string): string => s;

export const ESCAPERS: Record<RenderFormat, (s: string) => string> = {
  text: raw,
  markdown: raw,
  html: xml,
  xml,
  json,
  csv,
  // XML-escape the content first, then guard — so the guard's leading quote is a
  // literal apostrophe in the XML (which is what tells Excel "treat as text"),
  // not itself escaped to &#39;.
  spreadsheet: (s) => injectionGuard(xml(s)),
};
