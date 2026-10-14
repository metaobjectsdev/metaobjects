// Advisory reporting — the ONE display cap, the `--limit` parse, and the shapes
// advisory findings ride in when the caller asked for a structured format.
//
// Why this module exists: the advisory passes (`scanSourceForAntiPatterns` and
// the requirement diagnostics) found the work and then hid it. Three unshared
// `const CAP = 10 | 20` literals truncated three sections independently, and the
// findings never reached the structured payload at all — so `meta gen --format
// json` on a run with hundreds of findings emitted a clean-looking document while
// the findings went to stderr as text. An agent reading that payload is not being
// careless when it reports "all green"; the payload was empty.
//
// Two rules follow, and they are the whole point of the module:
//
//   1. TEXT output caps, because a cap exists to spare a human's terminal. The cap
//      is ONE constant, adjustable with `--limit`, so raising it cannot miss a
//      section.
//   2. STRUCTURED output NEVER caps. A machine has no terminal to spare, and a
//      truncated machine payload is the defect this module was written to fix.
//
// Discipline inherited from `anti-patterns.ts`: ADVISORY ONLY. Nothing here may
// reach an exit code.

import { log } from "./log.js";
import type { AntiPatternFinding } from "./anti-patterns.js";
import type { BaseUrlFinding } from "./base-url-advisory.js";
import type { RemovedPropFinding } from "./removed-prop-advisory.js";

/**
 * How many advisory lines TEXT output prints before it truncates.
 *
 * One value for every section (anti-patterns, the requirement gate's warnings,
 * the requirement authoring lint). It is 20 rather than 10 deliberately: folding
 * two literals into one must not take lines AWAY from a reader, and information
 * loss is the direction of the defect being fixed. Raise it per-run with
 * `--limit <n>`; `--limit all` removes it.
 */
export const DEFAULT_ADVISORY_LIMIT = 20;

/** `--limit all` — the spelling that removes the text cap entirely. */
export const ADVISORY_LIMIT_ALL = "all";

/**
 * Parse `--limit <n|all>` into a line budget. `all` (and any value ≥ the number of
 * findings) means "print everything". Absent → the default cap.
 *
 * Throws on a value that is not a positive integer or `all`; the caller turns that
 * into the usual exit-2 usage error, the same way `--dialect` and `--baseline` do.
 */
export function parseAdvisoryLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_ADVISORY_LIMIT;
  if (raw === ADVISORY_LIMIT_ALL) return Number.POSITIVE_INFINITY;
  // Reject "10.5", "1e3", "-1", "0" and "" — a limit is a count of lines.
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    throw new Error(
      `invalid --limit '${raw}'; expected a positive integer or '${ADVISORY_LIMIT_ALL}'`,
    );
  }
  return Number(raw);
}

// ---------------------------------------------------------------------------
// structured shapes
// ---------------------------------------------------------------------------

/** One anti-pattern finding as it appears in a structured payload. */
export interface AdvisoryFindingRow {
  file: string;
  line: number;
  rule: string;
  /** The MetaObjects construct that replaces the hand-rolled site. */
  construct: string;
  message: string;
}

/** One requirement diagnostic as it appears in a structured payload. */
export interface AdvisoryDiagnosticRow {
  code: string;
  /** The dotted child-name path, or "" for a diagnostic whose subject is not a
   *  requirement (object coverage names the entity in its message instead). */
  path: string;
  severity: string;
  /** "gate" — can fail the build; "lint" — advisory authoring warning, never can. */
  source: "gate" | "lint";
  message: string;
}

/**
 * One advisory section's FULL result. `total` always equals the row count: a
 * reader must never have to decide whether a list was truncated, which is exactly
 * what "…and 229 more" forced on the adopter who reported this.
 */
export interface AdvisorySection<Row> {
  /** "ran" — the pass executed. "skipped" — it did not, and `note` says why. */
  status: "ran" | "skipped";
  /** Present only when skipped. Stated rather than left to inference. */
  note?: string;
  total: number;
  rows: Row[];
}

/** A section that did not run, carrying the reason. */
export function skippedSection<Row>(note: string): AdvisorySection<Row> {
  return { status: "skipped", note, total: 0, rows: [] };
}

/** A section that ran, carrying EVERY row (never capped — see the header). */
export function ranSection<Row>(rows: Row[]): AdvisorySection<Row> {
  return { status: "ran", total: rows.length, rows };
}

// The `rule` of each advisory row that is NOT an anti-pattern-scanner finding. A row whose
// rule is none of these came from the scanner: an authored site hand-rolling a construct.
export const RULE_MISSING_BASE_URL = "missing-base-url";
export const RULE_REMOVED_PROP_PREFIX = "removed-prop:";
export const RULE_LIBRARY_PREFIX = "library-prefix-unprovenanced";
export const RULE_UNINDEXED_FK = "unindexed-foreign-key";
export const RULE_REFERENTIAL_ACTION_CONFLICT = "overridden-referential-action";

/** The next-step line for `n` rows of one advisory kind, each naming what the rows are. */
const ADVISORY_HELP: ReadonlyArray<{ matches: (rule: string) => boolean; line: (n: number) => string }> = [
  {
    matches: (r) => r === RULE_UNINDEXED_FK,
    line: (n) =>
      `${n} foreign key(s) with no covering index — see antiPatterns.rows[] (rule "${RULE_UNINDEXED_FK}"); each names the index.lookup to declare`,
  },
  {
    matches: (r) => r === RULE_REFERENTIAL_ACTION_CONFLICT,
    line: (n) =>
      `${n} foreign key(s) whose two sides disagree on the referential action — see antiPatterns.rows[] (rule "${RULE_REFERENTIAL_ACTION_CONFLICT}")`,
  },
  {
    matches: (r) => r === RULE_MISSING_BASE_URL,
    line: (n) =>
      `${n} entity-fetcher provider(s) mounted with no baseUrl while apiPrefix is set — see antiPatterns.rows[] (rule "${RULE_MISSING_BASE_URL}")`,
  },
  {
    matches: (r) => r.startsWith(RULE_REMOVED_PROP_PREFIX),
    line: (n) =>
      `${n} provider(s) still mounted with a prop 1.0 renamed away — see antiPatterns.rows[] (rule "${RULE_REMOVED_PROP_PREFIX}<prop>")`,
  },
  {
    matches: (r) => r === RULE_LIBRARY_PREFIX,
    line: (n) =>
      `${n} node(s) declared under "metaobjects::" with no ejection provenance — see antiPatterns.rows[] (rule "${RULE_LIBRARY_PREFIX}")`,
  },
];

/**
 * One next-step line per KIND of advisory row, in a structured payload's `help`.
 *
 * The advisory section carries several kinds of row keyed by `rule`, and the help line used
 * to count them all as "authored site(s) hand-roll what MetaObjects can model" — so a project
 * whose only advisories were unindexed foreign keys was told it hand-rolled three constructs.
 * Scanner findings keep that line; every other kind is counted under its own label.
 */
export function advisoryHelpLines(rows: readonly AdvisoryFindingRow[]): string[] {
  const counts = ADVISORY_HELP.map(() => 0);
  let handRolled = 0;
  for (const row of rows) {
    const kind = ADVISORY_HELP.findIndex((k) => k.matches(row.rule));
    if (kind === -1) handRolled++;
    else counts[kind] = (counts[kind] ?? 0) + 1;
  }
  const lines: string[] = [];
  if (handRolled > 0) {
    lines.push(
      `${handRolled} authored site(s) hand-roll what MetaObjects can model — see antiPatterns.rows[] and run \`meta types <construct>\``,
    );
  }
  ADVISORY_HELP.forEach((k, i) => {
    const n = counts[i] ?? 0;
    if (n > 0) lines.push(k.line(n));
  });
  return lines;
}

/** Project the scanner's findings into payload rows. `snippet` is deliberately
 *  dropped: it is a copy of the reader's own source line, and `file`+`line`
 *  already address it. */
export function antiPatternRows(findings: readonly AntiPatternFinding[]): AdvisoryFindingRow[] {
  return findings.map((f) => ({
    file: f.file,
    line: f.line,
    rule: f.rule,
    construct: f.construct,
    message: f.message,
  }));
}

/**
 * F52 findings in the same row shape, so the structured payload has ONE advisory list
 * rather than a second one a consumer has to learn about. `rule` is the discriminator.
 */
export function missingBaseUrlRows(findings: readonly BaseUrlFinding[]): AdvisoryFindingRow[] {
  return findings.map((f) => ({
    file: f.file,
    line: f.line,
    rule: RULE_MISSING_BASE_URL,
    construct: f.construct,
    message: f.message,
  }));
}

/**
 * F99 findings in that same row shape, for the same reason. `rule` carries the prop, so a
 * consumer filtering the advisory list does not have to parse the message to learn WHICH
 * rename fired — there will eventually be more than one.
 */
export function removedPropRows(findings: readonly RemovedPropFinding[]): AdvisoryFindingRow[] {
  return findings.map((f) => ({
    file: f.file,
    line: f.line,
    rule: `${RULE_REMOVED_PROP_PREFIX}${f.prop}`,
    construct: f.construct,
    message: f.message,
  }));
}

/** FR-043 §3.5 findings in the same row shape. */
export function libraryPrefixRows(
  findings: readonly { file: string; fqn: string; message: string }[],
): AdvisoryFindingRow[] {
  return findings.map((f) => ({
    file: f.file,
    line: 0,
    rule: RULE_LIBRARY_PREFIX,
    construct: f.fqn,
    message: f.message,
  }));
}

/**
 * Unindexed foreign keys in the same row shape. `construct` is `<entity FQN>.<reference>`,
 * the node the author edits to declare the index. There is no line: the finding is about the
 * loaded model, which does not carry source positions.
 */
export function unindexedFkRows(
  findings: readonly { file: string; construct: string; message: string }[],
): AdvisoryFindingRow[] {
  return findings.map((f) => ({
    file: f.file,
    line: 0,
    rule: RULE_UNINDEXED_FK,
    construct: f.construct,
    message: f.message,
  }));
}

/**
 * Relationships on both sides of one FK that disagree on its referential action, in the
 * same row shape. `construct` is `<entity FQN>.<reference>` — the FK, where the fix goes.
 */
export function referentialActionConflictRows(
  findings: readonly { file: string; construct: string; message: string }[],
): AdvisoryFindingRow[] {
  return findings.map((f) => ({
    file: f.file,
    line: 0,
    rule: RULE_REFERENTIAL_ACTION_CONFLICT,
    construct: f.construct,
    message: f.message,
  }));
}

// ---------------------------------------------------------------------------
// text output
// ---------------------------------------------------------------------------

/**
 * Print a capped run of advisory lines to stderr.
 *
 * THE single truncation site. The tail line is the part that matters: it names
 * how to reach what was withheld, which is what the three hand-rolled copies of
 * this loop never did — an adopter tried `--help | grep`, an invented env var and
 * `--json` before giving up on 96% of the report.
 *
 * @param structured true when the caller is ALSO emitting a machine-readable
 *   payload on stdout; the tail then points at it, because that copy is complete.
 */
export function warnCapped(
  lines: readonly string[],
  limit: number,
  opts: { structured: boolean },
): void {
  for (const line of lines.slice(0, limit)) log.warn(line);
  const withheld = lines.length - Math.min(lines.length, limit);
  if (withheld <= 0) return;
  log.warn(
    opts.structured
      ? `  …and ${withheld} more — every finding is in the --format payload on stdout.`
      : `  …and ${withheld} more. Raise the cap with --limit <n>, or --limit ${ADVISORY_LIMIT_ALL}.`,
  );
}
