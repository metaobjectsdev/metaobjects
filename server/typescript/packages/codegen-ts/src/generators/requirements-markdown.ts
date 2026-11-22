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
//
// BUILDER, THEN TEMPLATE. The page is the shared Mustache template
// `templates/requirements/requirements.md.mustache` fed the data `requirementsLedgerData`
// builds; every other port renders the same template from the same data, pinned in
// `fixtures/docs-page-conformance/`. Every decision (heading depth, which title survives,
// the fact bar, the embedded demotion) is made HERE: the template only lays the lines out.
// An adopter changes the page by dropping a same-named template under the project's
// `templates/`.

import type { Provider } from "@metaobjectsdev/render";
import { frameworkTemplatesProvider } from "../render-engine/framework-provider.js";
import { renderDocPage } from "../render-engine/doc-page.js";
import type { RequirementRow } from "./requirements-view.js";

/** The shared template both the `requirements` page and the agent page's ledger render. */
export const REQUIREMENTS_PAGE_REF = "requirements/requirements.md";

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
  const label =
    title === undefined || title === "" || titleRestatesLeaf(r.path, title)
      ? ""
      : ` — ${title}`;
  return `${heading(r.depth)} ${r.path}${label}`;
}

/**
 * True when the title says nothing the path's LEAF SEGMENT does not already say.
 *
 * Measured on a hand-curated 262-entry ledger: **64 headings (24%)** read
 * `## security — Security`, `### security.integrity — Integrity`. That is not bad
 * authoring — `title` is chartered as "a short display label", and for a node called
 * `integrity` the honest label IS "Integrity". The redundancy is in the RENDER, so
 * the render is what changes.
 *
 * Only the LEAF is compared, never the whole path: a node `security.integrity`
 * titled "Data Integrity" keeps its title, and one titled "Integrity" loses it. And
 * the path always survives — dropping the path instead would break the two
 * properties the heading is built on (it is unique by construction, so anchors
 * cannot collide, and every sibling surface names a requirement by it).
 *
 * Comparison is case- and separator-insensitive so `data-integrity` / "Data
 * Integrity" / "data integrity" all count as the same word.
 */
function titleRestatesLeaf(path: string, title: string): boolean {
  const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const leaf = path.slice(path.lastIndexOf(".") + 1);
  return normalize(leaf) === normalize(title);
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

/** One ledger entry, every line finished. An absent optional line is an absent key. */
export interface RequirementsLedgerEntry {
  readonly heading: string;
  readonly facts: string;
  readonly statement?: string;
  /** The whole line, `**Counterexample:** …`. */
  readonly counterexample?: string;
  readonly description?: string;
  /** The whole line, `**Implemented by:** …`. */
  readonly implementedBy?: string;
}

/** What `requirements/requirements.md.mustache` renders. */
export interface RequirementsLedgerData {
  /** True when the ledger is a section of the agent page: no `# Requirements` title. */
  readonly embedded: boolean;
  readonly count: number;
  /** `"s"`, or `""` for exactly one entry. */
  readonly plural: string;
  readonly entries: readonly RequirementsLedgerEntry[];
}

/**
 * One extra `#` on every line that starts a heading, capped at h6 exactly as `heading()`
 * caps. Applied to each finished LINE of an embedded entry (a statement can hold a line
 * that starts with `#`, and it moves down with the rest).
 */
function demote(text: string): string {
  return text.replace(/^(#{1,6}) /gm, (_m, hashes: string) => `${"#".repeat(Math.min(hashes.length + 1, 6))} `);
}

function entryOf(r: RequirementRow, embedded: boolean): RequirementsLedgerEntry {
  const line = embedded ? demote : (text: string): string => text;
  return {
    heading: line(headingLine(r)),
    facts: line(facts(r)),
    ...(r.statement !== undefined && { statement: line(r.statement) }),
    // The prescriptive pair. A requirement MUST be violable, so the counterexample is not
    // decoration — it is what makes the statement checkable, and it reads beside it.
    ...(r.counterexample !== undefined && { counterexample: line(`**Counterexample:** ${r.counterexample}`) }),
    ...(r.description !== undefined && { description: line(r.description) }),
    ...(r.implementedBy.length > 0 && {
      implementedBy: line(`**Implemented by:** ${r.implementedBy.map((c) => `\`${c}\``).join(", ")}`),
    }),
  };
}

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
   * The demotion is the BUILDER's, not a regex over the rendered page: heading depth is
   * this file's decision (it already caps at h6), and a caller rewriting it from outside
   * would have to re-derive that cap and would drift from it the next time this file changes.
   */
  readonly embedded?: boolean;
  /** Where the template is resolved. Default: the package's own templates. */
  readonly provider?: Provider;
}

/** The data the ledger template renders, for a non-empty ledger. */
export function requirementsLedgerData(
  rows: readonly RequirementRow[],
  opts?: { readonly embedded?: boolean },
): RequirementsLedgerData {
  const embedded = opts?.embedded === true;
  return {
    embedded,
    count: rows.length,
    plural: rows.length === 1 ? "" : "s",
    entries: rows.map((r) => entryOf(r, embedded)),
  };
}

/**
 * Render the ledger as one markdown index.
 *
 * Returns the EMPTY STRING for an empty ledger rather than a headed-but-empty page.
 * The generator keys on that to emit no file at all, which is in turn what lets the
 * surface default to on without changing output for any project lacking a ledger.
 */
export function renderRequirementsMarkdown(
  rows: readonly RequirementRow[],
  opts?: RequirementsMarkdownOpts,
): string {
  if (rows.length === 0) return "";
  return renderDocPage(
    REQUIREMENTS_PAGE_REF,
    requirementsLedgerData(rows, opts),
    opts?.provider ?? frameworkTemplatesProvider,
    "requirements.md",
  );
}
