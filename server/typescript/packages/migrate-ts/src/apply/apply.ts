import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Kysely, sql } from "kysely";
import {
  appliedRecords,
  ensureLedger,
  recordApplied,
} from "./ledger.js";

/** The per-migration up-SQL filename, shared with writeMigration's layout. */
const UP_SQL = "up.sql";

export interface ApplyPendingOptions {
  /** When true, compute + return the plan but apply nothing. */
  dryRun: boolean;
}

export interface ApplyPendingResult {
  /** Migration names that were pending (not yet in the ledger), in order. */
  pending: string[];
  /** Migration names that were applied this run, in order. Empty on dryRun. */
  applied: string[];
}

interface DiscoveredMigration {
  /** `<timestamp>-<slug>` directory name — stable id + sort key. */
  name: string;
  /** Absolute path to the up.sql file. */
  upPath: string;
}

/**
 * Apply pending committed migration files in order, tracked by the
 * migration-history ledger, transactionally.
 *
 * Idempotency comes from the LEDGER (skip names already recorded), NOT from
 * re-diffing — so hand-authored files + data steps replay exactly once.
 *
 * For each pending migration (sorted by directory name), the file's SQL and a
 * `recordApplied` row are run in the SAME Kysely transaction; any failure rolls
 * back that file's tx, leaving it unrecorded (so a re-run retries it), and
 * stops the run. Previously-applied files are checksum-compared against the
 * ledger — a changed file errors (tamper guard).
 */
export async function applyPending(
  db: Kysely<Record<string, unknown>>,
  dir: string,
  opts: ApplyPendingOptions,
): Promise<ApplyPendingResult> {
  await ensureLedger(db);
  const recorded = await appliedRecords(db);

  const discovered = await discoverMigrations(dir);

  // Tamper guard: any already-applied migration whose current up.sql checksum
  // differs from the recorded one is a hard error.
  for (const m of discovered) {
    const recordedChecksum = recorded.get(m.name);
    if (recordedChecksum === undefined) continue;
    const current = checksumOf(await readFile(m.upPath, "utf8"));
    if (current !== recordedChecksum) {
      throw new Error(
        `migration '${m.name}' was already applied but its up.sql checksum changed ` +
          `(recorded ${recordedChecksum.slice(0, 12)}…, current ${current.slice(0, 12)}…). ` +
          `Applied migrations are immutable; revert the edit or author a new migration.`,
      );
    }
  }

  const pending = discovered.filter((m) => !recorded.has(m.name));
  const pendingNames = pending.map((m) => m.name);

  if (opts.dryRun) {
    return { pending: pendingNames, applied: [] };
  }

  const applied: string[] = [];
  for (const m of pending) {
    const text = await readFile(m.upPath, "utf8");
    const checksum = checksumOf(text);
    // Run the file's SQL + the ledger insert in ONE transaction. A failure
    // rolls the whole file back (unrecorded) and propagates — stopping the run.
    await db.transaction().execute(async (trx) => {
      for (const stmt of splitSqlStatements(text)) {
        await sql.raw(stmt).execute(trx);
      }
      await recordApplied(trx, m.name, checksum);
    });
    applied.push(m.name);
  }

  return { pending: pendingNames, applied };
}

async function discoverMigrations(dir: string): Promise<DiscoveredMigration[]> {
  let entries: { name: string; isDirectory: () => boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const migrations: DiscoveredMigration[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    migrations.push({ name: e.name, upPath: join(dir, e.name, UP_SQL) });
  }
  // Directory names are timestamp-prefixed (`<YYYYMMDDHHMMSS>-<slug>`), so a
  // plain lexical (code-unit) sort is the apply order.
  migrations.sort((a, b) => compareLexical(a.name, b.name));
  return migrations;
}

function checksumOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Stable lexical (code-unit) comparison; the same ordering as `a < b`/`a > b`. */
function compareLexical(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Split a multi-statement SQL string into individual statements. The Kysely
 * raw-SQL executor runs one statement per call, so files with multiple
 * statements (or hand-added data steps) must be split on the statement-separating
 * `;`.
 *
 * A naive `;` split breaks on statement-internal semicolons — which the
 * versioned-apply model explicitly invites via hand-authored DATA migrations
 * (string literals containing `;`, PG function bodies, etc.). This is a single
 * left-to-right scan that tracks lexical context and treats a `;` as a separator
 * ONLY when it is in none of the following states:
 *   - inside a single-quoted literal (`'…'`, with `''` as an embedded quote)
 *   - inside a double-quoted identifier (`"…"`, with `""` as an embedded quote)
 *   - inside a `--`…end-of-line comment
 *   - inside a block comment (`/* … *​/`)
 *   - inside a dollar-quoted body (`$tag$ … $tag$`, tag = `[A-Za-z0-9_]*`)
 *
 * Each statement is trimmed; empty/whitespace-only fragments are dropped. This
 * is not a full SQL parser — it only knows enough lexical structure to find the
 * real statement boundaries.
 */
export function splitSqlStatements(text: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];

    // -- line comment: skip to end of line (or input).
    if (ch === "-" && next === "-") {
      i += 2;
      while (i < n && text[i] !== "\n") i++;
      continue;
    }

    // /* block comment */: skip to closing delimiter (or input).
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2; // consume the closing */ (clamped by the while below)
      continue;
    }

    // Single-quoted literal: consume to the closing quote, treating '' as escape.
    if (ch === "'") {
      i++;
      while (i < n) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2; // embedded ''
          continue;
        }
        if (text[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Double-quoted identifier: consume to the closing quote, treating "" as escape.
    if (ch === '"') {
      i++;
      while (i < n) {
        if (text[i] === '"' && text[i + 1] === '"') {
          i += 2; // embedded ""
          continue;
        }
        if (text[i] === '"') {
          i++;
          break;
        }
        i++;
      }
      continue;
    }

    // Dollar-quoted string: $tag$ … $tag$ with tag = [A-Za-z0-9_]*.
    if (ch === "$") {
      const open = matchDollarTag(text, i);
      if (open !== null) {
        const tag = text.slice(i, open); // includes both $ delimiters
        i = open;
        // Scan for the matching closing tag.
        while (i < n) {
          if (text[i] === "$" && text.startsWith(tag, i)) {
            i += tag.length;
            break;
          }
          i++;
        }
        continue;
      }
    }

    // Statement separator (only reached when in no special state).
    if (ch === ";") {
      const stmt = text.slice(start, i).trim();
      if (stmt.length > 0) statements.push(stmt);
      i++;
      start = i;
      continue;
    }

    i++;
  }

  const tail = text.slice(start).trim();
  if (tail.length > 0) statements.push(tail);
  return statements;
}

/**
 * If a dollar-quote tag opens at `pos` (text[pos] === "$"), return the index
 * just past the opening `$tag$` delimiter; otherwise null. The tag body is
 * `[A-Za-z0-9_]*` and must be terminated by a second `$`.
 */
function matchDollarTag(text: string, pos: number): number | null {
  let j = pos + 1;
  while (j < text.length && /[A-Za-z0-9_]/.test(text[j] as string)) j++;
  if (text[j] === "$") return j + 1;
  return null;
}
