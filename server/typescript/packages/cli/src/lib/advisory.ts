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
