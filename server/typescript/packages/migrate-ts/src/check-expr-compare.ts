// src/check-expr-compare.ts
//
// CHECK-expression comparison. Postgres rewrites a stored CHECK body so the raw
// text we generate and the introspected text differ textually but mean the same
// thing. This reduces both to ONE canonical form for comparison.
//
// It was written when every expression reaching it was machine-derived with a simple,
// known shape (comparison / IN / length / regex), and the header said there was "no
// arbitrary author SQL to mis-normalize". That stopped being true when `index.lookup`'s
// `@expr` and `@where` began using the same canonicalizer: those are AUTHOR-written SQL.
// Each rewrite below is therefore justified on the stronger ground it now needs — that
// the difference it erases is not semantic in ANY valid SQL, not merely in the shapes we
// emit. The rewrites PG applies (verified against a live server):
//   - parenthesizes terms:  `col >= 0 AND col <= 100`  →  `(col >= 0) AND (col <= 100)`
//   - rewrites IN-lists:     `status IN ('A','B')`      →  `status = ANY (ARRAY['A'::text, 'B'::text])`
//   - appends type casts:    string literals gain `::text`
// All three are canonicalized below so an enum/range CHECK introspected from PG
// compares equal to the one we generate (idempotency on the --from-db / verify paths).

/**
 * Canonical form: drop casts/brackets/parens, fold `= ANY (ARRAY[…])` back to `IN`,
 * lower-case, collapse whitespace, and collapse spacing around commas and SYMBOLIC
 * operators (outside single-quoted literals).
 */
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
  // Normalize spacing around COMMAS and SYMBOLIC OPERATORS, so the spelling a human
  // writes compares equal to the one Postgres hands back.
  //
  // Commas: a generated IN-list (`'a', 'b'`) must equal a hand-written one (`'a','b'`) —
  // a hand SQLite migration omits the space.
  //
  // Operators: `pg_get_expr` re-emits every operator SPACED, and a person authoring an
  // `index.lookup @expr` writes it tight. So `(request_context->>'device_id')` — the
  // natural spelling — normalized to `request_context->>'device_id'` while the live index
  // introspected to `request_context ->> 'device_id'`, and `verify --db` proposed DROP +
  // CREATE against an index the database already held, exactly as declared. Casts and
  // redundant parens were ALREADY canonicalized above, so the one difference left was the
  // spacing — and it was the one difference a human actually produces.
  //
  // Safe because whitespace around a symbolic operator is not semantic in ANY valid SQL:
  // where two spellings differ only there, at most one of them parses. Postgres lexes a
  // maximal run of operator characters as a SINGLE token, so `a =- 1` is not `a = -1`
  // spelled differently — it is a syntax error. Only SYMBOLIC operators are touched;
  // collapsing around an alphabetic one would turn `a AND b` into `aANDb`.
  //
  // Both are done OUTSIDE single-quoted literals: a comma or an operator character inside
  // a string/regex literal (`'a, b'`, a quantifier `'{1, 3}'`, a pattern `'a ->> b'`) IS
  // meaningful, so two checks differing only there must stay distinct — else a real
  // pattern change reads as clean drift, which is this file's failure in the other
  // direction and the worse of the two.
  return collapseSeparatorSpacingOutsideQuotes(folded);
}

/**
 * Postgres' operator characters. A maximal run of these is ONE operator token — which is
 * why `->>` and `!~*` survive intact rather than being split apart. Derived as the
 * character SET rather than a list of known operators, so a spelling this file has never
 * seen (`@>`, `?|`, a user-defined operator) normalizes by the same rule instead of
 * needing an edit here.
 */
const OPERATOR_CHARS = new Set([..."+-*/<>=~!@#%^&|?"]);

/**
 * Collapse whitespace around commas and symbolic-operator runs, OUTSIDE single-quoted
 * literals (see normalizeCheckExpr).
 */
function collapseSeparatorSpacingOutsideQuotes(s: string): string {
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
    if (OPERATOR_CHARS.has(ch)) {
      out = out.replace(/\s+$/, "");           // drop whitespace already emitted before it
      // Copy the WHOLE run, so `->>` stays one token rather than three.
      while (i < n && OPERATOR_CHARS.has(s[i]!)) { out += s[i]!; i++; }
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
