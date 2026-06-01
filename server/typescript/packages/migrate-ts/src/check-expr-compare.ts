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
