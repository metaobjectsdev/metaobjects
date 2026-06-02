import { splitSqlStatements } from "../sql/split-statements.js";

const MAX_STATEMENT_BYTES = 1 * 1024 * 1024; // 1 MB — D1 batch API per-statement limit (path used by `wrangler d1 migrations apply --file`).

export class D1UnsupportedStatementError extends Error {
  constructor(public readonly statement: string, public readonly reason: string) {
    super(`D1 does not support: ${reason} — offending statement: ${statement.slice(0, 80)}`);
    this.name = "D1UnsupportedStatementError";
  }
}

interface PassResult {
  sql: string;
  warnings: string[];
}

export function applyD1SafetyPass(sql: string): string;
export function applyD1SafetyPass(sql: string, opts: { collectWarnings: true }): PassResult;
export function applyD1SafetyPass(sql: string, opts?: { collectWarnings?: boolean }): string | PassResult {
  const collect = opts?.collectWarnings === true;
  const warnings: string[] = [];

  if (sql.length === 0) {
    return collect ? { sql: "", warnings } : "";
  }

  // splitSqlStatements already returns trimmed, non-empty statements.
  const statements = splitSqlStatements(sql);
  const kept: string[] = [];

  for (const stmt of statements) {
    // Reject hard failures up front.
    if (/^\s*(ATTACH|DETACH)\b/i.test(stmt)) {
      throw new D1UnsupportedStatementError(stmt, "ATTACH/DETACH DATABASE");
    }
    if (/^\s*VACUUM\b/i.test(stmt)) {
      throw new D1UnsupportedStatementError(stmt, "VACUUM");
    }

    // Strip explicit transaction control + savepoints.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(stmt)) {
      continue;
    }

    const byteLen = byteLength(stmt);
    if (byteLen > MAX_STATEMENT_BYTES) {
      warnings.push(
        `statement exceeds D1's 1 MB per-statement limit (${byteLen} bytes); ` +
        `may be rejected by D1 at apply time: ${stmt.slice(0, 80)}...`,
      );
    }

    kept.push(stmt);
  }

  // Re-join: each statement on its own line, blank line between top-level DDL
  // statements (matches sqlite emit's output style). splitSqlStatements strips
  // the `;` separators, so re-add exactly one terminator per kept statement.
  const out = kept.map((s) => `${s};`).join("\n\n");
  return collect ? { sql: out, warnings } : out;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
