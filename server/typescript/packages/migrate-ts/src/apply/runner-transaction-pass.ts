import { splitSqlStatements } from "../sql/split-statements.js";

/**
 * Adapt a migration file's statements for execution INSIDE the apply runner's own
 * transaction.
 *
 * <h3>Why this exists</h3>
 * A SQLite table rebuild (the recreate-and-copy recipe: a column type change, an
 * evolved `field.enum @values`, a CHECK or FK change) is emitted as a **self-contained,
 * standalone-runnable script** — `PRAGMA foreign_keys = OFF; BEGIN TRANSACTION; …
 * COMMIT; PRAGMA foreign_keys = ON;` — which is the correct recipe when you pipe the
 * file into `sqlite3`. But `applyPending` runs the file's statements inside ONE Kysely
 * transaction (so the data change and its ledger row commit or roll back together), and
 * SQLite rejects a nested `BEGIN` outright:
 *
 *     SQLITE_ERROR: cannot start a transaction within a transaction
 *
 * The result was that **no table-rebuild migration could be applied at all on sqlite —
 * the scaffold's default dialect** — via `--apply`, `apply-pending`, or under Bun. Worse,
 * the failure landed mid-file: the leading statements had already run, so a dependent
 * view could be dropped and not recreated, leaving the database in a partially-applied
 * state with nothing recorded in the ledger. Found by a fresh-adopter test the first time
 * an enum gained a member.
 *
 * <h3>Why the fix is here and not in the emitter</h3>
 * Deleting `BEGIN`/`COMMIT` from the emitted file would fix the runner and silently make
 * the file non-atomic for anyone executing it directly (`sqlite3 db < up.sql`, a Flyway
 * runner via the ADR-0015 output adapter, a hand-rolled deploy script). The file is a
 * committed artifact with more than one consumer. So the file stays a correct standalone
 * script and the RUNNER adapts it to the transaction it already owns — the same division
 * D1 uses, where `applyD1SafetyPass` strips transaction control because D1 wraps the file
 * in an implicit transaction.
 *
 * <h3>What it does</h3>
 * 1. **Drops transaction control** (`BEGIN`/`COMMIT`/`ROLLBACK`/`SAVEPOINT`/`RELEASE`).
 *    The runner's transaction supplies the atomicity the file was asking for.
 * 2. **Reports `PRAGMA foreign_keys = OFF` to the caller as `requiresForeignKeysOff`**
 *    instead of executing it, because the pragma is a **no-op inside a transaction** and
 *    must be issued BEFORE the transaction opens. That is SQLite's own documented
 *    recreate-and-copy procedure, and it is the only form that works.
 *
 *    This used to rewrite it to `PRAGMA defer_foreign_keys = ON`, reasoning that deferral
 *    is "the in-transaction equivalent". **It is not, for this recipe.** Deferral makes
 *    COMMIT check the violations rather than skipping them, and the rebuild's repair step
 *    is `ALTER TABLE __new_x RENAME TO x` — a RENAME, not an INSERT. `DROP TABLE x`'s
 *    implicit delete records one deferred violation per referencing row, nothing ever
 *    decrements that counter, and COMMIT fails:
 *
 *        SQLITE_CONSTRAINT_FOREIGNKEY: FOREIGN KEY constraint failed
 *
 *    So ANY rebuild of a table another populated table references — a CHECK added by
 *    adopting a `field.enum`, an evolved `@values`, a column type change — was
 *    un-appliable on the scaffold's default dialect. Found by adopting MetaObjects into an
 *    existing three-table app (`authors <- books <- reviews`), which is the documented
 *    migration path. Proven with a controlled pair on identical database copies: deferral
 *    fails, `foreign_keys = OFF` outside the transaction applies cleanly with every row
 *    preserved. (D1 cannot do this — its implicit transaction owns the connection — which
 *    is why D1 needed the full referrer cascade of #241 instead.)
 * 3. **Drops the matching `PRAGMA foreign_keys = ON`.** Restoring it is the caller's job,
 *    since the caller is now the one that turned it off.
 * 4. **Lifts `PRAGMA foreign_key_check` out** as `postTransactionChecks`. Run inside the
 *    transaction its result set was simply discarded, so the file's own safety net never
 *    caught anything; the caller now runs it after commit and fails on any row.
 *
 * Postgres migrations contain none of these constructs, so this is a no-op for them —
 * which is why it keys on statement text rather than needing the dialect threaded in.
 */
export interface RunnerTransactionPassResult {
  /** Statements to execute, in order, inside the runner's transaction. */
  statements: string[];
  /** Human-readable adaptations made, for `--verbose`/diagnostics. Empty when untouched. */
  notes: string[];
  /**
   * The file asked for FK enforcement to be off. The caller MUST issue
   * `PRAGMA foreign_keys = OFF` before opening its transaction and restore it after —
   * inside a transaction the pragma does nothing (see the class doc).
   */
  requiresForeignKeysOff: boolean;
  /** Statements to run AFTER the transaction commits; any returned row is a failure. */
  postTransactionChecks: string[];
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END\s+TRANSACTION|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const FK_OFF = /^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|0|false)\s*$/i;
const FK_ON = /^\s*PRAGMA\s+foreign_keys\s*=\s*(ON|1|true)\s*$/i;
const FK_CHECK = /^\s*PRAGMA\s+foreign_key_check\s*$/i;

export function prepareForRunnerTransaction(sqlText: string): RunnerTransactionPassResult {
  const notes: string[] = [];
  const statements: string[] = [];
  const postTransactionChecks: string[] = [];
  let requiresForeignKeysOff = false;

  for (const stmt of splitSqlStatements(sqlText)) {
    if (TRANSACTION_CONTROL.test(stmt)) {
      notes.push(`dropped transaction control (runner owns the transaction): ${firstWords(stmt)}`);
      continue;
    }
    if (FK_OFF.test(stmt)) {
      // Hand the INTENT to the caller rather than executing it here. The pragma is a
      // no-op inside a transaction, and deferral is not a substitute for this recipe.
      requiresForeignKeysOff = true;
      notes.push("lifted `PRAGMA foreign_keys = OFF` out of the transaction (it is a no-op inside one)");
      continue;
    }
    if (FK_ON.test(stmt)) {
      notes.push("dropped `PRAGMA foreign_keys = ON` (the caller restores what the caller disabled)");
      continue;
    }
    if (FK_CHECK.test(stmt)) {
      postTransactionChecks.push(stmt);
      notes.push("deferred `PRAGMA foreign_key_check` to after commit (its rows are discarded inside a transaction)");
      continue;
    }
    statements.push(stmt);
  }

  return { statements, notes, requiresForeignKeysOff, postTransactionChecks };
}

function firstWords(stmt: string): string {
  return stmt.trim().split(/\s+/).slice(0, 3).join(" ");
}
