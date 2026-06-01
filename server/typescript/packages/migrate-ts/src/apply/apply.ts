import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Kysely, type Transaction, sql } from "kysely";
import {
  appliedRecords,
  DEFAULT_LEDGER_SCHEMA,
  deleteApplied,
  ensureLedger,
  type LedgerDialect,
  type LedgerOptions,
  MIGRATIONS_TABLE,
  recordApplied,
} from "./ledger.js";
import { splitSqlStatements } from "../sql/split-statements.js";

// Re-exported here for back-compat: `splitSqlStatements` historically lived in
// this module. Its canonical home is now ../sql/split-statements.js (shared with
// the D1 safety pass), but consumers importing from apply.js keep working.
export { splitSqlStatements };

/** The per-migration up-SQL filename, shared with writeMigration's layout. */
const UP_SQL = "up.sql";
/** The per-migration down-SQL filename, shared with writeMigration's layout. */
const DOWN_SQL = "down.sql";

export interface ApplyPendingOptions {
  /** When true, compute + return the plan but apply nothing. */
  dryRun: boolean;
  /**
   * Target dialect. Decides ledger schema-qualification (pg) and whether the
   * Postgres advisory lock is taken. Defaults to `sqlite` (no schema, no lock)
   * to preserve the original single-DB behavior for callers that omit it.
   */
  dialect?: LedgerDialect;
  /** Multi-tenant ledger location + advisory-lock name. Defaults preserve current behavior. */
  ledger?: LedgerOptions;
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
  /** Absolute path to the down.sql file (may not exist on disk). */
  downPath: string;
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
  const dialect = opts.dialect ?? "sqlite";
  const ledger = opts.ledger;

  // Serialize concurrent applies against the same ledger with a Postgres
  // session advisory lock (no-op on SQLite). Held for the whole apply duration.
  return withAdvisoryLock(db, dialect, ledger, async () => {
    await ensureLedger(db, dialect, ledger);
    const recorded = await appliedRecords(db, dialect, ledger);

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
      await runSqlFileWithLedgerMutation(db, text, (trx) =>
        recordApplied(trx, m.name, checksum, dialect, ledger),
      );
      applied.push(m.name);
    }

    return { pending: pendingNames, applied };
  });
}

export interface RollbackToOptions {
  /** Target dialect. Decides ledger schema-qualification + advisory lock. Defaults to `sqlite`. */
  dialect?: LedgerDialect;
  /** Multi-tenant ledger location + advisory-lock name. Defaults preserve current behavior. */
  ledger?: LedgerOptions;
}

export interface RollbackToResult {
  /** Migration names rolled back, in execution (reverse-chronological) order. */
  rolledBack: string[];
}

/**
 * Roll back applied migrations newer than `target` (or all, when `target` is
 * `null`), in REVERSE lexical order — running each migration's `down.sql` then
 * deleting its ledger row, in ONE transaction per migration. `target` is itself
 * retained (only ledger names strictly-greater than it are rolled back; lexical
 * = chronological given the zero-padded timestamp prefix).
 *
 * An empty / whitespace-only `down.sql` THROWS before that migration is
 * unrecorded — data-migration downs are hand-authored and must never be
 * silently skipped. `down.sql` is split with the same {@link splitSqlStatements}
 * the up-path uses. Wrapped in the same Postgres session advisory lock as
 * {@link applyPending} (no-op on SQLite).
 */
export async function rollbackTo(
  db: Kysely<Record<string, unknown>>,
  dir: string,
  target: string | null,
  opts: RollbackToOptions = {},
): Promise<RollbackToResult> {
  const dialect = opts.dialect ?? "sqlite";
  const ledger = opts.ledger;

  return withAdvisoryLock(db, dialect, ledger, async () => {
    await ensureLedger(db, dialect, ledger);
    const recorded = await appliedRecords(db, dialect, ledger);

    const discovered = await discoverMigrations(dir);
    const byName = new Map(discovered.map((m) => [m.name, m]));

    // Applied names strictly-greater than target (or all when target is null),
    // newest-first.
    const toRollback = [...recorded.keys()]
      .filter((name) => target === null || compareLexical(name, target) > 0)
      .sort((a, b) => compareLexical(b, a));

    const rolledBack: string[] = [];
    for (const name of toRollback) {
      const m = byName.get(name);
      if (m === undefined) {
        throw new Error(
          `rollback '${name}': migration directory is missing (cannot read its down.sql)`,
        );
      }
      const downText = await readDownSql(m.downPath, name);
      if (downText.trim().length === 0) {
        throw new Error(
          `rollback '${name}': down.sql is empty — data-migration downs must be ` +
            `hand-authored, never silently skipped.`,
        );
      }
      // Run the down SQL + the ledger delete in ONE transaction.
      await runSqlFileWithLedgerMutation(db, downText, (trx) =>
        deleteApplied(trx, name, dialect, ledger),
      );
      rolledBack.push(name);
    }

    return { rolledBack };
  });
}

/**
 * Read a migration's `down.sql`. Distinguishes a MISSING file (never authored —
 * ENOENT) from a present-but-empty one: a missing down throws a "not found"
 * error (a never-written down has a different cause than a deliberately-blank
 * one), while genuinely-empty content falls through to the caller's empty-down
 * check. Both remain hard errors; this only reports the right cause.
 */
async function readDownSql(path: string, name: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (isErrnoException(err) && err.code === "ENOENT") {
      throw new Error(
        `rollback '${name}': down.sql not found for migration '${name}' ` +
          `(expected at ${path}) — data-migration downs must be hand-authored.`,
      );
    }
    throw err;
  }
}

/** Narrow an unknown caught value to a Node errno exception (has a string `code`). */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === "string"
  );
}

/**
 * Run `body` while holding a Postgres SESSION-level advisory lock for mutual
 * exclusion across concurrent applies/rollbacks against the same ledger.
 *
 * pg session advisory locks are per-connection, so the lock is taken on a single
 * dedicated connection (`db.connection()`) held for the entire `body` duration;
 * `body` still runs its own migrations via `db.transaction()` on the pool — the
 * lock only needs to be held by some session for mutual exclusion. SESSION (not
 * transaction) level so a `CREATE INDEX CONCURRENTLY` in a migration cannot
 * deadlock against it. On SQLite (single-writer; no advisory locks) it is a
 * pass-through.
 */
async function withAdvisoryLock<T>(
  db: Kysely<Record<string, unknown>>,
  dialect: LedgerDialect,
  ledger: LedgerOptions | undefined,
  body: () => Promise<T>,
): Promise<T> {
  if (dialect !== "postgres") {
    return body();
  }
  const key = advisoryKey(lockNameFor(ledger));
  return db.connection().execute(async (lockConn) => {
    // Bind the key as a parameter cast to bigint (a signed 64-bit int as a
    // decimal string, possibly negative) — matching the runner's
    // `pg_advisory_lock($1::bigint)`.
    await sql`SELECT pg_advisory_lock(${key}::bigint)`.execute(lockConn);
    try {
      return await body();
    } finally {
      // Releasing the lock must NOT mask an in-flight body error: a throw out of
      // `finally` would replace any pending body rejection. Log-and-swallow the
      // unlock failure so the body's error (if any) propagates intact. The lock
      // is session-scoped, so it is released anyway when the connection closes.
      try {
        await sql`SELECT pg_advisory_unlock(${key}::bigint)`.execute(lockConn);
      } catch (unlockErr) {
        console.warn(
          `migrate-ts: failed to release advisory lock (it will be freed when the ` +
            `session ends): ${String(unlockErr)}`,
        );
      }
    }
  });
}

/** Default advisory-lock name: explicit `lockName`, else `<schema>.<table>`. */
function lockNameFor(ledger: LedgerOptions | undefined): string {
  if (ledger?.lockName !== undefined) return ledger.lockName;
  const schema = ledger?.schema ?? DEFAULT_LEDGER_SCHEMA;
  const table = ledger?.table ?? MIGRATIONS_TABLE;
  return `${schema}.${table}`;
}

/** Stable 64-bit signed advisory-lock key (decimal string) from a lock name. */
function advisoryKey(name: string): string {
  const hash = createHash("sha256").update(name).digest();
  return hash.readBigInt64BE(0).toString();
}

/**
 * Run a migration SQL file's statements followed by a ledger mutation, all in
 * ONE Kysely transaction on the pool. The file is split with
 * {@link splitSqlStatements} and each statement executed in order, then
 * `mutateLedger` records/unrecords the migration — so the data change and its
 * ledger row commit or roll back together. Any failure rolls the whole
 * transaction back (leaving the ledger untouched) and propagates to the caller.
 *
 * Shared by both the apply (up.sql + recordApplied) and rollback
 * (down.sql + deleteApplied) paths.
 */
async function runSqlFileWithLedgerMutation(
  db: Kysely<Record<string, unknown>>,
  sqlText: string,
  mutateLedger: (trx: Transaction<Record<string, unknown>>) => Promise<void>,
): Promise<void> {
  await db.transaction().execute(async (trx) => {
    for (const stmt of splitSqlStatements(sqlText)) {
      await sql.raw(stmt).execute(trx);
    }
    await mutateLedger(trx);
  });
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
    migrations.push({
      name: e.name,
      upPath: join(dir, e.name, UP_SQL),
      downPath: join(dir, e.name, DOWN_SQL),
    });
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
