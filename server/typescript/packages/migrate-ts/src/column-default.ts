import type { ColumnDescriptor } from "./types.js";

/**
 * The SQLite insert-time default for a timestamp column: the current UTC time in the ISO
 * form generated code writes (`2026-09-26T14:08:05.053Z`, what `Date.toISOString()` returns).
 * `CURRENT_TIMESTAMP` writes `2026-09-26 14:08:05` instead, so a table mixing
 * database-defaulted and application-written rows held two spellings that neither sort nor
 * compare as the same instant. SQLite reads this expression back without the parentheses
 * the emitter wraps it in, so the expected snapshot carries it bare.
 */
export const SQLITE_ISO_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

const CURRENT_TIMESTAMP = /^current_timestamp$/i;

/** A SQLite timestamp default that means "now", in either spelling. */
function isSqliteNow(d: NonNullable<ColumnDescriptor["default"]>): boolean {
  return d.kind === "expr" && (d.value === SQLITE_ISO_NOW || CURRENT_TIMESTAMP.test(d.value));
}

/**
 * Equality of two column defaults (kind and text). Its own module so the diff and the rename
 * heuristic can both use it without importing each other.
 *
 * One equivalence: `CURRENT_TIMESTAMP` and {@link SQLITE_ISO_NOW} both mean "now". A SQLite
 * column created before the ISO default keeps `CURRENT_TIMESTAMP` until something else
 * rebuilds its table — reporting the spelling as drift would recreate-and-copy every such
 * table on the next migrate, for no change in meaning.
 */
export function columnDefaultsEqual(a: ColumnDescriptor["default"], b: ColumnDescriptor["default"]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  if (isSqliteNow(a) && isSqliteNow(b)) return true;
  return a.kind === b.kind && a.value === b.value;
}
