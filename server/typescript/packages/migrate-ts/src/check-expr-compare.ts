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
//   - parenthesizes a cast OPERAND: `x::integer`        →  `(x)::integer`
//   - respells a cast TARGET canonically: `x::int`      →  `(x)::integer`
// All five are canonicalized below so an enum/range CHECK introspected from PG
// compares equal to the one we generate (idempotency on the --from-db / verify paths).
//
// The last two are why a cast-bearing `@expr` used to drift FOREVER. The paren-strip
// turns PG's added parens into a space, so `(x)::integer` reduced to `x ::integer` while
// the authored `x::integer` stayed tight — and `:` is not one of PG's operator characters,
// so the operator-run collapse never reached it. On top of that, PG re-emits the target
// type in its canonical spelling, so an authored `int`/`varchar`/`timestamptz` could not
// match the `integer`/`character varying`/`timestamp with time zone` it got back. Both
// are fixed in the quote-aware walker below, which is the only place that can tell a real
// cast from a `::` inside a regex literal.

/**
 * Canonical form: drop casts/brackets/parens, fold `= ANY (ARRAY[…])` back to `IN`,
 * lower-case, collapse whitespace, canonicalize cast target types, and collapse spacing
 * around commas, casts and SYMBOLIC operators (outside single-quoted literals).
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
 * Cast target types PG respells, mapped to the spelling `pg_get_constraintdef` /
 * `pg_get_expr` hand back. MEASURED against PostgreSQL 16.15 by creating one CHECK per
 * alias and reading the definition back — not derived from the docs, because the two
 * that would most easily have been missed (`timestamp` → `timestamp WITHOUT time zone`,
 * `float` → `double precision`) only show up when you ask the server.
 *
 * The four `… time zone` forms map to THEMSELVES on purpose: they are already canonical,
 * and they exist here to be matched BEFORE the shorter `timestamp` / `time` aliases would
 * otherwise rewrite their leading word into `timestamp without time zone with time zone`.
 * No other canonical form needs that guard — `\b` already stops `int` matching inside
 * `integer`, `char` inside `character`, and `bool` inside `boolean`.
 */
const CAST_TYPE_ALIASES: Record<string, string> = {
  "timestamp with time zone": "timestamp with time zone",
  "timestamp without time zone": "timestamp without time zone",
  "time with time zone": "time with time zone",
  "time without time zone": "time without time zone",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  varchar: "character varying",
  varbit: "bit varying",
  bpchar: "character",
  char: "character",
  int8: "bigint",
  int4: "integer",
  int2: "smallint",
  int: "integer",
  float8: "double precision",
  float4: "real",
  float: "double precision",
  bool: "boolean",
  decimal: "numeric",
};

/**
 * Anchored alternation over the alias keys, LONGEST FIRST — JS alternation is
 * first-match-wins, not longest-match, so the order is load-bearing and is derived here
 * rather than trusted to the literal order above.
 */
const CAST_TYPE_RE = new RegExp(
  `^(${Object.keys(CAST_TYPE_ALIASES)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`,
);

/** Numeric target types, for the literal-cast rule in isElidableCast. */
const NUMERIC_CAST_TYPES = new Set([
  "numeric", "integer", "bigint", "smallint", "real", "double precision",
]);

/**
 * Read the target type of a cast at `i`, canonicalized. Returns the canonical spelling and
 * how many characters it consumed (0 for an unrecognizable target — `::` before something
 * this walker should just copy through).
 */
function readCastTarget(s: string, i: number): { type: string; consumed: number } {
  const alias = CAST_TYPE_RE.exec(s.slice(i));
  if (alias) return { type: CAST_TYPE_ALIASES[alias[1]!]!, consumed: alias[1]!.length };
  // Any other type name — `uuid`, `jsonb`, `text`, `public.mytype`. PG's spelling and ours
  // already agree for these, so it passes through as written.
  const plain = /^[a-z_][\w.]*/.exec(s.slice(i));
  if (plain) return { type: plain[0], consumed: plain[0].length };
  return { type: "", consumed: 0 };
}

/**
 * True when a cast is one Postgres ADDS or ELIDES on its own, so its presence on one side
 * and absence on the other is not a difference in meaning. Two cases, both found by a
 * differential against live PG 16.15 rather than by reading the SQL:
 *
 *  1. `::text` on a `->>` / `#>>` result. Those operators are DEFINED to return text, so
 *     PG drops the author's explicit cast; `(payload->>'k')::text` comes back as
 *     `(payload ->> 'k'::text)`, whose only cast belongs to the KEY literal.
 *  2. A numeric cast on a NUMERIC LITERAL. PG coerces the literal to the column's type, so
 *     `amt > 0` on a numeric column comes back as `amt > (0)::numeric`.
 *
 * Case 2 is the rule this file has always applied to STRING literals — the post-quote
 * `'open'::text` strip up in normalizeCheckExpr — extended to the numeric ones, where the
 * same PG behaviour produces the same permanent drift. Both are deliberately narrow: a
 * cast on anything that is not a literal or a text-returning operator is a REAL cast and
 * survives, because erasing it would let a genuine change read as clean drift.
 */
function isElidableCast(type: string, lhs: string): boolean {
  // `->>` / `#>>` yield text; a following `::text` cannot change anything.
  if (type === "text" && /(?:->>|#>>)\s*(?:'(?:[^']|'')*'|[\w."]+)$/.test(lhs)) return true;
  // A numeric literal cast to a numeric type.
  if (NUMERIC_CAST_TYPES.has(type) && /(?:^|[^\w."'])\d+(?:\.\d+)?$/.test(lhs)) return true;
  return false;
}

/**
 * Collapse whitespace around commas, casts and symbolic-operator runs, and canonicalize
 * cast target types — all OUTSIDE single-quoted literals (see normalizeCheckExpr).
 *
 * The cast work lives in this walker rather than in a `.replace()` up in the pipeline
 * because only a quote-aware pass can tell a real `x::int` cast from the `::int` inside
 * a regex literal (`slug ~ 'a::int'`). A blind replace would rewrite the pattern, and two
 * distinct regex CHECKs would compare equal — a real change reading as clean drift, which
 * is this file's failure in the worse direction.
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

    // A separator token: a comma, a `::` cast, or a symbolic-operator run. All three bind
    // tight to what PRECEDES them, so any whitespace already emitted before them is
    // dropped. They differ only in whether what FOLLOWS binds tight too.
    let token: string | undefined;
    let tightAfter = true;
    if (ch === ",") {
      token = ",";
      i++;
    } else if (ch === ":" && s[i + 1] === ":") {
      i += 2;
      while (i < n && /\s/.test(s[i]!)) i++;   // `:: integer` → `::integer`
      const target = readCastTarget(s, i);
      i += target.consumed;
      const lhs = out.replace(/\s+$/, "");
      token = isElidableCast(target.type, lhs) ? "" : `::${target.type}`;
      out = lhs;
      // Whitespace AFTER the target type is load-bearing — `x::integer is not null` must
      // not become `x::integeris not null` — so the cast, unlike a comma or an operator,
      // binds tight on its left only.
      tightAfter = false;
    } else if (OPERATOR_CHARS.has(ch)) {
      const start = i;
      // Take the WHOLE run, so `->>` stays one token rather than three.
      while (i < n && OPERATOR_CHARS.has(s[i]!)) i++;
      token = s.slice(start, i);
    }

    if (token !== undefined) {
      out = out.replace(/\s+$/, "") + token;
      if (tightAfter) while (i < n && /\s/.test(s[i]!)) i++;
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
