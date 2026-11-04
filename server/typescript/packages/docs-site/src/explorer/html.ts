// HTML fragments the explorer pages share: status chips, level badges, roll-up bars, links.
//
// The colour rules are design report §4.2, and every fragment here keeps them apart:
//   - a requirement's DECLARED status is a filled chip plus a glyph (● ◐ ○ ⊘), so it reads
//     without colour;
//   - a GATE verdict (a finding on a requirement, an unclaimed entity) is an outlined badge or a
//     ring, never a fill;
//   - a ROLL-UP of the statuses below is a separate stacked bar, and never repaints the chip.
// Nothing here colours a test result: the build does not read one.

import { REQUIREMENT_ATTR_DISPOSITION } from "@metaobjectsdev/metadata";
import { STATUSES, STATUS_GLYPH, type ReqEntry, type Rollup } from "./index-model.js";

export function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** A declared status: a filled chip with its glyph. */
export function statusChip(status: string): string {
  if (status === "") return "";
  return `<span class="chip s-${esc(status)}" title="@status: ${esc(status)}">${STATUS_GLYPH[status] ?? ""} ${esc(status)}</span>`;
}

/** A declared status as its glyph alone, in the status colour (child lists, matrix cells). */
export function statusGlyph(status: string): string {
  if (status === "") return "";
  return `<span class="glyph g-${esc(status)}" title="@status: ${esc(status)}">${STATUS_GLYPH[status] ?? ""}</span>`;
}

/** The level badge: `L3`, or `—` for a flat architectural policy. */
export function levelBadge(r: ReqEntry): string {
  return r.level !== undefined
    ? `<span class="lvl" title="Level ${r.level}">L${r.level}</span>`
    : `<span class="lvl" title="A flat architectural policy: no level">—</span>`;
}

/** A gate verdict as an outlined badge: `error` or `warn`, with the finding codes. */
export function verdictBadge(r: ReqEntry): string {
  const row = r.row;
  if (row === undefined || row.diagnostics.length === 0) return "";
  const worst = row.diagnostics.some((d) => d.severity === "error") ? "error" : "warn";
  const codes = row.diagnostics.map((d) => d.code).join(", ");
  const n = row.diagnostics.length;
  return `<span class="chip v-${worst}" title="meta verify: ${esc(codes)}">${worst === "error" ? "✕" : "!"} ${n} gate ${worst === "error" ? (n === 1 ? "error" : "errors") : n === 1 ? "warning" : "warnings"}</span>`;
}

/** The disposition pill (`accepted`, `deferred`). */
export function dispositionPill(r: ReqEntry): string {
  const d = r.node.attrs[REQUIREMENT_ATTR_DISPOSITION];
  return typeof d === "string" ? `<span class="pill" title="@disposition">${esc(d)}</span>` : "";
}

/** The roll-up: a stacked bar of the declared statuses below, drawn apart from any chip. */
export function rollupBar(c: Rollup): string {
  const total = STATUSES.reduce((a, s) => a + (c[s] ?? 0), 0);
  const title = STATUSES.filter((s) => (c[s] ?? 0) > 0).map((s) => `${c[s]} ${s}`).join(", ");
  if (total === 0) return `<div class="bar" title="nothing below declares a status"></div>`;
  const spans = STATUSES.filter((s) => (c[s] ?? 0) > 0)
    .map((s) => `<span class="b-${s}" style="width:${pct((c[s] ?? 0) / total)}"></span>`)
    .join("");
  return `<div class="bar" role="img" aria-label="Status below: ${esc(title)}" title="Status below: ${esc(title)}">${spans}</div>`;
}

/** A width that prints the same on every run and every platform. */
function pct(x: number): string {
  return `${(Math.round(x * 10000) / 100).toString()}%`;
}

/** The legend every requirement view carries. */
export function legendHtml(withUnclaimed: boolean): string {
  const chips = STATUSES.map((s) => statusChip(s)).join("");
  const unclaimed = withUnclaimed ? `<span class="chip v-unclaimed" title="meta verify: WARN_REQUIREMENT_OBJECT_UNCLAIMED">unclaimed</span>` : "";
  return `<div class="legend">${chips}${unclaimed}<span class="chip v-warn">! gate finding</span><span>Fill and glyph are the declared <code>@status</code>; outlines are <code>meta verify</code> findings; bars roll up what sits below. No colour here reports a test result.</span></div>`;
}

/** A path from one page to another, both relative to the site root. */
export function relHref(fromPage: string, toPage: string): string {
  const depth = fromPage.split("/").length - 1;
  return "../".repeat(depth) + toPage;
}
