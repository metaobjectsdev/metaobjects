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
// Three more are folded back by foldPgAnalyzerRewrites and PAREN_COLUMN_TEXT_CAST: a
// one-element `x IN (v)` stored as `x = v`, `a IS NOT DISTINCT FROM b` stored as
// `NOT (a IS DISTINCT FROM b)`, and `(varchar_col)::text` stored for a text operator.
//
// Everything textual runs OUTSIDE single-quoted literals (mapOutsideLiterals). One thing is
// still NOT canonicalized: dropping every bracket erases precedence, so `(a OR b) AND c` and
// `a OR (b AND c)` compare equal. Fixing that takes the server's own canonical form, not more
// string rules.
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
 * `` `status` `` → `status`, OUTSIDE single-quoted literals. SQLite stores a CHECK exactly as
 * it was written, and Drizzle-written migrations quote identifiers with backticks, so the
 * stored text and the double-quoted one generated here would otherwise never compare equal.
 * A backtick inside a literal (a regex pattern) is data and is left alone.
 */
function unwrapBacktickIdentifiers(expr: string): string {
  return expr
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/`(\w+)`/g, "$1")))
    .join("");
}

const NO_COLUMNS: ReadonlySet<string> = new Set();

/**
 * `(col)::text` — the form Postgres writes when it casts a `varchar` column to `text` to reach
 * a text operator or function (`length((code)::text)`, `(a)::text < (b)::text`,
 * `((region)::text IS DISTINCT FROM 'eu'::text)`). Matched BEFORE the brackets are stripped,
 * while `(col)` can still be told from a call `f(col)`: the opening bracket must not follow a
 * word character. It is dropped only for a column the caller names as text-family
 * (`text` / `varchar`), where the cast changes nothing; on any other column it changes the
 * operator (citext) or the value (`char(n)` trims its padding), so it stays and reads as drift.
 */
const PAREN_COLUMN_TEXT_CAST = /(?<!\w)\(\s*([a-z_]\w*)\s*\)\s*::\s*text\b/g;

/** Split on single-quoted literals ('' escapes honored) and rewrite only the text between them. */
function mapOutsideLiterals(s: string, fn: (part: string, index: number) => string): string {
  return s
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 === 1 ? part : fn(part, i)))
    .join("");
}

/**
 * Index of the `)` closing the `(` at `open`, skipping single-quoted literals and
 * double-quoted identifiers; -1 when unbalanced.
 */
function matchingParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') {
      i++;
      while (i < s.length && !(s[i] === ch && s[i + 1] !== ch)) i += s[i] === ch ? 2 : 1;
    } else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** `inner` with its depth-0 text (literals, quoted identifiers and bracketed groups blanked). */
function topLevelText(inner: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!;
    if (ch === "'" || ch === '"') {
      i++;
      while (i < inner.length && !(inner[i] === ch && inner[i + 1] !== ch)) i += inner[i] === ch ? 2 : 1;
      out += " ";
    } else if (ch === "(" || ch === "[") { depth++; out += " "; }
    else if (ch === ")" || ch === "]") { depth--; out += " "; }
    else out += depth === 0 ? ch : " ";
  }
  return out;
}

/**
 * `NOT (A IS DISTINCT FROM B)` → `(A IS NOT DISTINCT FROM B)`: Postgres has a node only for
 * `IS DISTINCT FROM`, so it stores `a IS NOT DISTINCT FROM b` in the first spelling. Run on
 * the RAW expression, while the brackets still show what `NOT` applies to: only `NOT`
 * followed by one balanced bracketed operand that is exactly a single `IS DISTINCT FROM`
 * comparison (no depth-0 `and` / `or` / `not`) is folded. `(NOT x) IS DISTINCT FROM y`
 * has no such operand and stays as written, so the fold cannot invent an equality.
 */
function foldNotDistinctFrom(expr: string): string {
  let out = "";
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i]!;
    if (ch === "'" || ch === '"') {
      const start = i++;
      while (i < expr.length && !(expr[i] === ch && expr[i + 1] !== ch)) i += expr[i] === ch ? 2 : 1;
      i++;
      out += expr.slice(start, i);
      continue;
    }
    const not = /^not\s*\(/i.exec(expr.slice(i));
    if (not && !/[\w.]/.test(expr[i - 1] ?? " ")) {
      const open = i + not[0].length - 1;
      const close = matchingParen(expr, open);
      if (close !== -1) {
        const inner = expr.slice(open + 1, close);
        const top = topLevelText(inner);
        if (top.match(/\bis\s+distinct\s+from\b/gi)?.length === 1 && !/\b(?:and|or|not)\b/i.test(top)) {
          out += `(${inner.replace(/\bis\s+distinct\s+from\b/i, "is not distinct from")})`;
          i = close + 1;
          continue;
        }
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * Two rewrites Postgres makes while ANALYZING an expression, which no textual normalisation
 * of its output can undo, so they are folded back to the spelling migrate emits:
 *
 *  - a ONE-element `x IN (v)` is stored as `x = v` (`IN` only becomes `= ANY (ARRAY[…])` from
 *    two elements, which the `any array` fold above already handles). A literal list is told
 *    apart by the comma after its first element, so `in 'a', 'b'` is left alone.
 *  - `a IS NOT DISTINCT FROM b` is stored as `NOT (a IS DISTINCT FROM b)`; see
 *    foldNotDistinctFrom, which runs earlier because it needs the brackets.
 *
 * The IN fold fires on text that SQLite and D1 never store and runs outside literals. It sits on
 * the normalised string (brackets already gone), where it is a plain word pattern.
 */
function foldPgAnalyzerRewrites(s: string): string {
  const parts = s.split(/('(?:[^']|'')*')/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let p = part;
      // `<lhs> in 'v'` — the literal is the next part; a following comma means a list.
      if (/(?<!\bnot) in $/.test(p) && i + 1 < parts.length && !(parts[i + 2] ?? "").trimStart().startsWith(",")) {
        p = p.replace(/ in $/, "=");
      }
      return p.replace(/(?<!\bnot) in (-?\d+(?:\.\d+)?)(?![\w.]|\s*,)/g, "=$1");
    })
    .join("");
}

/**
 * Canonical form: drop casts/brackets/parens, fold `= ANY (ARRAY[…])` back to `IN`,
 * lower-case, collapse whitespace, canonicalize cast target types, and collapse spacing
 * around commas, casts and SYMBOLIC operators (outside single-quoted literals).
 *
 * `textColumns` (lower-cased names of `text` / `varchar` columns) lets a `(col)::text` cast
 * fold away; see PAREN_COLUMN_TEXT_CAST and isElidableCast.
 */
export function normalizeCheckExpr(expr: string, textColumns: ReadonlySet<string> = NO_COLUMNS): string {
  // Every textual rewrite below runs OUTSIDE single-quoted literals. A literal is DATA: its
  // case, its brackets, its `"quoted"` words and its runs of spaces all change what the
  // constraint accepts, so two checks differing only inside a literal (an enum member's
  // case, a regex's character class, a `(` in a pattern) must stay distinct. Reading them
  // as equal is this file's failure in the worse direction: a real change reported clean.
  const stripped = mapOutsideLiterals(foldNotDistinctFrom(unwrapBacktickIdentifiers(expr)), (part, index) =>
    // Drop `::text` / `::"MyType"` type casts PG adds to literals. Only a cast that
    // immediately follows a CLOSING single quote (`'open'::text`) is one, which is exactly
    // the head of an outside part that follows a literal — so a `::` INSIDE a regex pattern
    // literal (`slug ~ 'a::foo'`) is never seen here.
    (index > 0 ? part.replace(/^::\s*"?\w+"?/, "") : part)
      .toLowerCase()
      // Unwrap double-quoted IDENTIFIERS only (`"enumval"` → `enumval`). We emit a
      // quoted column (`"enumVal" IN (...)`) so a mixed-case column is valid SQL;
      // PG's introspected definition quotes mixed-case identifiers too. Unwrapping
      // makes the generated and introspected forms compare equal, and keeps a
      // legacy unquoted check matching its quoted re-emit.
      .replace(/"(\w+)"/g, "$1")
      .replace(PAREN_COLUMN_TEXT_CAST, (whole, column: string) => (textColumns.has(column) ? column : whole))
      .replace(/[()[\]]/g, " ")     // drop parens AND square brackets (ARRAY[…])
      .replace(/\s+/g, " ")
      // PG stores `col IN (…)` as `col = ANY (ARRAY[…])`; after the bracket strip above
      // that reads `col = any array …`. Fold it back to the `col in …` form we emit.
      .replace(/=\s*any\s+array/g, "in"),
  ).trim();
  const folded = foldPgAnalyzerRewrites(stripped);
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
  return collapseSeparatorSpacingOutsideQuotes(folded, textColumns);
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
function isElidableCast(type: string, lhs: string, rest: string, textColumns: ReadonlySet<string>): boolean {
  // `::text` on a COLUMN directly before a regex-match operator (`~`, `~*`, `!~`, `!~*`),
  // and only when the caller names that column as text-family (text, character varying;
  // NOT char(n), whose own operator sees the blank padding the cast trims). On such a
  // column PG adds the cast itself (`"key" ~ '…'` comes back
  // `((key)::text ~ '…'::text)`). On any other column, citext included, the cast changes
  // the operator (`col::text ~ 'A'` is case-sensitive, `col ~ 'A'` on citext is not), so it
  // survives. With no set supplied nothing is elided.
  if (type === "text" && /^\s*!?~\*?(?![-+*\/<>=~!@#%^&|?])/.test(rest)) {
    const column = /(?:^|[^\w.])([a-z_]\w*)$/.exec(lhs)?.[1];
    if (column !== undefined && textColumns.has(column)) return true;
  }
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
function collapseSeparatorSpacingOutsideQuotes(s: string, textColumns: ReadonlySet<string>): string {
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
      token = isElidableCast(target.type, lhs, s.slice(i), textColumns) ? "" : `::${target.type}`;
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
export function checkExprEquals(
  a: string | undefined,
  b: string | undefined,
  textColumns?: ReadonlySet<string>,
): boolean {
  if (a === undefined || b === undefined) return false;
  return normalizeCheckExpr(a, textColumns) === normalizeCheckExpr(b, textColumns);
}

/**
 * True when two NORMALIZED-UNEQUAL CHECK expressions differ only in how they spell
 * null-safe (in)equality: the standard `IS [NOT] DISTINCT FROM` versus SQLite's own
 * `IS NOT` / `IS`. On SQLite those are the same operator — so the rule the database
 * enforces is identical — but the standard spelling only parses from SQLite 3.39, and
 * migrate emitted it for `validator.requiredWhen` / `presentIff` until 1.0.9. A CHECK in
 * the old spelling is therefore MIGRATED to the new one (a one-time rebuild that the diff
 * marks `respelled`, so it is neither gated as destructive nor flagged as a data hazard)
 * rather than read as equal: reading it as equal would leave every database created
 * before the fix unopenable on an older SQLite forever.
 *
 * Rewrites only OUTSIDE single-quoted literals, like the rest of this file.
 */
export function checkExprRespelledNullSafe(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  const na = normalizeCheckExpr(a);
  const nb = normalizeCheckExpr(b);
  if (na === nb) return false;
  return sqliteNullSafeSpelling(na) === sqliteNullSafeSpelling(nb);
}

/** `is not distinct from` → `is`, `is distinct from` → `is not`, outside '…' literals. */
function sqliteNullSafeSpelling(normalized: string): string {
  return normalized
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 === 1
      ? part
      : part.replace(/\bis not distinct from\b/g, "is").replace(/\bis distinct from\b/g, "is not")))
    .join("");
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

/**
 * `expr` with every column IDENTIFIER named in `renames` (old → new) respelled — the body
 * a constraint has after `RENAME COLUMN`, which rewrites it in place on both engines.
 * Matches a double-quoted identifier or a bare word token, and never touches the inside of
 * a single-quoted literal (a regex or IN-list value that happens to spell a column name is
 * data, not a reference). Used only to COMPARE: a miss leaves the drop+add pair it would
 * have paired exactly as it was — gated — so it fails closed.
 */
export function renameExprIdentifiers(expr: string, renames: ReadonlyMap<string, string>): string {
  let out = "";
  let i = 0;
  const n = expr.length;
  while (i < n) {
    const ch = expr[i]!;
    if (ch === "'") {
      // Copy the single-quoted literal verbatim ('' escapes honored).
      const start = i;
      i++;
      while (i < n) {
        if (expr[i] === "'") {
          if (expr[i + 1] === "'") { i += 2; continue; }
          i++;
          break;
        }
        i++;
      }
      out += expr.slice(start, i);
      continue;
    }
    if (ch === '"') {
      const close = expr.indexOf('"', i + 1);
      if (close === -1) { out += expr.slice(i); break; }
      const to = renames.get(expr.slice(i + 1, close));
      out += to === undefined ? expr.slice(i, close + 1) : `"${to}"`;
      i = close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < n && /\w/.test(expr[i]!)) i++;
      const word = expr.slice(start, i);
      out += renames.get(word) ?? word;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
