import type { ColumnDefault } from "./types.js";

// src/pg-identity-default.ts
//
// Postgres "auto-sequence" column DEFAULT — the `nextval('<seq>'::regclass)`
// expression a legacy `serial` / `bigserial` / `smallserial` column carries.
// `serial` is historical sugar for `integer` + a sequence + a genuine DEFAULT
// clause — unlike SQLite AUTOINCREMENT or a modern Postgres
// `GENERATED ... AS IDENTITY` column, neither of which surfaces a DEFAULT at all.
// Recognizing this exact shape lets both sides of the pipeline treat a live
// `serial` column as already satisfying `identity: "increment"`, instead of
// reporting its physical default as drift.
//
// Shared between introspection (introspect/postgres.ts, which also cross-checks
// udt_name for the serial type family) and the diff layer (diff/index.ts, which
// only sees the already-parsed default expression and must recognize this same
// shape to avoid proposing a destructive `ALTER COLUMN … DROP DEFAULT` for a live
// `serial` PK with no replacement generation mechanism).
export function isPgAutoSequenceDefault(raw: string | null | undefined): boolean {
  return raw !== null && raw !== undefined && /^nextval\(/i.test(raw);
}

/**
 * A default change that DROPS a live auto-sequence default: the one default shape the diff
 * gates (diff/status.ts), whether it arrives as its own change or folded into a type change.
 */
export function dropsAutoSequenceDefault(from: ColumnDefault | undefined, to: ColumnDefault | undefined): boolean {
  return to === undefined && from?.kind === "expr" && isPgAutoSequenceDefault(from.value);
}
