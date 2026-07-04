export const esc = (s: unknown) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export interface Badge { text: string; cls: string; href?: string; title?: string; }

export function badge(b: Badge): string {
  const cls = `badge ${b.cls} badge-xs`;
  const title = b.title ? ` title="${esc(b.title)}"` : "";
  return b.href
    ? `<a href="${esc(b.href)}" class="${cls}"${title}>${esc(b.text)}</a>`
    : `<span class="${cls}"${title}>${esc(b.text)}</span>`;
}

export const LEGEND: { label: string; cls: string }[] = [
  { label: "reference (fk)", cls: "badge-soft badge-info" },
  { label: "contains (nested)", cls: "badge-soft badge-secondary" },
  { label: "indexed / pk", cls: "badge-soft badge-success" },
  { label: "required", cls: "badge-soft badge-error" },
  { label: "deprecated", cls: "badge-soft badge-warning" },
  { label: "enum", cls: "badge-soft badge-accent" },
  { label: "optional", cls: "badge-soft badge-neutral" },
];

export function legendHtml(): string {
  return LEGEND.map((l) => `<span class="badge ${l.cls} badge-xs">${esc(l.label)}</span>`).join(" ");
}
