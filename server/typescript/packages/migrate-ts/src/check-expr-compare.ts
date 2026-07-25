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
    // Unwrap double-quoted IDENTIFIERS only (`"enumval"` → `enumval`). We emit a
    // quoted column (`"enumVal" IN (...)`) so a mixed-case column is valid SQL;
    // PG's introspected definition quotes mixed-case identifiers too. Unwrapping
    // makes the generated and introspected forms compare equal, and keeps a
    // legacy unquoted check matching its quoted re-emit. The pattern matches only
    // a quote-pair wrapping a bare identifier (word chars), so a `"` INSIDE a
    // single-quoted string/regex literal (`slug ~ 'a"b'`) is preserved — two
    // distinct patterns must not normalize equal.
    .replace(/"(\w+)"/g, "$1")
    .replace(/[()[\]]/g, " ")     // drop parens AND square brackets (ARRAY[…])
    .replace(/\s+/g, " ")
    .trim();
  // PG stores `col IN (…)` as `col = ANY (ARRAY[…])`; after the bracket strip above
  // that reads `col = any array …`. Fold it back to the `col in …` form we emit.
  const folded = stripped.replace(/=\s*any\s+array/g, "in").replace(/\s+/g, " ").trim();
  // Normalize spacing AROUND COMMAS so a generated IN-list (`'a', 'b'`) compares equal
  // to a hand-written one (`'a','b'`) — the separator commas are never semantically
  // meaningful, and a hand SQLite migration omits the space. This is done OUTSIDE
  // single-quoted literals only: a comma inside a string/regex literal (`'a, b'`, or a
  // quantifier `'{1, 3}'`) IS meaningful, so two checks that differ only there must
  // stay distinct (else a real regex/predicate change reads as clean drift).
  return collapseCommaSpacingOutsideQuotes(folded);
}

/** Collapse `\s*,\s*` → `,` OUTSIDE single-quoted literals (see normalizeCheckExpr). */
function collapseCommaSpacingOutsideQuotes(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const ch = s[i]!;
    if (ch === "'") {
      // Copy the single-quoted literal verbatim ('' escapes honored) — never touched.
      const start = i;
      i++;
      while (i < n) {
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += s.slice(start, i);
      continue;
    }
    if (ch === ",") {
      out = out.replace(/\s+$/, "");           // drop whitespace already emitted before it
      out += ",";
      i++;
      while (i < n && /\s/.test(s[i]!)) i++;    // skip whitespace after it
      continue;
    }
    out += ch;
    i++;
  }
  return out;
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
