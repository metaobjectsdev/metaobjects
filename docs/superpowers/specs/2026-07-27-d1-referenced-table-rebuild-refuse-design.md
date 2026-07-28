# D1 referenced-table rebuild — detect-and-refuse (#226)

- **Date:** 2026-07-27
- **Status:** Design approved; ready for implementation plan
- **Issue:** [#226](https://github.com/metaobjectsdev/metaobjects/issues/226) — `migrate --dialect d1`: the SQLite table-rebuild's `PRAGMA foreign_keys OFF` is a no-op on remote D1, so a parent-table rebuild fails with `FOREIGN KEY constraint failed`
- **Surface:** `@metaobjectsdev/migrate-ts` (D1 emitter) + `@metaobjectsdev/cli`. TS-only — D1 is a TS-only dialect; no cross-port impact.

## Problem

On Cloudflare **remote** D1, a generated migration that rebuilds a table which is
referenced by another table's foreign key fails at apply time with
`FOREIGN KEY constraint failed`, aborting the migration. The failure is **silent
until a table holds rows** (an empty DB orphans nothing), so it typically first
appears against a populated production database, after the migration has been
generated, reviewed, and committed.

### Why it happens

The D1 emitter delegates the whole rebuild to the SQLite emitter
(`emit/d1.ts` → `renderSqlite`), inheriting SQLite's 12-step table rebuild
(`emit/sqlite.ts`, `renderRecreate`):

```sql
PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;
CREATE TABLE "__new_x" (...);
INSERT INTO "__new_x" (...) SELECT ... FROM "x";
DROP TABLE "x";
ALTER TABLE "__new_x" RENAME TO "x";
COMMIT;
PRAGMA foreign_keys = ON;
PRAGMA foreign_key_check;
```

The D1 safety pass (`emit/d1-safety-pass.ts`) strips `BEGIN`/`COMMIT` but passes the
`PRAGMA foreign_keys` statements through verbatim. On remote D1 the whole batch runs
inside D1's **implicit transaction**, and SQLite **ignores `PRAGMA foreign_keys`
while a transaction is open** — so the `OFF` never takes effect. `DROP TABLE "x"`
then runs with FK enforcement live; when `x` is a **referenced parent** with existing
child rows, the drop is rejected.

A rebuild is triggered by any recreate-triggering change on the referenced table:
adding/removing a `CHECK`, changing a column's type / nullability / default, adding or
removing a foreign key, or a `field.enum @values` change (which lowers to a `CHECK`
change). See the recreate-triggering kinds in `emit/sqlite.ts` (`add-check`,
`drop-check`, `change-column-type`, `change-column-nullable`, `change-column-default`,
`add-fk`, `drop-fk`).

### Why it is D1-specific

Local SQLite is correct: its emitted `PRAGMA foreign_keys = OFF` precedes `BEGIN`, so
it takes effect before the transaction opens. Postgres does not use the rebuild
recipe. Only D1's stripped-`BEGIN` / single-implicit-transaction apply model exposes
the defect. Remote is applied via `wrangler d1 migrations apply <binding> --remote`,
which hands the whole migration file to D1 as one implicit transaction.

## Scope decision: detect-and-refuse, not auto-fix

The auto-fix ("cascade" — rebuild the referencing children without their FK, rebuild
the parent, restore the children's FK) was prototyped and **works**, but it is
substantial, engine-quirk-dependent machinery (reverse FK-graph, two strict ordering
rules, self-referential special-casing, and a genuine dead-end for multi-table
cycles) for a narrow case on a single niche dialect. See
[Appendix A](#appendix-a--prototype-findings) for the prototype evidence.

The bug's actually-dangerous property is that it fails **silently, against
production**. Detect-and-refuse removes that property completely at a fraction of the
cost: turn a silent runtime failure into a **loud generation-time failure** with a
clear workaround. This matches the issue's own guidance ("a loud generation-time
failure is far better than a runtime failure against production") and the D1 safety
pass's existing philosophy of refusing statement sequences it knows cannot apply
(`ATTACH`/`DETACH`/`VACUUM`).

The cascade auto-fix is recorded as a possible future enhancement (a follow-up issue),
not built here.

## Design

### Detection

In the D1 emit path, before returning the emitted SQL, compute:

1. **The rebuilt-table set** — the tables that will go through `renderRecreate`,
   derived from `changes` by selecting the recreate-triggering kinds and grouping by
   table (the same partition `renderSqlite` already performs internally; the D1 path
   computes it from the structured `changes`, not by parsing emitted SQL).
2. **Referenced-ness** — a rebuilt table `T` is *refused* when any foreign key in the
   schema targets `T` (`FkDescriptor.refTable === T`), whether from another table or
   from `T` itself (a self-referential FK hits the same wall — the temp table
   references the original name, so the `DROP` of the referenced original still
   fails).

If any rebuilt table is referenced, **throw** a dedicated, structured error and emit
nothing. If none is, the D1 output is produced exactly as today (`renderSqlite` +
`applyD1SafetyPass`) — **byte-identical** for every migration that does not rebuild a
referenced table.

The check is a direct scan of the schema's foreign keys — no reverse graph, no
topological sort, no dependency-closure.

**Detection data source (over-refuse bias).** A *missed* refusal reintroduces the
exact silent-prod-failure this change exists to kill, so detection errs toward
**over-refusing**: a rebuilt table is refused if it is referenced in the **target
(expected) schema** *or* by a currently-existing child in the actual schema. The
implementation plan pins the exact source against the diff inputs available to the D1
emitter (`expectedSchema`, and the actual-schema FK information available at migrate
time); when the available data is ambiguous, refuse. Over-refusing costs a D1 user a
hand-written migration in a rare case; under-refusing costs a silent production
failure.

### The error

A dedicated error type (sibling to `D1UnsupportedStatementError`) carrying the
refused table and its referencing table(s), with a message that names the cause and
the workaround. Example rendered message:

```
Cannot rebuild table "parent" on Cloudflare D1 — it is referenced by a foreign key
from "child". D1 applies migrations inside an implicit transaction where
`PRAGMA foreign_keys = OFF` is a no-op, so dropping the referenced table during the
rebuild fails with "FOREIGN KEY constraint failed".

The rebuild was triggered by a change to "parent" (a CHECK, column type/nullability/
default, foreign key, or enum-values change). To apply it on D1, hand-write this
migration: rebuild "child" to temporarily drop its foreign key, rebuild "parent",
then rebuild "child" to restore the foreign key. Or make the change on an
unreferenced table.
```

### Where it lives

- Detection + the throw live in the D1 emitter (`emit/d1.ts`), operating on the
  structured `changes` + schema inputs it already receives — not on the emitted SQL
  string, and not in the safety pass (which is string-level and lacks FK-graph
  awareness).
- A small helper enumerates the rebuilt-table set from `changes` and tests
  referenced-ness against the schema's `FkDescriptor`s.
- No change to `emit/sqlite.ts` behavior, `emit/postgres.ts`, or the local-SQLite /
  Postgres paths. If a shared "which kinds trigger a recreate" predicate is convenient,
  it is extracted read-only from the existing SQLite logic without changing that
  logic.

### CLI behavior

`meta migrate --dialect d1` surfaces the thrown error as a clear generation-time
failure and writes no migration file (the existing emit-error path). `meta verify
--dialect d1` is unaffected — it reports drift (that the change is needed) but does not
emit, so it continues to work; the user learns the change exists from `verify` and
learns it must be hand-written from `migrate`.

## Testing

- **Unit (`emit/d1`):**
  - throws on a rebuild of a table referenced by another table's FK;
  - throws on a rebuild of a self-referentially-referenced table;
  - does **not** throw on a rebuild of an unreferenced (leaf) table;
  - does **not** throw on non-rebuild changes (`add-column`, `create-table`,
    `add-index`, …);
  - the thrown error names the refused table and its referencer.
- **Byte-identical guard:** for a migration with no referenced-table rebuild, the D1
  output equals the pre-change output (no-churn snapshot).
- **Integration (libSQL, real engine — mirrors `test/integration/sqlite-fk-convergence.test.ts`):**
  reproduce remote D1 by wrapping the emitted batch in **one explicit transaction**
  with `foreign_keys = ON` at the connection level (SQLite ignores `PRAGMA
  foreign_keys` inside a transaction — identical to remote D1's implicit transaction).
  - documents the defect: the *old* naive D1 output for a referenced-parent rebuild
    fails with `FOREIGN KEY constraint failed` under that model;
  - proves no over-refusal: a *leaf*-table rebuild's D1 output applies cleanly under
    the same model, data is intact, and a re-diff is **EMPTY** (the migrate-engine
    doctrine: emit → apply to a real engine → re-diff empty).

## Non-goals

- Auto-migrating a referenced-table rebuild on D1 (the cascade) — deferred to a
  follow-up issue.
- Any change to local SQLite or Postgres emitters.
- Multi-table foreign-key cycles — subsumed by the refuse (they are referenced tables).

## Appendix A — prototype findings

Throwaway libSQL prototypes (single connection, the rebuild wrapped in one explicit
transaction with `foreign_keys = ON`, faithfully modelling remote D1) established:

1. **The defect reproduces** deterministically: a referenced-parent rebuild fails at
   `DROP TABLE <parent>` with `FOREIGN KEY constraint failed`; `PRAGMA foreign_keys =
   OFF` is confirmed a no-op inside the transaction.
2. **`PRAGMA defer_foreign_keys = ON` does not rescue a parent rebuild** (it defers
   row-level checks, not the drop-of-a-referenced-table guard) — though it does rescue
   a pure child rebuild. There is no cheap PRAGMA-only fix.
3. **A cascade does work** (rebuild referencing children without their FK → rebuild
   parent → restore), validated for single-parent, transitive (`g→c→p`), multi-child,
   and self-referential graphs with data intact and FKs re-enforced — but only via
   temp-name FK rewriting plus two strict ordering rules (referrers-first `DROP`,
   parents-first `RENAME`). Multi-table cycles have no reliable atomic sequence.

These findings are the justification for choosing detect-and-refuse: the auto-fix is
real but disproportionate, and the same libSQL-in-one-transaction technique becomes
the integration gate above.
