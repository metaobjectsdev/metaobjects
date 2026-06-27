// verify-as-teacher: scan AUTHORED project source for a few high-precision
// "you hand-wrote what MetaObjects models" anti-patterns and emit a teaching
// pointer to the construct that replaces it.
//
// Why this exists: a cheap decision-probe study showed the model reliably
// *discovers* constructs (field.currency / field.enum / origin.aggregate) at a
// clean decision point — skill prose is not the lever there. The real gap is
// at BUILD time: under load it hand-rolls an aggregate, or declares a projection
// then never consumes its generated query. Deterministic steering beats more
// docs (ADR design judgment: "pattern-derivable-from-metadata = codegen"), so
// the build itself flags the anti-pattern, with the fix, when `meta verify` runs.
//
// Discipline: ADVISORY ONLY — these are warnings, never a non-zero exit (bias to
// under-flagging; a >15% false-positive rate is a kill criterion). The rules are
// deliberately narrow and high-precision; we would rather miss a real case than
// nag a legitimate one.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface AntiPatternFinding {
  file: string; // path relative to the scan root (posix-ish, sep-normalized)
  line: number; // 1-based
  rule: "hand-rolled-aggregate" | "money-float" | "enum-check";
  construct: string; // the MetaObjects construct that replaces it
  snippet: string; // the trimmed source line that matched
  message: string; // full teaching line (contains `meta types <construct>`)
}

// Directory segments and file patterns that are never authored app source.
const IGNORE_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage",
  ".metaobjects", "generated", "migrations",
]);
const SCAN_EXT = /\.(?:ts|tsx|js|sql)$/;
const SKIP_FILE = /(?:\.d\.ts$|\.test\.|\.spec\.)/;
const GENERATED_MARKER = "@generated";

// --- rules: each tests one source line, returns a finding shape or null -------

const MONEY_WORD = /\b(?:price|amount|cost|total|subtotal|fee|balance|cents|dollars)\w*/i;
const MONEY_MATH = /(?:\*\s*100\b|\/\s*100\b|\.toFixed\s*\(\s*2\s*\)|parseFloat\s*\()/;

function matchLine(line: string, isSql: boolean):
  | { rule: AntiPatternFinding["rule"]; construct: string }
  | null {
  // 1) Hand-written aggregate. AVG/SUM in SQL are almost always a derived metric
  //    you'd project (COUNT is deliberately excluded — too often a pagination
  //    total). A `.reduce(...)` that sums (a `+` body or a `, 0)` seed) is the TS
  //    equivalent.
  if (/\b(?:AVG|SUM)\s*\(/i.test(line)) return { rule: "hand-rolled-aggregate", construct: "origin.aggregate" };
  if (/\.reduce\s*\(/.test(line) && (/=>[^;]*\+/.test(line) || /,\s*0\s*\)/.test(line)))
    return { rule: "hand-rolled-aggregate", construct: "origin.aggregate" };

  // 2) Money handled as a float / hand-rolled minor units. Require BOTH a money
  //    word AND minor-unit math on the same line to stay high-precision.
  if (MONEY_WORD.test(line) && MONEY_MATH.test(line))
    return { rule: "money-float", construct: "field.currency" };

  // 3) A fixed value set enforced by a SQL CHECK (... IN (...)) — that's an enum.
  if (isSql && /CHECK\s*\([^)]*\bIN\s*\(/i.test(line))
    return { rule: "enum-check", construct: "field.enum" };

  return null;
}

const ADVICE: Record<AntiPatternFinding["rule"], string> = {
  "hand-rolled-aggregate":
    "you're computing an aggregate by hand — MetaObjects derives it: declare an " +
    "object.projection with an origin.aggregate child and call its generated query",
  "money-float":
    "money handled as a float / hand-rolled minor units — MetaObjects has " +
    "field.currency (integer minor units stored, formatted client-side)",
  "enum-check":
    "a fixed value set enforced by a CHECK — MetaObjects has field.enum (generates " +
    "the type union + validation + the CHECK for you)",
};

function findingFor(file: string, lineNo: number, raw: string, isSql: boolean): AntiPatternFinding | null {
  const hit = matchLine(raw, isSql);
  if (!hit) return null;
  const snippet = raw.trim();
  return {
    file, line: lineNo, rule: hit.rule, construct: hit.construct, snippet,
    message: `${file}:${lineNo} — ${ADVICE[hit.rule]}. Run \`meta types ${hit.construct}\`.`,
  };
}

function walk(dir: string, root: string, acc: AntiPatternFinding[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_SEGMENTS.has(e.name) || e.name.startsWith(".")) continue;
      walk(join(dir, e.name), root, acc);
      continue;
    }
    if (!e.isFile()) continue;
    if (!SCAN_EXT.test(e.name) || SKIP_FILE.test(e.name)) continue;
    const abs = join(dir, e.name);
    let text: string;
    try {
      if (statSync(abs).size > 512 * 1024) continue; // skip very large files
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // Skip MetaObjects-generated output — it legitimately contains AVG/CHECK etc.
    if (text.slice(0, 600).includes(GENERATED_MARKER)) continue;
    const rel = relative(root, abs).split(sep).join("/");
    const isSql = e.name.endsWith(".sql");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const f = findingFor(rel, i + 1, lines[i] ?? "", isSql);
      if (f) acc.push(f);
    }
  }
}

/**
 * Scan authored source under `cwd` for the high-precision anti-patterns above.
 * Returns every finding (advisory). Generated output, dependencies, build dirs,
 * and test files are skipped.
 */
export function scanSourceForAntiPatterns(cwd: string): AntiPatternFinding[] {
  const acc: AntiPatternFinding[] = [];
  walk(cwd, cwd, acc);
  acc.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return acc;
}
