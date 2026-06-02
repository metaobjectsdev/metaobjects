// src/check-expr-compare.ts
//
// CHECK-expression comparison. Postgres rewrites a stored CHECK body so the raw
// text we generate and the introspected text differ textually but mean the same
// thing. This reduces both to ONE canonical form for comparison. Reliable here
// because every check expression we emit is machine-derived with a simple, known
// shape (comparison / IN / length / regex) — there is no arbitrary author SQL to
// mis-normalize. The rewrites PG applies (verified against a live server):
//   - parenthesizes terms:  `col >= 0 AND col <= 100`  →  `(col >= 0) AND (col <= 100)`
//   - rewrites IN-lists:     `status IN ('A','B')`      →  `status = ANY (ARRAY['A'::text, 'B'::text])`
//   - appends type casts:    string literals gain `::text`
// All three are canonicalized below so an enum/range CHECK introspected from PG
// compares equal to the one we generate (idempotency on the --from-db / verify paths).

/** Canonical form: drop casts/brackets/parens, fold `= ANY (ARRAY[…])` back to `IN`, lower-case, collapse whitespace. */
export function normalizeCheckExpr(expr: string): string {
  const stripped = expr
    .toLowerCase()
    // Drop `::text` / `::"MyType"` type casts PG adds to literals. The lookbehind
    // restricts the strip to a cast that immediately follows a CLOSING single
    // quote (`'open'::text`), so a `::` appearing INSIDE a regex pattern literal
    // (`slug ~ 'a::foo'`) is preserved — otherwise two distinct regex CHECKs would
    // normalize equal and a pattern change would be silently missed.
    .replace(/(?<=')::\s*"?\w+"?/g, "")
    .replace(/[()[\]]/g, " ")     // drop parens AND square brackets (ARRAY[…])
    .replace(/\s+/g, " ")
    .trim();
  // PG stores `col IN (…)` as `col = ANY (ARRAY[…])`; after the bracket strip above
  // that reads `col = any array …`. Fold it back to the `col in …` form we emit.
  return stripped.replace(/=\s*any\s+array/g, "in").replace(/\s+/g, " ").trim();
}

/** True when two CHECK expressions are equivalent after normalization. */
export function checkExprEquals(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return normalizeCheckExpr(a) === normalizeCheckExpr(b);
}

/**
 * `CHECK (<expr>)` → `<expr>` (balanced outer wrapper); returns input unchanged
 * if there is no CHECK wrapper. Tolerates a trailing constraint modifier suffix
 * (`pg_get_constraintdef` can return `CHECK (<expr>) NOT VALID`) so the wrapper
 * still strips cleanly to the inner expression instead of falling through to the
 * unchanged-input fallback (which would cause spurious drop+add churn).
 */
export function stripCheckWrapper(def: string): string {
  const m = /^\s*CHECK\s*\((.*)\)(?:\s+NOT\s+VALID)?\s*$/is.exec(def);
  return m ? m[1]!.trim() : def.trim();
}
