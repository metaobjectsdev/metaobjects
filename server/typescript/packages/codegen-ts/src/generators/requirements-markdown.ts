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

/**
 * The heading line: the ADDRESS, then the LABEL where there is one.
 *
 * `spec/capability-ledger.md` charters `title` on a requirement as the thing an index
 * shows, so it belongs here and not in the fact bar. It rides BESIDE the path rather
 * than replacing it, for two reasons that are not stylistic:
 *
 *  - `path` is unique by construction and a `title` is not, so a title-keyed heading can
 *    collide — two entries with the same heading, and two markdown anchors fighting over
 *    one slug.
 *  - Every sibling surface names a requirement by its path: the TOON artifact's first
 *    column, shape C's `requirement.<subType> <path>` backlinks, and every `verify`
 *    diagnostic. A reader arriving from any of them searches for the path.
 *
 * An untitled requirement therefore renders exactly as it did before this line existed.
 *
 * Whitespace is COLLAPSED here rather than in the projection. A newline inside a title
 * ends the heading and re-parents everything after it, so the document silently loses
 * its structure — but that is a markdown fact, not a fact about the ledger, and another
 * consumer of `RequirementRow` is entitled to the authored string.
 */
function headingLine(r: RequirementRow): string {
  const title = r.title?.replace(/\s+/g, " ").trim();
  const label = title === undefined || title === "" ? "" : ` — ${title}`;
  return `${heading(r.depth)} ${r.path}${label}`;
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
  const out: string[] = [headingLine(r), "", facts(r), ""];

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
export interface RequirementsMarkdownOpts {
  /**
   * Render the ledger as a SECTION of a larger page rather than as the page.
   *
   * The `agent/requirements.md` surface carries this ledger under its own `## The ledger`
   * heading, and an embedded copy that keeps its `# Requirements` title gives the page two
   * H1s and reparents every entry as a sibling of the section that contains it — the
   * document silently loses its outline. So the title is dropped and every heading moves
   * down one level.
   *
   * A POST-HOC REGEX OVER THIS FUNCTION'S OUTPUT would do the same thing and would be the
   * wrong shape: heading depth is this renderer's decision (it already caps at h6), and a
   * caller rewriting it from outside would have to re-derive that cap and would drift from
   * it the next time this file changes.
   */
  readonly embedded?: boolean;
}

export function renderRequirementsMarkdown(
  rows: readonly RequirementRow[],
  opts?: RequirementsMarkdownOpts,
): string {
  if (rows.length === 0) return "";

  const body = rows.map(renderOne);
  if (opts?.embedded === true) {
    return [
      `${rows.length} declared requirement${rows.length === 1 ? "" : "s"}, in declaration order.`,
      "",
      // One extra `#` on every heading line, capped at h6 exactly as `heading()` caps.
      ...body.map((entry) =>
        entry.replace(/^(#{1,6}) /gm, (_m, hashes: string) =>
          `${"#".repeat(Math.min(hashes.length + 1, 6))} `,
        ),
      ),
    ].join("\n");
  }
  return [
    "# Requirements",
    "",
    `${rows.length} declared requirement${rows.length === 1 ? "" : "s"}, in declaration order.`,
    "",
    ...body,
  ].join("\n");
}
