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
 * 2. **Rewrites `PRAGMA foreign_keys = OFF` to `PRAGMA defer_foreign_keys = ON`.** This is
 *    not cosmetic: `foreign_keys` is a **no-op inside a transaction**, so the rebuild would
 *    lose its FK protection precisely where it needs it (dropping a referenced table).
 *    `defer_foreign_keys` is the in-transaction equivalent — enforcement is deferred to
 *    commit — and is exactly what the D1 cascade emitter uses for the same reason.
 * 3. **Drops the matching `PRAGMA foreign_keys = ON`**, whose only job was to undo (1);
 *    `defer_foreign_keys` resets itself at commit.
 *
 * Postgres migrations contain none of these constructs, so this is a no-op for them —
 * which is why it keys on statement text rather than needing the dialect threaded in.
 */
export interface RunnerTransactionPassResult {
  /** Statements to execute, in order, inside the runner's transaction. */
  statements: string[];
  /** Human-readable adaptations made, for `--verbose`/diagnostics. Empty when untouched. */
  notes: string[];
}

const TRANSACTION_CONTROL = /^\s*(BEGIN|COMMIT|END\s+TRANSACTION|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const FK_OFF = /^\s*PRAGMA\s+foreign_keys\s*=\s*(OFF|0|false)\s*$/i;
const FK_ON = /^\s*PRAGMA\s+foreign_keys\s*=\s*(ON|1|true)\s*$/i;

export function prepareForRunnerTransaction(sqlText: string): RunnerTransactionPassResult {
  const notes: string[] = [];
  const statements: string[] = [];

  for (const stmt of splitSqlStatements(sqlText)) {
    if (TRANSACTION_CONTROL.test(stmt)) {
      notes.push(`dropped transaction control (runner owns the transaction): ${firstWords(stmt)}`);
      continue;
    }
    if (FK_OFF.test(stmt)) {
      // Preserve the INTENT. A bare foreign_keys pragma does nothing inside a
      // transaction, so keeping it verbatim would silently drop FK protection.
      statements.push("PRAGMA defer_foreign_keys = ON");
      notes.push("rewrote `PRAGMA foreign_keys = OFF` to `PRAGMA defer_foreign_keys = ON` (the in-transaction equivalent)");
      continue;
    }
    if (FK_ON.test(stmt)) {
      notes.push("dropped `PRAGMA foreign_keys = ON` (defer_foreign_keys resets at commit)");
      continue;
    }
    statements.push(stmt);
  }

  return { statements, notes };
}

function firstWords(stmt: string): string {
  return stmt.trim().split(/\s+/).slice(0, 3).join(" ");
}
