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
      for (const stmt of splitStatements(text)) {
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
  // plain lexical sort is the apply order.
  migrations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return migrations;
}

function checksumOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Split a multi-statement SQL string into individual statements. The Kysely
 * raw-SQL executor runs one statement per call, so files with multiple
 * statements (or hand-added data steps) must be split. Naive `;` split is
 * adequate for migration DDL/DML; statement-internal semicolons would require a
 * real parser, which migrations don't need here.
 */
function splitStatements(text: string): string[] {
  return text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
