// src/check-expr-compare.ts
//
// CHECK-expression comparison. Postgres rewrites a stored CHECK body — adding
// parens around terms, normalizing whitespace/case — so the raw text we generate
// (`col >= 0 AND col <= 100`) and the introspected text (`(col >= 0) AND (col <= 100)`)
// differ textually but mean the same thing. This reduces both to ONE canonical
// form for comparison. Reliable here because every check expression we emit is
// machine-derived with a simple, known shape (comparison / IN / length / regex) —
// there is no arbitrary author SQL to mis-normalize.

/** Canonical form: drop all parens, collapse whitespace, trim, lower-case. */
export function normalizeCheckExpr(expr: string): string {
  return expr
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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
