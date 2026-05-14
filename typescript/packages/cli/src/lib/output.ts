// Output formatters for meta gen and meta migrate.
//
// TTY-gated glyphs: unicode (✓ ↺ ✗ = ⚠) when stdout is a TTY, plain words
// (NEW MERGED CONFLICT UNCHANGED REFUSED) otherwise. Per SP5 §5.1.

export interface FormatOptions {
  isTTY: boolean;
}

// ---------------------------------------------------------------------------
// gen
// ---------------------------------------------------------------------------

export type GenFileStatus = "new" | "merged" | "conflict" | "unchanged" | "refused";

export interface GenFileEntry {
  path: string;
  status: GenFileStatus;
  info: string;
}

export interface GenResultShape {
  files: GenFileEntry[];
  outDir: string;
  dialect: "sqlite" | "postgres";
  dryRun: boolean;
  warnings: string[];
}

const GEN_GLYPHS: Record<GenFileStatus, string> = {
  new: "✓",
  merged: "↺",
  conflict: "✗",
  unchanged: "=",
  refused: "⚠",
};

const GEN_WORDS: Record<GenFileStatus, string> = {
  new: "NEW",
  merged: "MERGED",
  conflict: "CONFLICT",
  unchanged: "UNCHANGED",
  refused: "REFUSED",
};

export function formatGenResult(result: GenResultShape, opts: FormatOptions): string {
  const symbols = opts.isTTY ? GEN_GLYPHS : GEN_WORDS;
  const header = `meta gen${result.dryRun ? " --dry-run" : ""} — ${result.dialect}, ${result.outDir}`;

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
    { new: 0, merged: 0, conflict: 0, unchanged: 0, refused: 0 },
  );
  const parts: string[] = [];
  if (counts.new > 0) parts.push(`${counts.new} written`);
  if (counts.merged > 0) parts.push(`${counts.merged} merged`);
  if (counts.conflict > 0) parts.push(`${counts.conflict} conflict`);
  if (counts.unchanged > 0) parts.push(`${counts.unchanged} unchanged`);
  if (counts.refused > 0) parts.push(`${counts.refused} refused`);
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
  dialect: "sqlite" | "postgres";
  displayUrl: string;
  changeCounts: Record<string, number>;
  blocked: BlockedEntry[];
  ambiguous: AmbiguousEntry[];
  writtenPaths: string[];
  dryRun: boolean;
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
