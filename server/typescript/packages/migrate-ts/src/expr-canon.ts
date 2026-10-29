// expr-canon.ts — Postgres's own spelling of an expected CHECK / index expression.
//
// check-expr-compare.ts compares two SQL strings by rewriting both toward one shape. That is
// the only option on SQLite (which stores text as written) and offline (no database), but on
// a live Postgres it is a guess at what the server will do to the text, and every guess is
// either a false drift (an analyser rewrite nobody has hand-coded yet) or a missed one (a
// rewrite that erases meaning: precedence, literal case). The server already knows the
// answer, so the planner asks it: it creates the expected expression on a rolled-back
// scratch table and reads back the definition Postgres stores (expr-canon-probe.ts). The two
// definitions are then equal as plain strings or they are not.
//
// The probe is an optimisation of the TRUTH, never a source of drift. Every case it cannot
// answer (read-only connection, no TEMP privilege, an expression that does not compile
// against the live columns) yields no entry, and the comparison falls back to the string
// normaliser exactly as it was.

import type { CheckDescriptor, ColumnDescriptor, ColumnDefault, IndexDescriptor, TableDescriptor } from "./types.js";
import { checkExprEquals, normalizeCheckExpr } from "./check-expr-compare.js";
import { columnDefaultsEqual } from "./column-default.js";

/** Postgres's stored form of the expression parts of one expected index. */
export interface IndexExprCanon {
  /** `pg_get_indexdef`'s key list, for an expression index. */
  expr?: string;
  /** `pg_get_expr(indpred, …)`, for a partial index. */
  where?: string;
}

/**
 * What the database said about a set of expected descriptors. Keyed by DESCRIPTOR IDENTITY:
 * the diff hands the very objects it was given to every comparison, and an expression
 * string alone cannot name a check (two tables repeat the same text).
 */
export interface ExprCanon {
  readonly checks: ReadonlyMap<CheckDescriptor, string>;
  readonly indexes: ReadonlyMap<IndexDescriptor, IndexExprCanon>;
  /**
   * Each expected column DEFAULT as Postgres stores it (`pg_get_expr(adbin, adrelid)`, read
   * through the introspector's own `parsePgDefault`), keyed by the expected column.
   */
  readonly defaults: ReadonlyMap<ColumnDescriptor, ColumnDefault>;
  /**
   * The expected side IS a catalog (the shadow path), so what only a catalog can say is
   * compared too: a column's GENERATED identity and table/column comments.
   */
  readonly catalog?: boolean;
}

export const NO_EXPR_CANON: ExprCanon = { checks: new Map(), indexes: new Map(), defaults: new Map() };

/**
 * Ask the database how it would store `expected`'s CHECK constraints and index expressions
 * on the columns of `live`. Resolves `undefined` when the question could not be answered; it
 * never throws and never leaves anything behind. An answer may cover only part of what was
 * asked (one expression that does not compile is simply absent).
 */
export type ExprCanonProbe = (
  live: TableDescriptor,
  expected: TableDescriptor,
  /**
   * Live column renames (old name → new name) the scratch table applies before probing, so
   * an expected expression that names a renamed column compiles against the table as it
   * will be after the migration.
   */
  renames?: ReadonlyMap<string, string>,
) => Promise<ExprCanon | undefined>;

/**
 * Whether `expected` and the live `live` constraint are the same. With the database's
 * answer the two are compared as the plain strings Postgres produced; without it, through
 * the string normaliser.
 */
export function checkMatchesLive(
  canon: ExprCanon,
  expected: CheckDescriptor,
  live: CheckDescriptor,
  textColumns?: ReadonlySet<string>,
): boolean {
  const stored = canon.checks.get(expected);
  return stored !== undefined ? stored === live.expression : checkExprEquals(expected.expression, live.expression, textColumns);
}

/** The same decision for one expression part of an index (`expr` or `where`). */
export function indexExprMatchesLive(
  stored: string | undefined,
  expected: string,
  live: string,
): boolean {
  return stored !== undefined ? stored === live : normalizeCheckExpr(expected) === normalizeCheckExpr(live);
}

/**
 * The same decision for one column DEFAULT. With the database's answer, Postgres's spelling
 * of the expected default is compared with the live one (both read by `parsePgDefault`, so
 * `NOW()`/`now()`, `current_date`/`CURRENT_DATE`, a date literal on a timestamptz, `'1e3'`
 * on a double and `'007'` on an integer are equal when Postgres stores them equal, and a
 * real change still differs); without it, the classifier's `kind` and `value` as written.
 */
export function columnDefaultMatchesLive(
  canon: ExprCanon,
  expected: ColumnDescriptor,
  live: ColumnDescriptor,
): boolean {
  const stored = canon.defaults.get(expected);
  return columnDefaultsEqual(stored ?? expected.default, live.default);
}
