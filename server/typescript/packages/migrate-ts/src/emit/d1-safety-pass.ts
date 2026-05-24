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

  const statements = splitStatements(sql);
  const kept: string[] = [];

  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed.length === 0) continue;

    // Reject hard failures up front.
    if (/^\s*(ATTACH|DETACH)\b/i.test(trimmed)) {
      throw new D1UnsupportedStatementError(trimmed, "ATTACH/DETACH DATABASE");
    }
    if (/^\s*VACUUM\b/i.test(trimmed)) {
      throw new D1UnsupportedStatementError(trimmed, "VACUUM");
    }

    // Strip explicit transaction control + savepoints.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(trimmed)) {
      continue;
    }

    if (byteLength(trimmed) > MAX_STATEMENT_BYTES) {
      const byteLen = byteLength(trimmed);
      warnings.push(
        `statement exceeds D1's 1 MB per-statement limit (${byteLen} bytes); ` +
        `may be rejected by D1 at apply time: ${trimmed.slice(0, 80)}...`,
      );
    }

    kept.push(trimmed);
  }

  // Re-join: each statement on its own line, blank line between top-level
  // DDL statements (matches sqlite emit's output style).
  const out = kept.join("\n\n");
  return collect ? { sql: out, warnings } : out;
}

/**
 * Split SQL on `;` boundaries, respecting single-quoted strings (SQL uses
 * '' to escape a single quote inside a literal — two consecutive quotes toggle
 * inString twice, net zero, which is exactly what we want).
 * Sufficient for our DDL output; we don't generate dollar-quoted blocks or
 * other exotic SQLite literals.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") {
      buf += c;
      inString = !inString;
      continue;
    }
    if (c === ";" && !inString) {
      buf += ";";
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
