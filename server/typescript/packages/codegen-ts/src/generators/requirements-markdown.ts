// server/typescript/packages/codegen-ts/src/generators/requirements-markdown.ts
//
// The human-facing half of the `requirements` docs surface — shape A, one index page.
//
// Design: docs/superpowers/specs/2026-08-21-requirements-doc-surface-design.md §4, §5
//
// ONE PAGE, NOT ONE PER NODE. Shape B (a page per top-level requirement) was measured
// and dominated: 19 files and ~30.5K tokens against ~11.9K for the index, with one page
// at 86KB. An 86KB page is not a documentation page.
//
// NO TEST LINK IS RENDERED, under any input (§3). With `@verifiedBy` retired there is no
// join key, so there is nothing honest to print — and a derived path would read as MORE
// authoritative than an author-chosen string, not less. Silence here is consistent with
// five shipped statements that a requirement carrying no test link is a legitimate
// declared state; it is not a gap waiting to be filled by whoever notices it next.
//
// PROSE LIVES HERE, STRUCTURE LIVES IN THE TOON SIBLING. TOON quotes every comma-bearing
// string, so statements and violations dilute it badly. The split is not stylistic.

import type { RequirementRow } from "./requirements-view.js";

/** `##` for a root-level requirement, deepening with nesting. `#` is the page title. */
function heading(depth: number): string {
  return "#".repeat(Math.min(depth + 2, 6));
}

/** The one-line fact bar: the attrs that are scannable rather than readable. */
function facts(r: RequirementRow): string {
  const parts: string[] = [`\`${r.subType}\``];
  if (r.level !== undefined) parts.push(`**L${r.level}**`);
  if (r.status !== undefined) parts.push(`status: \`${r.status}\``);
  // Absent `@disposition` means UNDECIDED, which is a real state and not the same as
  // "no gap" — so it is omitted rather than rendered as a default.
  if (r.disposition !== undefined) parts.push(`disposition: \`${r.disposition}\``);
  if (r.trackedBy.length > 0) parts.push(`tracked: ${r.trackedBy.join(", ")}`);
  return parts.join(" · ");
}

function renderOne(r: RequirementRow): string {
  const out: string[] = [`${heading(r.depth)} ${r.path}`, "", facts(r), ""];

  if (r.statement !== undefined) out.push(r.statement, "");
  // The prescriptive pair. A requirement MUST be violable, so the counterexample is not
  // decoration — it is what makes the statement checkable, and it reads beside it.
  if (r.counterexample !== undefined) out.push(`**Counterexample:** ${r.counterexample}`, "");
  if (r.description !== undefined) out.push(r.description, "");

  if (r.implementedBy.length > 0) {
    out.push(`**Implemented by:** ${r.implementedBy.map((c) => `\`${c}\``).join(", ")}`, "");
  }

  return out.join("\n");
}

/**
 * Render the ledger as one markdown index.
 *
 * Returns the EMPTY STRING for an empty ledger rather than a headed-but-empty page.
 * The generator keys on that to emit no file at all, which is in turn what lets the
 * surface default to on without changing output for any project lacking a ledger.
 */
export function renderRequirementsMarkdown(rows: readonly RequirementRow[]): string {
  if (rows.length === 0) return "";

  return [
    "# Requirements",
    "",
    `${rows.length} declared requirement${rows.length === 1 ? "" : "s"}, in declaration order.`,
    "",
    ...rows.map(renderOne),
  ].join("\n");
}
