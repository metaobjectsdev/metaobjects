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
//
// `migration` (SINGULAR) sits beside `migrations` because Flyway's own convention
// is `src/main/resources/db/migration` — the exact directory THIS repo's Flyway
// output adapter documents as its target (`migrate-ts/src/write-migration-flyway.ts`,
// `WriteMigrationFlywayOptions.dir`). Without it MetaObjects emitted migrations into
// a directory its own advisory scanner did not ignore, then flagged the files it had
// just written as hand-rolled anti-patterns.
//
// Nothing else is added here on speculation. A directory list is a guess about
// someone else's repository — the same failure `@verifiedBy`'s closed pattern list
// shipped with and 0.23.1 had to correct — so the real coverage lives in
// IMMUTABLE_MIGRATION_FILE below (a name, wherever it sits) and in the
// project-declared `ignore` globs.
const IGNORE_SEGMENTS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage",
  ".metaobjects", "generated", "migrations", "migration",
]);
const SCAN_EXT = /\.(?:ts|tsx|js|sql)$/;
const SKIP_FILE = /(?:\.d\.ts$|\.test\.|\.spec\.)/;
const GENERATED_MARKER = "@generated";

// --- immutable migration files ------------------------------------------------
//
// WHY THESE ARE EXCLUDED BY NAME, NOT ONLY BY DIRECTORY. A historical migration
// that a runner has already applied CANNOT be edited: Flyway checksums each
// versioned migration and refuses to start against a database whose recorded
// checksum no longer matches, so "fix the CHECK constraint in V001__baseline.sql"
// is not advice — it is a request to break every environment that has run it. A
// finding nobody can act on trains the reader to skip the whole advisory section,
// which is precisely how this advisory came to be ignored in an adopter estate
// where it had 233 real hits. Under-flagging is the standing bias (module header);
// nagging about the unfixable is the worst way to spend the reader's attention.
//
// A migration is identifiable by its own name wherever it lives, which is what
// makes this rule better than another directory guess. Each pattern below names
// the evidence it rests on; every one is either emitted by this repo itself or by
// a tool whose naming is documented and unmistakable. Patterns that are merely
// plausible are deliberately absent — a false exclusion silences a real finding,
// which is the same failure pointed the other way. An unusual layout is the
// project's to declare (`AntiPatternScanOptions.ignore`), not ours to guess.
const IMMUTABLE_MIGRATION_FILE: readonly RegExp[] = [
  // Flyway versioned (V) and undo (U). Source of truth for the version grammar is
  // `VERSIONED_RE` in `migrate-ts/src/write-migration-flyway.ts` — restated rather
  // than imported because that constant is module-private, and exporting it is a
  // change to another package. Two deliberate differences from it: it matches `V`
  // ONLY (matching `U` there would let the undo files it emits bump the version
  // counter), whereas an undo file is every bit as un-editable as its up half; and
  // the multi-part form `V1.1__` / `V1_0__` is carried over verbatim, because
  // Flyway pads versions for comparison and both spellings are legal.
  /^[VU]\d+(?:[._]\d+)*__/,
  // Flyway REPEATABLE (`R__`) is deliberately NOT here, and the reason is the rule's
  // name. Flyway re-applies a repeatable migration whenever its checksum changes, so
  // editing one is the sanctioned workflow rather than a forbidden act — which makes a
  // finding on it ACTIONABLE, and this list exists precisely to drop findings that are
  // not. Excluding it would silence a real one. Repeatable scripts live in Flyway's
  // `db/migration`, which IGNORE_SEGMENTS covers, so the practical effect is limited to
  // a stray `R__` outside that tree — where scanning it is the correct answer.
  // A 10+ digit leading number is a clock, not a count: epoch milliseconds (13,
  // node-pg-migrate) or YYYYMMDDHHMMSS (14, Rails / Knex / Sequelize, and this
  // repo's own default writer — see the directory rule below). Ten is the floor
  // because that is epoch seconds; a four-digit lead would also match an ordinary
  // `2024_q1_revenue.sql`, which is exactly the false exclusion to avoid.
  /^\d{10,}[-_]/,
  // A ZERO-PADDED sequence: `0000_lush_rockslide.sql` (Drizzle Kit, whose default
  // `out` is `./drizzle` and so is caught by no directory name), `0001_init.sql`
  // (this repo's own D1 adapter — `write-migration-d1.ts` pads to 4), and
  // `000001_create_users.up.sql` (golang-migrate). The leading zero is what makes
  // this safe: sequence numbers are padded so they sort, ordinary numbers are not,
  // so a year or quarter prefix can never match.
  /^0\d+[-_]/,
  // The up/down halves of a migration pair. `up.sql` / `down.sql` is what this
  // repo's own default writer emits (`migrate-ts/src/write-migration.ts`); the
  // `<name>.up.sql` / `<name>.down.sql` suffix form is golang-migrate's. Kept to
  // `.sql` on purpose — `up.ts` and `down.ts` are not migration names.
  /^(?:up|down)\.sql$/i,
  /\.(?:up|down)\.sql$/i,
];

// A per-migration DIRECTORY named by a timestamp. This repo's default writer
// creates `<YYYYMMDDHHMMSS>-<slug>/` holding `up.sql` + `down.sql`
// (`migrate-ts/src/write-migration.ts`), and Prisma creates
// `<YYYYMMDDHHMMSS>_<slug>/` holding `migration.sql`. Both are already covered
// when they sit under the default `migrations` root; this catches them under a
// project-chosen `migrate.outDir`, and it is risk-free — nobody names a source
// directory with a fourteen-digit timestamp.
const IMMUTABLE_MIGRATION_DIR = /^\d{10,}[-_]/;

function isImmutableMigrationFile(basename: string): boolean {
  return IMMUTABLE_MIGRATION_FILE.some((re) => re.test(basename));
}

// --- project-declared ignore globs --------------------------------------------

/** Options for {@link scanSourceForAntiPatterns}. */
export interface AntiPatternScanOptions {
  /**
   * Extra path globs the scan skips entirely — the project's escape hatch for a
   * layout the built-ins cannot know about (a vendored SQL archive, a migration
   * tool with a house naming convention, a directory of read-only reference DDL).
   *
   * The built-in exclusions above are a CONVENIENCE, not an authority; the
   * `@verifiedBy` fix in 0.23.1 established the shape — built-in defaults for the
   * conventions that demonstrably exist, PLUS a project-declared list, because a
   * closed list of guesses about someone else's repository will always be wrong
   * somewhere. Declared globs ADD to the built-ins; they never replace them.
   *
   * Matched against forward-slash paths relative to the scan root: `**` spans
   * separators, `*` does not, `?` is one non-separator character. A glob matching
   * a directory path prunes that whole subtree.
   *
   * ```ts
   * scanSourceForAntiPatterns(root, { ignore: ["drizzle/**", "db/legacy"] })
   * ```
   */
  readonly ignore?: readonly string[];
}

/**
 * A glob as permissive as the ones adopters actually write, anchored at the scan
 * root and matched against forward-slash relative paths. Deliberately small:
 * anything richer belongs to a glob library, and pulling one in for a knob this
 * narrow is not worth the dependency. (Same grammar the retired `@verifiedBy`
 * scan used for `verify.testFiles`, kept identical so a project that learned one
 * spelling does not have to learn a second.)
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**/` may match zero segments, so `**/*.sql` matches a root-level file.
        if (glob[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else { out += ".*"; i += 1; }
      } else out += "[^/]*";
      continue;
    }
    if (c === "?") { out += "[^/]"; continue; }
    out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
}

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

function relPosix(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

function walk(dir: string, root: string, ignore: readonly RegExp[], acc: AntiPatternFinding[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (IGNORE_SEGMENTS.has(e.name) || e.name.startsWith(".")) continue;
      // A per-migration directory is excluded by its own name, wherever it sits.
      if (IMMUTABLE_MIGRATION_DIR.test(e.name)) continue;
      const dirRel = relPosix(root, join(dir, e.name));
      if (ignore.some((re) => re.test(dirRel))) continue;
      walk(join(dir, e.name), root, ignore, acc);
      continue;
    }
    if (!e.isFile()) continue;
    if (!SCAN_EXT.test(e.name) || SKIP_FILE.test(e.name)) continue;
    // Filename shape wins over location, deliberately: a migration is identifiable
    // by its own name, and a project that keeps its migrations somewhere we cannot
    // guess should not be nagged about files it may not edit. The cost is bounded —
    // these name shapes are not ones an ordinary query or schema file wears.
    if (isImmutableMigrationFile(e.name)) continue;
    const abs = join(dir, e.name);
    // Checked before the read: a declared ignore is a decision not to look at the
    // file at all, so it should not cost an I/O either.
    const rel = relPosix(root, abs);
    if (ignore.some((re) => re.test(rel))) continue;
    let text: string;
    try {
      if (statSync(abs).size > 512 * 1024) continue; // skip very large files
      text = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    // Skip MetaObjects-generated output — it legitimately contains AVG/CHECK etc.
    if (text.slice(0, 600).includes(GENERATED_MARKER)) continue;
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
 * Returns every finding (advisory — this never influences an exit code).
 * Generated output, dependencies, build dirs, test files, immutable migration
 * files, and anything matched by `options.ignore` are skipped.
 */
export function scanSourceForAntiPatterns(
  cwd: string,
  options?: AntiPatternScanOptions,
): AntiPatternFinding[] {
  const acc: AntiPatternFinding[] = [];
  const ignore = (options?.ignore ?? []).map(globToRegExp);
  walk(cwd, cwd, ignore, acc);
  acc.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return acc;
}
