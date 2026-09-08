// Output formatters for meta gen and meta migrate.
//
// TTY-gated glyphs: unicode (✓ ↺ ✗ = ⚠) when stdout is a TTY, plain words
// (NEW MERGED CONFLICT UNCHANGED REFUSED) otherwise. Per SP5 §5.1.

import type { Dialect } from "./kysely.js";
import { toonEncode } from "./format.js";
import { skippedSection, type AdvisoryFindingRow, type AdvisorySection } from "./advisory.js";

export interface FormatOptions {
  isTTY: boolean;
}

// ---------------------------------------------------------------------------
// gen
// ---------------------------------------------------------------------------

/**
 * `overwrite` is distinct from `new` on purpose. Reviewing a run, "an entity
 * appeared" and "an existing artifact was rewritten" are different facts, and the
 * CLI used to report both as `new` — the engine has always distinguished them
 * (`WriteStatus.overwrite`), and the reporting layer collapsed the two. Found on
 * two adopter estates independently, which is what makes it a reporting defect
 * rather than a preference: the summary line was right and the per-file status
 * was not.
 */
export type GenFileStatus =
  | "new"
  | "overwrite"
  | "merged"
  | "conflict"
  | "unchanged"
  | "refused"
  /** `--baseline=adopt`: the file's existing content became the merge base and
   *  nothing was written. Never folded into "unchanged" — the run's product is the
   *  manifest, and a summary that showed these as unchanged would hide it. */
  | "adopted"
  | "removed";

export interface GenFileEntry {
  path: string;
  status: GenFileStatus;
  info: string;
}

export interface GenResultShape {
  files: GenFileEntry[];
  outDir: string;
  /** Absent for a value-object-only project (no DB code generated → no dialect used). */
  dialect: Dialect | undefined;
  dryRun: boolean;
  warnings: string[];
  /**
   * The advisory anti-pattern pass, in full. Optional on the TYPE only so the
   * pure formatter tests can build a result without one; `genResultToData` turns
   * an absent section into an explicit "skipped" with a reason, because a payload
   * that omits the advisory is precisely the defect this field closes — a run
   * carrying hundreds of findings read as "all green" to an agent parsing stdout.
   *
   * NEVER capped here. The text renderer truncates for a human's terminal; the
   * structured payload carries every finding.
   */
  antiPatterns?: AdvisorySection<AdvisoryFindingRow>;
  /**
   * How many generators the config wired. Required, because the alternative is a
   * message that GUESSES: with no generators wired, a run over a project with five
   * entities emitted nothing and reported "no entities to generate … author entities
   * in this project's metadata sources", sending the reader to edit a file that was
   * already correct. The output's own first line (`gen: []`) already knew.
   */
  generatorCount: number;
}

const GEN_GLYPHS: Record<GenFileStatus, string> = {
  new: "✓",
  overwrite: "↻",
  merged: "↺",
  conflict: "✗",
  unchanged: "=",
  refused: "⚠",
  adopted: "⊕",
  removed: "−",
};

const GEN_WORDS: Record<GenFileStatus, string> = {
  new: "NEW",
  overwrite: "OVERWRITE",
  merged: "MERGED",
  conflict: "CONFLICT",
  unchanged: "UNCHANGED",
  refused: "REFUSED",
  adopted: "ADOPTED",
  removed: "REMOVED",
};

export function formatGenResult(result: GenResultShape, opts: FormatOptions): string {
  const symbols = opts.isTTY ? GEN_GLYPHS : GEN_WORDS;
  // A value-object-only project uses no dialect — show only the outDir in that case.
  const header = `meta gen${result.dryRun ? " --dry-run" : ""} — ${result.dialect ? `${result.dialect}, ` : ""}${result.outDir}`;

  if (result.files.length === 0) {
    return `${header}\n\n  No entities to generate.\n`;
  }

  const lines: string[] = [header, ""];
  const maxPathLen = Math.max(...result.files.map((f) => f.path.length));
  for (const file of result.files) {
    const sym = symbols[file.status];
    const pathPadded = file.path.padEnd(maxPathLen);
    const infoSegment = file.info.length > 0 ? `  (${file.info})` : "";
    if (opts.isTTY) {
      lines.push(`  ${sym}  ${pathPadded}  ${file.status}${infoSegment}`);
    } else {
      lines.push(`  ${sym.padEnd(9)}  ${pathPadded}${infoSegment}`);
    }
  }

  const counts = result.files.reduce<Record<GenFileStatus, number>>(
    (acc, f) => {
      acc[f.status] = (acc[f.status] ?? 0) + 1;
      return acc;
    },
    { new: 0, overwrite: 0, merged: 0, conflict: 0, unchanged: 0, refused: 0, adopted: 0, removed: 0 },
  );
  const parts: string[] = [];
  // "written" stays the sum of new + overwrite: that number was always correct and
  // adopters read it. Splitting the SUMMARY as well would change a line nothing was
  // wrong with; the per-file status is the one that was lying.
  const written = counts.new + counts.overwrite;
  if (written > 0) parts.push(`${written} written`);
  if (counts.merged > 0) parts.push(`${counts.merged} merged`);
  if (counts.conflict > 0) parts.push(`${counts.conflict} conflict`);
  if (counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`);
  if (counts.refused > 0) parts.push(`${counts.refused} refused`);
  // `--baseline=adopt`: recorded as the merge base, nothing written. Counted separately
  // from `unchanged` because the run's product is the manifest, and an adopter who cannot
  // see how many files it now covers has no way to review what they are about to commit.
  if (counts.adopted > 0) parts.push(`${counts.adopted} adopted`);
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  lines.push("", `  ${parts.join(", ")}`, "");

  if (result.warnings.length > 0) {
    lines.push("Warnings:", ...result.warnings.map((w) => `  - ${w}`), "");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// migrate
// ---------------------------------------------------------------------------

export interface BlockedEntry {
  kind: string;
  description: string;
  allowFlag: string;
}

export interface AmbiguousEntry {
  kind: string;
  description: string;
  hint: string;
}

export interface MigrateResultShape {
  dialect: Dialect;
  displayUrl: string;
  changeCounts: Record<string, number>;
  blocked: BlockedEntry[];
  ambiguous: AmbiguousEntry[];
  writtenPaths: string[];
  dryRun: boolean;
  /** Names of migrations actually applied to the DB this run (empty unless --apply ran and succeeded). */
  applied?: string[];
  /** True when --apply was attempted but failed (exit 1). */
  applyFailed?: boolean;
  /**
   * #192 — active output-format adapter. Only affects the post-write HINT: under
   * the flyway layout `meta migrate --apply` is REFUSED (Flyway owns apply and
   * flyway_schema_history), so suggesting it would send the reader at a command
   * that cannot work.
   */
  format?: "default" | "flyway";
}

export function formatMigrateResult(result: MigrateResultShape, _opts: FormatOptions): string {
  const header = `meta migrate${result.dryRun ? " --dry-run" : ""} — ${result.dialect}, ${result.displayUrl}`;
  const lines: string[] = [header, ""];

  const changeEntries = Object.entries(result.changeCounts).filter(([, v]) => v > 0);
  if (changeEntries.length === 0 && result.blocked.length === 0 && result.ambiguous.length === 0) {
    return `${header}\n\n  No schema changes.\n`;
  }

  if (changeEntries.length > 0) {
    const summary = changeEntries.map(([k, v]) => `${v} ${k}`).join(", ");
    lines.push(`  Changes: ${summary}`, "");
  }

  if (result.blocked.length > 0) {
    lines.push("  Blocked (re-run with --allow):");
    for (const b of result.blocked) {
      lines.push(`    ${b.kind}  ${b.description}  (--allow ${b.allowFlag})`);
    }
    lines.push("");
  }

  if (result.ambiguous.length > 0) {
    lines.push("  Ambiguous (re-run with --on-ambiguous):");
    for (const a of result.ambiguous) {
      lines.push(`    ${a.kind}  ${a.description}  (${a.hint})`);
    }
    lines.push("");
  }

  if (result.writtenPaths.length > 0) {
    lines.push("  Written:");
    for (const p of result.writtenPaths) {
      lines.push(`    ${p}`);
    }
    lines.push("");
  } else if (result.blocked.length > 0 || result.ambiguous.length > 0) {
    lines.push("  No migration written. Resolve flags and re-run.", "");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// gen TOON/JSON formatters (axi)
// ---------------------------------------------------------------------------

export function genResultToData(result: GenResultShape): {
  gen: { file: string; status: GenFileStatus }[];
  summary: string;
  help: string[];
  antiPatterns: AdvisorySection<AdvisoryFindingRow>;
} {
  const counts = result.files.reduce<Record<GenFileStatus, number>>(
    (a, f) => ((a[f.status] = (a[f.status] ?? 0) + 1), a),
    { new: 0, overwrite: 0, merged: 0, conflict: 0, unchanged: 0, refused: 0, adopted: 0, removed: 0 },
  );
  const parts: string[] = [];
  // Same split as the text formatter: `written` is new + overwrite, and the
  // per-file rows carry which one each was.
  const written = counts.new + counts.overwrite;
  if (written) parts.push(`${written} written`);
  if (counts.merged) parts.push(`${counts.merged} merged`);
  if (counts.conflict) parts.push(`${counts.conflict} conflict`);
  if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`);
  if (counts.refused) parts.push(`${counts.refused} refused`);
  if (counts.adopted) parts.push(`${counts.adopted} adopted`);
  if (counts.removed) parts.push(`${counts.removed} removed`);
  // Two ways to emit nothing, and they send the reader to different files. Name the
  // one that is actually true: a config wiring no generators cannot produce output
  // however good the metadata is, and telling its author to go write entities is a
  // false statement about a project that already has them.
  const noGenerators = result.generatorCount === 0;
  const summary = result.files.length !== 0
    ? parts.join(", ")
    : noGenerators
      ? "no generators are wired in metaobjects.config.ts, so nothing was generated"
      : `no entities to generate in ${result.outDir}`;
  const help = result.files.length !== 0
    ? ["typecheck the generated code with `npx tsc`", "create your database tables with `meta migrate --from-db --db <url> --dialect <sqlite|postgres> --slug init --apply`"]
    : noGenerators
      ? ["add generators to the `generators: []` array in metaobjects.config.ts — `meta eject --list` names every generator you can own, and `meta init` scaffolds the usual set"]
      : ["author entities in this project's metadata sources then re-run `meta gen`"];
  // An absent section is STATED, never omitted: a reader must be able to tell
  // "the scan found nothing" from "the scan never ran".
  const antiPatterns = result.antiPatterns
    ?? skippedSection<AdvisoryFindingRow>("the advisory anti-pattern pass did not run for this result");
  // One more next step when there is something to act on — the whole reason the
  // findings are in the payload is that somebody can now act on all of them.
  if (antiPatterns.total > 0) {
    help.push(
      `${antiPatterns.total} authored site(s) hand-roll what MetaObjects can model — see antiPatterns.rows[] and run \`meta types <construct>\``,
    );
  }
  return {
    gen: result.files.map((f) => ({ file: f.path, status: f.status })),
    summary,
    help,
    antiPatterns,
  };
}

export function formatGenResultToon(result: GenResultShape): string {
  return toonEncode(genResultToData(result));
}

// ---------------------------------------------------------------------------
// migrate TOON/JSON formatters (axi)
// ---------------------------------------------------------------------------

export function migrateResultToData(result: MigrateResultShape): {
  changes: { kind: string; count: number }[];
  written: string[];
  summary: string;
  help: string[];
} {
  const changeEntries = Object.entries(result.changeCounts).filter(([, v]) => v > 0);
  const changes = changeEntries.map(([kind, count]) => ({ kind, count }));

  const isBlocked = result.blocked.length > 0 || result.ambiguous.length > 0;
  const changeSummary = changeEntries.map(([k, v]) => `${v} ${k}`).join(", ");
  const applied = result.applied ?? [];
  const applyFailed = result.applyFailed ?? false;
  // `--apply` also applies previously-written-but-unapplied ledger files, so
  // `applied` can be non-empty even when there is no fresh metadata diff.
  const hasChanges = changeEntries.length > 0 || isBlocked;
  const prefix = changeSummary.length > 0 ? `${changeSummary}; ` : "";

  // Summary + help reflect what ACTUALLY happened, computed from the real signals
  // (dry-run, blocked/ambiguous, files written, files applied) rather than
  // short-circuiting on the presence of a fresh diff: a dry-run wrote nothing, a
  // generate-only run wrote files but applied nothing, and `--apply` can apply a
  // pending ledger file even with no new diff. The `--rollback` hint appears only
  // when something was actually applied.
  let summary: string;
  let help: string[];
  if (isBlocked) {
    summary = `${changeSummary}; not applied`;
    help = [
      ...result.blocked.map((b) => `re-run with --allow ${b.allowFlag} to apply: ${b.description}`),
      ...result.ambiguous.map((a) => `re-run with --on-ambiguous to resolve: ${a.hint}`),
    ];
  } else if (result.dryRun) {
    summary = hasChanges ? `${changeSummary}; preview only (nothing written)` : "no schema changes";
    help = hasChanges
      ? ["re-run without --dry-run to write the migration"]
      : ["metadata and schema are in sync — nothing to do"];
  } else if (applyFailed) {
    summary = `${prefix}apply failed`;
    help = ["resolve the apply error above, then re-run `meta migrate --apply`"];
  } else if (applied.length > 0) {
    summary = `${prefix}applied ${applied.length} migration(s)`;
    help = ["roll back with `meta migrate --rollback <target>`"];
  } else if (result.writtenPaths.length > 0) {
    summary = `${prefix}wrote ${result.writtenPaths.length} migration file(s)`;
    help = result.format === "flyway"
      ? ["apply with `flyway migrate` — Flyway owns apply and its schema history"]
      // NOT `meta migrate --db <url> --apply` — that re-runs the diff, so it
      // demands --slug again and emits a SECOND migration with the same DDL.
      // apply-pending (#242) replays what was just written, with no diff.
      : ["apply with `meta migrate apply-pending --db <url>`"];
  } else if (!hasChanges) {
    summary = "no schema changes";
    help = ["metadata and schema are in sync — nothing to do"];
  } else {
    summary = `${changeSummary}; not written`;
    help = ["re-run with --slug <name> to write the migration"];
  }

  return { changes, written: result.writtenPaths, summary, help };
}

export function formatMigrateResultToon(result: MigrateResultShape): string {
  return toonEncode(migrateResultToData(result));
}
