/**
 * Shared SQLite catalog helpers used by both the Kysely-based introspector
 * (sqlite.ts) and the wrangler-based D1 introspector (d1.ts).
 *
 * All three routines are pure mappings of SQLite's declared type / pragma
 * values to canonical migrate-ts types and carry no I/O dependencies.
 */
import type { ColumnDefault, FkAction } from "../types.js";
import type { SqlType } from "../sql-type.js";

export const SQLITE_EXPR_DEFAULT_PATTERNS = [
  /^current_timestamp$/i,
  /^current_date$/i,
  /^current_time$/i,
  /\(.*\)/,
] as const;

export function parseSqliteDefault(raw: string | null): ColumnDefault | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const isExpr = SQLITE_EXPR_DEFAULT_PATTERNS.some((re) => re.test(raw));
  if (isExpr) return { kind: "expr", value: raw };
  // SQLite stores literal string defaults with surrounding quotes.
  const cleaned = raw.replace(/^'(.*)'$/, "$1");
  return { kind: "literal", value: cleaned };
}

export function sqliteTypeToSqlType(declaredType: string): SqlType {
  const t = declaredType.trim().toUpperCase();

  // SQLite's type affinity is loose; we honor the declared type literally for round-trip stability.
  // Affinity rules per sqlite.org/datatype3.html — adapted to canonical SqlType.

  // text affinity
  const varcharMatch = /^(?:VARCHAR|CHAR|CHARACTER|TEXT)\((\d+)\)$/.exec(t);
  if (varcharMatch) return { kind: "text", maxLength: parseInt(varcharMatch[1] ?? "0", 10) };
  if (/TEXT|CLOB|VARCHAR|CHAR/.test(t)) return { kind: "text" };

  // numeric affinity
  const numMatch = /^(?:NUMERIC|DECIMAL)\((\d+)(?:,\s*(\d+))?\)$/.exec(t);
  if (numMatch) {
    const out: SqlType = { kind: "numeric" };
    if (numMatch[1]) out.precision = parseInt(numMatch[1], 10);
    if (numMatch[2]) out.scale = parseInt(numMatch[2], 10);
    return out;
  }
  if (t === "BOOLEAN" || t === "BOOL") return { kind: "boolean" };
  if (t === "DATE") return { kind: "date" };
  if (t === "DATETIME" || t === "TIMESTAMP") return { kind: "timestamp", withTimezone: false };

  // integer affinity (SQLite stores all INTEGER as 64-bit internally).
  // Distinguish INT (32-bit) from INTEGER/BIGINT (64-bit) for round-trip fidelity:
  // the emitter uses "INT" for integer{32} and "INTEGER" for integer{64}.
  if (t === "INT" || t === "SMALLINT" || t === "TINYINT") return { kind: "integer", bits: 32 };
  if (/INT/.test(t)) return { kind: "integer", bits: 64 };

  // real affinity
  if (/REAL|FLOA|DOUB/.test(t)) return { kind: "real" };

  // blob affinity
  if (t === "BLOB" || t === "") return { kind: "blob" };

  // numeric affinity fallback
  if (/NUMERIC|DECIMAL/.test(t)) return { kind: "numeric" };

  // json (libsql/sqlite have JSON1)
  if (t === "JSON") return { kind: "json" };

  return { kind: "text" };
}

export function sqliteRuleToAction(rule: string): FkAction {
  const r = rule.toUpperCase();
  if (r === "CASCADE") return "cascade";
  if (r === "SET NULL") return "set-null";
  if (r === "RESTRICT") return "restrict";
  return "no-action";
}
