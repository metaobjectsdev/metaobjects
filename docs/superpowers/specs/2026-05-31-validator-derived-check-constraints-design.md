# Validator-derived CHECK constraints — Design

_Date: 2026-05-31. Status: **Design (approved in brainstorm; not yet implemented).**_

## 1. Problem

`migrate-ts` generates DDL CHECK constraints only for one case: a `field.enum`'s
`@values` becomes `CHECK (col IN (...))` (shipped). But the metamodel already
carries other constraints — `validator.numeric` (`@min`/`@max`), `validator.length`
(`@min`), `validator.regex` (`@pattern`) — that are equally expressible as DB CHECK
constraints. Today those validators enforce only in application code; the database
schema doesn't enforce them. A column declared `min: 0` can still store `-5` if a
write bypasses the app layer.

The right fix is the metaobjects principle (CLAUDE.md): *pattern-derivable from
metadata = codegen, never hand-code.* A CHECK like `price >= 0` is **not** custom
SQL — it is the DB-level projection of a validator the author already declared. The
shipped enum→CHECK is the first instance of exactly this pattern.

(A free-form, author-written `@check` for genuinely non-derivable constraints —
multi-column business rules — was considered and **rejected for now**: most CHECKs
are derivable, and a raw-SQL attr couples metadata to physical column naming. It
remains a possible future escape hatch, not part of this work.)

## 2. Goals / non-goals

**Goal:** derive DB CHECK constraints from declared validators, reusing the shipped
CHECK pipeline (`CheckDescriptor` → diff → emit → inline-in-`CREATE TABLE`), so a
validator enforces in both app validation and the database schema — single source
of truth, defense-in-depth.

**Non-goals (this design):** a free-form `@check` attr; multi-column / cross-field
checks; evolving checks on an already-existing table (see §6); `validator.array`
CHECKs; CHECK emission in non-TS ports (schema is TS-only, ADR-0015).

## 3. The derivation mapping

For each field, walk its **effective validators** (`field.validators()` — own +
inherited via `extends`) and emit one `CheckDescriptor` per SQL-expressible
validator. The field's resolved db column name (`resolveColumnName(field, strategy)`)
is the column the expression references.

| Validator (subType) | Attrs | Derived CHECK expression | Dialects |
|---|---|---|---|
| `numeric` | `@min` and/or `@max` (int) | `"col" >= min`, `"col" <= max`, joined by `AND` when both present | postgres + sqlite |
| `length` | `@min` and/or `@max` (int) | `length("col") >= min` and/or `length("col") <= max`, joined by `AND` when both present | postgres + sqlite |
| `regex` | `@pattern` (string) | `"col" ~ 'pattern'` (single-quotes in the pattern doubled) | **postgres only** |
| `enum` (`field.enum`) | `@values` | `"col" IN ('A', 'B', …)` | postgres + sqlite — **already shipped** |
| `required` | — | `NOT NULL` (column nullability) — **already done** |

Rules:
- **`validator.length` emits a length-range CHECK** for whichever of `@min`/`@max`
  are present (`length("col") >= min` and/or `length("col") <= max`, joined by `AND`
  when both present). The field-level **`@maxLength` attr** (distinct from
  `validator.length @max`) is what maps to `VARCHAR(n)` via the column's
  `SqlType.maxLength`.
- **`numeric` with both `@min` and `@max`** emits a single check
  `"col" >= min AND "col" <= max` (one constraint, not two).
- **`regex` is postgres-only.** SQLite has no native regex operator, so a regex
  validator emits **no** CHECK on sqlite (silently skipped — the validator still
  enforces in the app layer). `buildChecks` therefore needs the dialect.
- **`validator.array`** is out of scope (array-cardinality CHECKs on a scalar column
  don't apply cleanly; revisit with array-column support).
- The CHECK expression is built from the **resolved physical column name** and the
  validator's numeric/string attr values — fully metadata-derived, never
  author-supplied raw SQL.

## 4. Naming

Validator-derived checks are named `<table>_<col>_<validator>_chk` (e.g.
`orders_price_numeric_chk`, `users_code_length_chk`, `users_email_regex_chk`) so a
field carrying several validators gets several distinctly-named constraints. The
existing **enum** check keeps its current name `<table>_<col>_chk` (unchanged, for
back-compat). A field that is both an enum and carries a numeric validator therefore
emits `<table>_<col>_chk` (enum) + `<table>_<col>_numeric_chk` (numeric) — distinct,
no collision.

## 5. Implementation shape

The change is **localized to `migrate-ts`'s `buildExpectedSchema`** — specifically
the Plan-6 `buildChecks(entity, tableName, strategy)` helper, which today iterates
fields and emits one enum check per `field.enum`. Extend it (add a `dialect`
parameter) to ALSO iterate each field's `validators()` and emit a `CheckDescriptor`
per the §3 mapping, alongside the enum check. Everything downstream is untouched:
`CheckDescriptor` already flows through `diff` and `emit`, and Plan 6 inlines checks
in `renderCreateTable` for both dialects.

**No metamodel changes.** `@min`/`@max`/`@pattern` and the validator subtypes already
exist and are registered across all five ports. This is a pure migrate-ts derivation
change — no new attr, no loader edit, no cross-port conformance fixture for an attr,
and no collision with the concurrent validator-parity work (which touches the
validator metamodel/loaders, not `migrate-ts`'s consumption of it).

## 6. Boundaries (shared with the shipped CHECK mechanism)

- **Create-time-inline only.** Checks ride on `CREATE TABLE` (Plan 6 design — the
  diff produces no `add-check`/`drop-check`). So validator-derived checks apply when
  a table is created (greenfield + SQLite full-rebuild). Adding/removing a check on
  an **already-existing** table is the **shared deferred follow-on** for both enum
  and validator-derived checks: un-defer `add-check`/`drop-check` + add CHECK
  introspection (so the diff stays idempotent — without introspection a derived
  check would be re-proposed on every run). This design does NOT change that
  boundary; it adds more sources feeding the same inline mechanism.
- **Down-from-snapshot** already handles these (checks are part of the table the
  snapshot records; `renderCreateTable` re-inlines them on a table re-create).

## 7. Testing

- `buildExpectedSchema` derives the right `CheckDescriptor` per validator: numeric
  `@min`+`@max` → one `>= AND <=` check; numeric `@min` only → `>=`; length `@min`
  and/or `@max` → `length(col) >= n` / `length(col) <= n` (joined by `AND` when both);
  regex `@pattern` → `col ~ 'p'` on postgres, **none** on sqlite.
- Length `@max` produces a `length(col) <= max` check (it does **NOT** map to
  VARCHAR(n); only the `@maxLength` field attr does).
- A field with an enum + a numeric validator emits both, distinctly named.
- Single-quote escaping in a regex `@pattern`.
- e2e: an entity with validators → `emit` inlines the derived `CHECK (...)` into
  `CREATE TABLE` exactly once each (postgres); regex check absent on sqlite.
- Determinism: derived checks are sorted (the snapshot serializer already sorts
  `checks` by name), so output is stable.

## 8. Out of scope / follow-ons

- Free-form `@check` attr (raw custom SQL, multi-column) — deferred escape hatch.
- Existing-table check evolution (`add-check`/`drop-check` + CHECK introspection) —
  shared follow-on for all check sources.
- `validator.array` → CHECK; regex on SQLite (would need an app-defined REGEXP fn).
- CHECK emission in non-TS ports' codegen (schema is TS-only).
