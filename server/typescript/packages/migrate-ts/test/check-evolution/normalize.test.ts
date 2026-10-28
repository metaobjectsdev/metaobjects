import { describe, test, expect } from "bun:test";
import { normalizeCheckExpr, checkExprEquals, stripCheckWrapper } from "../../src/check-expr-compare.js";

describe("normalizeCheckExpr", () => {
  test("strips parens, collapses whitespace, lowercases", () => {
    expect(normalizeCheckExpr("(price >= 0) AND (price <= 100)")).toBe("price>=0 and price<=100");
    expect(normalizeCheckExpr("price >= 0 AND price <= 100")).toBe("price>=0 and price<=100");
    // Spacing around a SYMBOLIC operator is canonicalized away; spacing around an
    // ALPHABETIC one (`and`) is load-bearing and must survive.
    expect(normalizeCheckExpr("price>=0 AND price<=100")).toBe("price>=0 and price<=100");
  });
  test("PG-rewritten form equals the generated form", () => {
    expect(checkExprEquals("(col >= 0) AND (col <= 100)", "col >= 0 AND col <= 100")).toBe(true);
    expect(checkExprEquals("length(code) >= 3", "(length(code) >= 3)")).toBe(true);
    expect(checkExprEquals("status IN ('A', 'B')", "status in ('A', 'B')")).toBe(true);
  });
  test("a backtick-quoted identifier equals the double-quoted one, but a backtick in a literal is data", () => {
    expect(checkExprEquals("`status` IN ('open', 'closed')", '"status" IN (\'open\', \'closed\')')).toBe(true);
    expect(checkExprEquals("slug ~ 'a`b`'", "slug ~ 'ab'")).toBe(false);
  });
  test("PG `= ANY (ARRAY[...])` rewrite of an IN-list equals the generated IN form", () => {
    // The crux idempotency case: PG stores `status IN ('OPEN','CLOSED')` and
    // pg_get_constraintdef returns `status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])`.
    // Both must normalize equal, else enum CHECKs churn drop+add on every --from-db run.
    expect(checkExprEquals(
      "status IN ('OPEN', 'CLOSED')",
      "status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])",
    )).toBe(true);
    expect(normalizeCheckExpr("status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text])"))
      .toBe("status in 'OPEN','CLOSED'");
    // different member sets remain distinct after the fold
    expect(checkExprEquals(
      "status IN ('OPEN', 'CLOSED')",
      "status = ANY (ARRAY['OPEN'::text, 'CLOSED'::text, 'CANCELLED'::text])",
    )).toBe(false);
  });
  test("a `::` inside a regex pattern is preserved (only post-quote casts are stripped)", () => {
    // the cast-strip must not corrupt a regex literal containing `::`, else two
    // distinct regex CHECKs would compare equal and a pattern change be missed.
    expect(checkExprEquals("slug ~ 'a::foo'", "slug ~ 'a::bar'")).toBe(false);
    expect(normalizeCheckExpr("slug ~ 'a::foo'")).toBe("slug~'a::foo'");
    // but PG's post-literal `::text` cast (enum form) is still stripped
    expect(normalizeCheckExpr("'open'::text")).toBe("'open'");
  });
  test("the IN↔ANY fold does not false-positive on a literal containing 'any array'", () => {
    // The fold is anchored on `= any array` (the shape only PG's ARRAY rewrite
    // produces after bracket-stripping). A quoted literal that merely contains
    // the words must be left intact — a stray quote breaks the `=…any…array`
    // adjacency, so there is no `in` rewrite.
    expect(normalizeCheckExpr("note = 'pick any array item'")).toBe("note='pick any array item'");
    expect(checkExprEquals(
      "note = 'pick any array item'",
      "note in 'pick', 'item'",
    )).toBe(false);
  });
  test("genuinely different expressions are not equal", () => {
    expect(checkExprEquals("col >= 0", "col >= 5")).toBe(false);
  });

  test("operator spacing is not semantic: the natural `@expr` spelling matches pg_get_expr", () => {
    // THE defect. An `index.lookup @expr` is AUTHOR-written SQL and a person writes it
    // tight; `pg_get_expr` hands it back spaced and cast. Casts and redundant parens were
    // already canonicalized, so the one surviving difference was the spacing — and
    // `verify --db` proposed DROP + CREATE against an index the database already held
    // exactly as declared. Measured on a live postgres:16 across five spellings.
    const introspected = "((request_context ->> 'device_id'::text))";
    for (const authored of [
      "(request_context->>'device_id')",
      "(request_context ->> 'device_id')",
      "((request_context ->> 'device_id'))",
      "((request_context ->> 'device_id'::text))",
      "((request_context->>'device_id'::text))",
    ]) {
      expect(checkExprEquals(authored, introspected)).toBe(true);
    }
    // A multi-character operator survives as ONE token rather than being split apart.
    expect(normalizeCheckExpr("a #>> b")).toBe("a#>>b");
    expect(normalizeCheckExpr("a !~* b")).toBe("a!~*b");
    // An operator this file has never seen normalizes by the same rule — the set is
    // PG's operator CHARACTERS, not a list of operators anyone has to maintain.
    expect(checkExprEquals("tags @> '{a}'", "tags@>'{a}'")).toBe(true);
  });

  test("...and collapsing spacing does not make different expressions equal", () => {
    // The dangerous direction. Whitespace around a symbolic operator is never semantic,
    // so nothing here may compare equal — if it did, a real predicate change would read
    // as clean drift.
    expect(checkExprEquals("a ->> 'x'", "a ->> 'y'")).toBe(false);
    expect(checkExprEquals("a ->> 'x'", "a -> 'x'")).toBe(false);
    expect(checkExprEquals("a >= b", "a > b")).toBe(false);
    expect(checkExprEquals("a <> b", "a = b")).toBe(false);
    // An operator character INSIDE a literal is data, not an operator.
    expect(checkExprEquals("code ~ '^a >> b$'", "code ~ '^a>>b$'")).toBe(false);
    // And an ALPHABETIC operator keeps its separators — `a and b` must never become `aandb`.
    expect(normalizeCheckExpr("a AND b")).toBe("a and b");
    expect(checkExprEquals("a AND b", "a OR b")).toBe(false);
  });

  test("separator commas normalize, but a comma INSIDE a literal stays meaningful", () => {
    // Separator commas (outside quotes) collapse, so a generated IN-list matches a
    // hand-written one regardless of spacing...
    expect(checkExprEquals("status IN ('a','b')", "status IN ('a', 'b')")).toBe(true);
    // ...but a comma inside a string/regex literal is real: two checks differing only
    // there must NOT compare equal, or a genuine regex/predicate change reads as clean.
    expect(checkExprEquals("label <> 'a, b'", "label <> 'a,b'")).toBe(false);
    expect(checkExprEquals("code ~ '^x{1, 3}$'", "code ~ '^x{1,3}$'")).toBe(false);
  });
  test("a cast survives the paren-strip's inserted space", () => {
    // The paren-strip turns every `(` / `)` into a SPACE, so `(payload)::integer` becomes
    // `payload ::integer` while a hand-authored `payload::integer` stays tight. `:` is not
    // one of PG's operator characters, so the operator-run collapse never reached it and
    // the space survived — the SAME expression drifted forever, with no alias involved.
    expect(checkExprEquals("payload::integer", "((payload)::integer)")).toBe(true);
    expect(normalizeCheckExpr("((payload)::integer)")).toBe("payload::integer");
  });
  test("cast-type ALIASES canonicalize to the spelling PG hands back", () => {
    // Measured against PostgreSQL 16.15 via pg_get_constraintdef: PG re-emits every cast
    // target in its canonical spelling, so an authored alias drifts permanently.
    // `verify --db` proposed DROP + CREATE against an index the database already held.
    expect(checkExprEquals("(x)::int", "((x)::integer)")).toBe(true);
    expect(checkExprEquals("(x)::int4", "((x)::integer)")).toBe(true);
    expect(checkExprEquals("(x)::int8", "((x)::bigint)")).toBe(true);
    expect(checkExprEquals("(x)::int2", "((x)::smallint)")).toBe(true);
    expect(checkExprEquals("(x)::float8", "((x)::double precision)")).toBe(true);
    expect(checkExprEquals("(x)::float4", "((x)::real)")).toBe(true);
    expect(checkExprEquals("(x)::decimal(10,2)", "((x)::numeric(10,2))")).toBe(true);
    expect(checkExprEquals("(x)::varchar(50)", "((x)::character varying(50))")).toBe(true);
    expect(checkExprEquals("(x)::bool", "((x)::boolean)")).toBe(true);
    expect(checkExprEquals("(x)::timestamptz", "((x)::timestamp with time zone)")).toBe(true);
    expect(checkExprEquals("(x)::timestamp", "((x)::timestamp without time zone)")).toBe(true);
    expect(checkExprEquals("(x)::timetz", "((x)::time with time zone)")).toBe(true);
    expect(checkExprEquals("(x)::char(3)", "((x)::character(3))")).toBe(true);
    expect(checkExprEquals("(x)::bpchar(3)", "((x)::character(3))")).toBe(true);
  });
  test("the reported jsonb-cast index expression stops drifting", () => {
    // The verbatim pair from the field report, reproduced against live PG:
    // authored `@expr` vs what pg_get_expr hands back for the created index.
    expect(checkExprEquals(
      "(((payload->>'k')::int))",
      "((((payload ->> 'k'::text))::integer))",
    )).toBe(true);
  });
  test("alias canonicalization does NOT rewrite matching identifiers", () => {
    // Only a cast TARGET is canonicalized. A column, function or literal that happens to
    // be spelled like an alias must survive untouched, else two distinct predicates
    // normalize equal and a real change reads as clean drift.
    expect(normalizeCheckExpr("int > 0")).toBe("int>0");
    expect(normalizeCheckExpr("bool_flag IS NOT NULL")).toBe("bool_flag is not null");
    expect(normalizeCheckExpr("note ~ 'cast to int8'")).toBe("note~'cast to int8'");
    expect(checkExprEquals("note ~ 'int'", "note ~ 'integer'")).toBe(false);
    // a DIFFERENT target type still differs
    expect(checkExprEquals("(x)::int", "((x)::bigint)")).toBe(false);
    // a length modifier is part of the type and still differentiates
    expect(checkExprEquals("(x)::varchar(50)", "((x)::character varying(60))")).toBe(false);
  });
  test("PG elides a redundant `::text` on a `->>` result", () => {
    // Found by a differential against live PG 16.15, not by reading the report. `->>` is
    // DEFINED to return text, so PG drops the author's explicit cast and stores only the
    // key literal's own `::text`. The natural authored spelling drifted forever.
    expect(checkExprEquals(
      "(payload->>'device_id')::text",
      "(payload ->> 'device_id'::text)",
    )).toBe(true);
    expect(normalizeCheckExpr("(payload->>'device_id')::text")).toBe("payload->>'device_id'");
    // `#>>` returns text too.
    expect(checkExprEquals("(payload#>>'{a,b}')::text", "(payload #>> '{a,b}'::text[])")).toBe(true);
    // A cast-to-text on something that is NOT a text-returning operator is a REAL cast and
    // must survive, else a genuine change reads as clean drift.
    expect(normalizeCheckExpr("(qty)::text")).toBe("qty::text");
    expect(checkExprEquals("(qty)::text", "qty")).toBe(false);
  });
  test("PG adds a type cast to a NUMERIC LITERAL to match the column", () => {
    // Also found by the live-PG differential: `amt > 0` against a numeric column is stored
    // as `amt > (0)::numeric`. Erasing a cast on a LITERAL is the rule this file already
    // applies to string literals (`'open'::text` -> `'open'`); this extends it to numeric
    // ones, where the same PG behaviour produces the same permanent drift.
    expect(checkExprEquals("amt > 0", "(amt > (0)::numeric)")).toBe(true);
    expect(checkExprEquals("amt >= 1.5", "(amt >= (1.5)::numeric)")).toBe(true);
    expect(normalizeCheckExpr("(amt > (0)::numeric)")).toBe("amt>0");
    // A cast on a COLUMN is not a literal cast and still survives.
    expect(normalizeCheckExpr("(qty)::numeric")).toBe("qty::numeric");
    // and different literals still differ
    expect(checkExprEquals("amt > 0", "(amt > (1)::numeric)")).toBe(false);
  });
  test("undefined is never equal", () => {
    expect(checkExprEquals(undefined, "x")).toBe(false);
  });
});

describe("stripCheckWrapper", () => {
  test("strips the CHECK(...) wrapper", () => {
    expect(stripCheckWrapper("CHECK (qty >= 1)")).toBe("qty >= 1");
  });
  test("preserves inner expression with multiple terms", () => {
    expect(stripCheckWrapper("CHECK (qty >= 1 AND qty <= 100)")).toBe("qty >= 1 AND qty <= 100");
  });
  test("tolerates a trailing NOT VALID modifier", () => {
    expect(stripCheckWrapper("CHECK (qty >= 1) NOT VALID")).toBe("qty >= 1");
  });
  test("preserves a regex expression with parens", () => {
    expect(stripCheckWrapper("CHECK (slug ~ '^(a|b)$')")).toBe("slug ~ '^(a|b)$'");
  });
  test("returns a non-CHECK string unchanged", () => {
    expect(stripCheckWrapper("qty >= 1")).toBe("qty >= 1");
  });
});

describe("regex check on a varchar/text column", () => {
  const generated = `"key" ~ '^[a-z0-9][a-z0-9-]*$'`;
  const introspected = `(((key)::text ~ '^[a-z0-9][a-z0-9-]*$'::text))`;
  const textColumns = new Set(["key"]);
  test("Postgres's added column cast does not read as drift on a text-family column", () => {
    expect(checkExprEquals(generated, introspected, textColumns)).toBe(true);
    expect(checkExprEquals(generated, `(((key)::text !~* '^[a-z0-9][a-z0-9-]*$'::text))`, textColumns)).toBe(false);
  });
  test("without a text-family column set the cast is kept", () => {
    expect(checkExprEquals(generated, introspected)).toBe(false);
  });
  test("a cast on a column outside the set (citext) reads as drift", () => {
    expect(checkExprEquals(generated, introspected, new Set(["other"]))).toBe(false);
  });
  test("a changed regex pattern still reads as drift", () => {
    expect(checkExprEquals(generated, `(((key)::text ~ '^[a-z][a-z0-9-]*$'::text))`, textColumns)).toBe(false);
  });
  test("a cast that is not before a regex operator survives", () => {
    expect(checkExprEquals("qty > 0", "((qty)::text > '0'::text)", new Set(["qty"]))).toBe(false);
  });
});

describe("Postgres analyzer rewrites that text normalisation cannot undo", () => {
  test("a one-value IN equals the `=` Postgres stores", () => {
    expect(checkExprEquals(`"resource_kind" IN ('space')`, `(resource_kind = 'space'::text)`)).toBe(true);
    expect(checkExprEquals(`"level" IN (3)`, `(level = 3)`)).toBe(true);
    // the folded form still tells members apart
    expect(checkExprEquals(`"kind" IN ('space')`, `(kind = 'other'::text)`)).toBe(false);
    expect(checkExprEquals(`"level" IN (3)`, `(level = 4)`)).toBe(false);
  });
  test("a list is not folded, and neither is NOT IN", () => {
    expect(normalizeCheckExpr(`k IN ('a', 'b')`)).toBe(`k in 'a','b'`);
    expect(normalizeCheckExpr(`k IN ('a' , 'b')`)).toBe(`k in 'a','b'`);
    expect(normalizeCheckExpr(`n IN (1, 2)`)).toBe(`n in 1,2`);
    expect(normalizeCheckExpr(`n IN (1 , 2)`)).toBe(`n in 1,2`);
    expect(normalizeCheckExpr(`k NOT IN ('a')`)).toBe(`k not in 'a'`);
    expect(normalizeCheckExpr(`n NOT IN (1)`)).toBe(`n not in 1`);
    expect(checkExprEquals(`k IN ('a')`, `k NOT IN ('a')`)).toBe(false);
  });
  test("IS NOT DISTINCT FROM equals the NOT (… IS DISTINCT FROM …) Postgres stores", () => {
    expect(checkExprEquals(
      `("principal_id" IS NOT NULL) = ("kind" IS NOT DISTINCT FROM 'principal')`,
      `((principal_id IS NOT NULL) = (NOT (kind IS DISTINCT FROM 'principal'::text)))`,
    )).toBe(true);
    expect(checkExprEquals(
      `("used_at" IS NOT NULL) = ("flag" IS NOT DISTINCT FROM TRUE)`,
      `((used_at IS NOT NULL) = (NOT (flag IS DISTINCT FROM true)))`,
    )).toBe(true);
    // IS DISTINCT FROM (requiredWhen) is kept as written by Postgres and must not fold
    expect(checkExprEquals(`"k" IS DISTINCT FROM 'p'`, `NOT (k IS DISTINCT FROM 'p'::text)`)).toBe(false);
    // `(NOT x) IS DISTINCT FROM y` is not the negation of a comparison: the fold must not equate it
    expect(checkExprEquals(`(NOT x) IS DISTINCT FROM y`, `x IS NOT DISTINCT FROM y`)).toBe(false);
    expect(checkExprEquals(`(NOT x) IS DISTINCT FROM y`, `NOT (x IS DISTINCT FROM y)`)).toBe(false);
    expect(checkExprEquals(`x IS NOT DISTINCT FROM y`, `NOT (x IS DISTINCT FROM y)`)).toBe(true);
    // a negated group that is more than one comparison is not folded
    expect(checkExprEquals(`NOT (a IS DISTINCT FROM b OR c)`, `a IS NOT DISTINCT FROM b OR c`)).toBe(false);
    // only the depth-0 operator is rewritten: a nested comparison that comes first is not the one negated
    expect(checkExprEquals(`NOT ((a IS DISTINCT FROM b) IS DISTINCT FROM c)`, `(a IS NOT DISTINCT FROM b) IS DISTINCT FROM c`)).toBe(false);
    expect(checkExprEquals(`NOT ((a IS DISTINCT FROM b) IS DISTINCT FROM c)`, `(a IS DISTINCT FROM b) IS NOT DISTINCT FROM c`)).toBe(true);
    // the phrase inside a literal is data, never the operator
    expect(checkExprEquals(`NOT ('x is distinct from y' IS DISTINCT FROM z)`, `'x is not distinct from y' IS DISTINCT FROM z`)).toBe(false);
    expect(checkExprEquals(`NOT ('x is distinct from y' IS DISTINCT FROM z)`, `'x is distinct from y' IS NOT DISTINCT FROM z`)).toBe(true);
    // `IS NOT NULL` is not a left operand
    expect(normalizeCheckExpr(`NOT (x IS NOT NULL IS DISTINCT FROM y)`)).toBe(`not x is not null is distinct from y`);
  });
  test("a varchar column's `(col)::text` cast is dropped wherever Postgres adds it", () => {
    const cols = new Set(["region", "name_a", "name_b", "short_code"]);
    expect(checkExprEquals(`length("short_code"::text) >= 2`, `(length((short_code)::text) >= 2)`, cols)).toBe(true);
    expect(checkExprEquals(`length(lower(short_code)::text) >= 2`, `(length((short_code)::text) >= 2)`, cols)).toBe(false);
    expect(checkExprEquals(`"region" IS NOT DISTINCT FROM 'eu'`, `NOT ((region)::text IS DISTINCT FROM 'eu'::text)`, cols)).toBe(true);
    expect(checkExprEquals(`("region" IS DISTINCT FROM 'us') OR (x IS NOT NULL)`, `(((region)::text IS DISTINCT FROM 'us'::text) OR (x IS NOT NULL))`, cols)).toBe(true);
    expect(checkExprEquals(`"name_a" < "name_b"`, `((name_a)::text < (name_b)::text)`, cols)).toBe(true);
    expect(checkExprEquals(`length("short_code") >= 2`, `(length((short_code)::text) >= 2)`, cols)).toBe(true);
  });
  test("…but only for a named text-family column, and never a cast on a call", () => {
    expect(checkExprEquals(`"name_a" < "name_b"`, `((name_a)::text < (name_b)::text)`)).toBe(false);
    expect(checkExprEquals(`"name_a" < "name_b"`, `((name_a)::text < (name_b)::text)`, new Set(["other"]))).toBe(false);
    // `length(code)::text` is a cast of the RESULT, not of the column
    expect(checkExprEquals(`length("code") = '3'`, `(length(code))::text = '3'`, new Set(["code"]))).toBe(false);
  });
});

describe("a quoted literal is data: a change inside it is drift", () => {
  test("an enum member's case", () => {
    expect(checkExprEquals(`"status" IN ('OPEN', 'CLOSED')`, `"status" IN ('open', 'closed')`)).toBe(false);
    expect(checkExprEquals(`"status" IN ('OPEN')`, `(status = 'open'::text)`)).toBe(false);
    expect(checkExprEquals(`"status" IN ('OPEN', 'CLOSED')`, `status = ANY (ARRAY['open'::text, 'closed'::text])`)).toBe(false);
  });
  test("a regex's case", () => {
    expect(checkExprEquals(`"code" ~ '^[A-Z]+$'`, `"code" ~ '^[a-z]+$'`)).toBe(false);
  });
  test("brackets, parens, double quotes and runs of blanks inside a literal", () => {
    expect(checkExprEquals(`slug ~ '^(a|b)$'`, `slug ~ '^a|b$'`)).toBe(false);
    expect(checkExprEquals(`slug ~ '^[ab]$'`, `slug ~ '^ab$'`)).toBe(false);
    expect(checkExprEquals(`slug ~ 'a"b"c'`, `slug ~ 'abc'`)).toBe(false);
    expect(checkExprEquals(`k = 'a  b'`, `k = 'a b'`)).toBe(false);
  });
  test("the same literal still matches under Postgres's respelling of everything around it", () => {
    expect(checkExprEquals(`("Code" ~ '^(A|b)$') AND (length("Code") >= 2)`, `((("Code" ~ '^(A|b)$'::text)) AND (length("Code") >= 2))`)).toBe(true);
    expect(checkExprEquals(`"k" IN ('It''s')`, `(k = 'It''s'::text)`)).toBe(true);
  });
});
