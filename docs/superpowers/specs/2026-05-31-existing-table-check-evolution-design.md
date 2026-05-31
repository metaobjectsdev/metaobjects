# Existing-table CHECK evolution (Postgres) — Design

_Date: 2026-05-31. Status: **Design (approved in brainstorm; not yet implemented).**_

## 1. Problem

CHECK constraints (enum-derived + validator-derived) are **create-time-inline only**:
they ride on `CREATE TABLE`, and the diff produces no `add-check`/`drop-check` (Plan
6 made it inline-only to fix a non-idempotency bug). So adding/removing/changing a
constraint on an **already-existing** table generates no migration. For the common
real workflow — "I changed a validator on a deployed table" — nothing happens.

The blocker was idempotency: the introspectors hardcode `actual.checks = []`, so a
naive check-diff re-proposes every check on every run. This design closes that for
Postgres.

## 2. Goals / non-goals

**Goal:** evolve CHECK constraints on existing Postgres tables — generate
`ALTER TABLE ADD/DROP CONSTRAINT` when a check is added, removed, or its expression
changes — idempotently, across both the offline (snapshot) and `--from-db`
(introspect) paths.

**Non-goals:** SQLite check-only evolution (see §6 — SQLite evolves checks via
recreate-and-copy on any column change; a check-only SQLite change is a follow-on);
multi-column checks; free-form `@check`.

## 3. Two paths, two idempotency stories

The diff is `diff(expected, actual)`; `actual` differs by path:

- **Offline (default):** `actual` = the committed snapshot, which **already carries
  our checks** (we wrote them with our exact expressions). So a check-diff is
  idempotent and change-detecting **with no introspection** — the snapshot remembers
  the prior checks. A changed validator bound → expected expression differs from the
  snapshot's → drop+re-add. This is the primary win and needs no DB.
- **`--from-db` / `verify --replay`:** `actual` = the live DB introspected. Here the
  introspector must actually **read existing checks** (else `[]` → every check
  re-proposed). Postgres rewrites stored expressions (`price >= 0` →
  `(price >= 0)`), so comparison needs normalization (§5).

Both paths use the same `diffTableChecks`; only the `actual.checks` source differs.

## 4. Postgres check introspection

Add `readPgChecks(k, schema, table)` to `src/introspect/postgres.ts`, replacing the
`checks: []` placeholder. Query the catalog for CHECK constraints:

```sql
SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def
FROM pg_constraint con
JOIN pg_class rel ON rel.oid = con.conrelid
JOIN pg_namespace ns ON ns.oid = rel.relnamespace
WHERE con.contype = 'c' AND rel.relname = $table AND ns.nspname = $schema
```

`pg_get_constraintdef` returns `CHECK (<expr>)`; strip the `CHECK (` … `)` wrapper to
get the expression. Returns `CheckDescriptor[]` `{ name, expression }`.

**pg-mem gap (accepted, documented like the FK/index path):** pg-mem (the unit-test
PG) does not support `pg_constraint`. `readPgChecks` catches the failure and returns
`[]` on pg-mem — so unit tests see no checks; the real introspection is covered by
the `MIGRATE_TS_PG_URL`-gated integration tests (the existing pattern for FK/index
introspection). SQLite introspection stays `checks: []` for now (§6).

## 5. Expression normalization + the check diff

Add `src/check-expr-compare.ts` with `normalizeCheckExpr(expr)` and
`checkExprEquals(a, b)`, mirroring `view-sql-compare.ts`:

```
normalizeCheckExpr: strip ALL parentheses, collapse whitespace to single spaces,
trim, lower-case.
```

This is reliable here because **every check expression we generate is
machine-derived with a known simple shape** (`col >= 0 AND col <= 100`,
`col IN ('a','b')`, `length(col) >= 3`, `col ~ 'p'`). PG's parenthesized rewrite
(`(col >= 0) AND (col <= 100)`) normalizes to the same canonical string. The
fragility of normalizing arbitrary author SQL does not apply — we have no author
SQL.

Re-introduce `diffTableChecks(expected, actual, changes)` (removed in Plan 6),
called in **pass-2 (existing tables) only** — never pass-1, where checks are inlined
in `CREATE TABLE`. This split mirrors how the create-table path already inlines
checks while index/fk diffing happens in pass-2; it avoids the duplicate-on-new-table
bug. Logic (by constraint name, mirroring `diffTableIndexes`):
- expected name absent in actual → `add-check`.
- both present, `!checkExprEquals(expected.expr, actual.expr)` → `drop-check` +
  `add-check` (re-create; a CHECK has no in-place ALTER).
- actual name absent in expected → `drop-check`.

**Dialect gating:** `diffTableChecks` runs **only for Postgres**. Thread an optional
`dialect?: Dialect` into `DiffArgs`; when it is not `"postgres"`, skip
`diffTableChecks` entirely (so SQLite never emits `add-check`/`drop-check`, whose
SQLite emit arms throw — SQLite evolves checks via recreate, §6). Existing diff
callers that pass no `dialect` keep current behavior (no check evolution). The CLI
threads its `dialect` into the offline and `--from-db` diff calls.

## 6. SQLite (out of scope this design — evolves via recreate)

SQLite checks are inlined in `CREATE TABLE` and `renderCreateTable` re-inlines them
on a recreate-and-copy. So when any column change triggers a SQLite table recreate,
the rebuilt table carries the **current** checks from the expected schema — checks
evolve for free as a side effect. The only gap is a **check-only** SQLite change (no
column change → no recreate → no update); that requires routing a check delta into
the recreate bundler and is a documented follow-on. This design does not produce
`add-check`/`drop-check` on SQLite (the dialect gate in §5).

## 7. Down-migration (reversibility)

`drop-check` becomes a produced change, so it needs a real `down`. Add
`restore?: CheckDescriptor` to the `drop-check` Change kind (mirroring Plan 4's
`restore` on the other drop-* kinds); `diffTableChecks` sets it from the actual-side
descriptor. Postgres `renderDown` for `drop-check`: when `restore` is present →
`ALTER TABLE ADD CONSTRAINT <name> CHECK (<restore.expression>)`; else keep the
existing WARNING stub. `add-check` down is already `DROP CONSTRAINT` (Plan 6 arm).

## 8. Destructive gating

`drop-check` removes a constraint (a column could later accept values the constraint
forbade) — mildly destructive. Gate it behind a new `allow.dropCheck` flag (mirroring
`allow.dropIndex`/`allow.dropFk`): without it, a `drop-check` is `blocked` and the
migration aborts with guidance. `add-check` is additive → `ALLOWED`. (A
change-expression emits drop+add, so it needs `dropCheck` too — correct: changing a
constraint is a destructive-then-additive pair.)

## 9. Testing

- **Offline (no DB):** snapshot has a check; new metadata adds a second validator →
  `add-check`; removes a validator → `drop-check` (gated by `allow.dropCheck`);
  changes a bound → `drop-check`+`add-check`. A re-diff after applying (snapshot
  advanced) → zero check changes (idempotent).
- **`normalizeCheckExpr`:** `(col >= 0) AND (col <= 100)` ≡ `col >= 0 AND col <= 100`;
  case/whitespace-insensitive; distinct expressions ≠.
- **PG introspection (`MIGRATE_TS_PG_URL`-gated):** create a table with a CHECK, run
  `readPgChecks` → name + normalized expression match; a full introspect→diff against
  the matching expected → zero check drift (the real-DB idempotency proof).
- **down:** `drop-check` with `restore` → down re-adds the constraint.
- **dialect gate:** sqlite diff produces no `add-check`/`drop-check` even when
  expected/actual checks differ.
- **no double-emit on new table:** a create-table still inlines its checks and emits
  no separate `add-check`.

## 10. Out of scope / follow-ons

- SQLite check-only evolution (route into recreate-and-copy).
- Multi-column / free-form checks.
- Only-drop-managed-checks policy on `--from-db` (today a hand-added DB CHECK absent
  from metadata classifies as `drop-check`/unmanaged via the Plan-3 drift classifier;
  the `allow.dropCheck` gate already protects it from silent removal).
