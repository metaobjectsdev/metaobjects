# D1 FK-cascade auto-fix — rebuild referenced tables on remote D1 (#241)

- **Date:** 2026-07-28
- **Status:** Design approved; ready for implementation plan
- **Issue:** [#241](https://github.com/metaobjectsdev/metaobjects/issues/241) — auto-migrate referenced-table rebuilds via FK cascade (follow-up to [#226](https://github.com/metaobjectsdev/metaobjects/issues/226))
- **Surface:** `@metaobjectsdev/migrate-ts` (D1 emitter) + a small `@metaobjectsdev/cli` call-site change. TS-only; no other-port impact.

## Problem

On remote Cloudflare D1, the SQLite table-rebuild recipe cannot rebuild a table that
another table's foreign key references: D1 runs the migration inside an implicit
transaction where `PRAGMA foreign_keys = OFF` is a no-op, so `DROP TABLE <referenced>`
fails with `FOREIGN KEY constraint failed`. [#226](https://github.com/metaobjectsdev/metaobjects/issues/226)
made the D1 emitter **refuse** that case at generation time (safe, but the user must
hand-write the migration). This issue replaces the refusal with a **cascade** that
generates a correct, appliable migration — and closes the residual under-refuse gap
#226 documented.

## Prototype evidence

Throwaway libSQL prototypes (single connection, the emitted batch wrapped in one
explicit transaction with `foreign_keys = ON` — a faithful model of remote D1's
implicit transaction) validated the cascade **10/10** across single-parent,
transitive (`g→c→p`), multi-child, and self-referential graphs: each commits with row
data intact and foreign keys re-enforced. The same prototypes established that
`PRAGMA defer_foreign_keys = ON` alone cannot rescue a parent rebuild, and that
multi-table cycles have no reliable atomic sequence (they must be refused).

## The cascade algorithm

When a migration would rebuild an FK-referenced table (and the FK graph over the
affected set is acyclic — self-loops excepted), the D1 emitter emits one pass:

```sql
PRAGMA defer_foreign_keys = ON;                 -- belt for self-referential / lazy checks
-- for each table t in the affected set A:
CREATE TABLE __f_<t> ( <t's final schema> );    -- FK cols reference __f_<ref> when ref ∈ A, else <ref>'s real name
-- for each t in A:
INSERT INTO __f_<t> ( <carry cols> ) SELECT <mapped cols> FROM <t>;
-- DROP old tables, REFERRERS-FIRST (reverse-topological):
DROP TABLE <t>;
-- RENAME temps, PARENTS-FIRST (topological) — RENAME rewrites __f_ FK refs to final names:
ALTER TABLE __f_<t> RENAME TO <t>;
```

The two ordering rules are load-bearing: referrers-first `DROP` avoids dropping a
still-referenced table; parents-first `RENAME` lets SQLite rewrite each temp-name FK to
its final target. Forward-references in the `CREATE` statements are fine — SQLite
resolves FK *target* tables lazily.

The D1 safety pass strips the (now unnecessary) explicit transaction control, relying
on D1's implicit transaction for atomicity; the useless `PRAGMA foreign_keys = OFF/ON`
bracket is not emitted on the cascade path.

## Affected set, ordering, cycles

- **Affected set `A` = (tables the diff rebuilds) ∪ (all tables that transitively
  reference a table in `A`)**, where "reference" is the **union of the actual and
  expected foreign-key graphs**. Using the union (not expected-only) is what closes
  #226's residual gap: a migration that rebuilds a parent *and* drops a child's FK to
  it in the same run — the child references the parent in the *actual* schema, so it
  must be rebuilt (and dropped) before the parent, which only the actual graph reveals.
- A table pulled into `A` only as a referrer (not itself changed) is rebuilt to its
  **expected descriptor** (identical to its current schema, so a re-diff converges),
  including its columns, indexes, and foreign keys.
- **Ordering** is a topological sort of the union FK graph restricted to `A`.
- **Multi-table cycles** (`A→B→…→A`, length ≥ 2) have no reliable atomic FKs-on
  sequence and are **refused** (the topological sort detects them). Self-loops
  (self-referential FKs) are excluded from the cycle check — the temp-name mechanism
  handles them. The existing `D1ReferencedTableRebuildError` is reused/renamed for the
  cycle-refusal message (naming the cycle and the hand-write workaround).

## Threading the actual schema

`EmitOptions` gains `actualSchema?: SchemaSnapshot`. Both `meta migrate` emit call
sites already hold it: the live-introspection path passes `actual` (the introspected
snapshot given to `diff`), and the offline path passes the prior committed `snapshot`.
`renderD1` uses it (unioned with `expectedSchema`) to build the FK graph. When absent
(e.g. a caller that doesn't supply it), the emitter falls back to the expected graph
and **refuses** any referenced rebuild it cannot prove safe — never emits an unproven
cascade.

## Where it lives

- New `src/emit/d1-cascade.ts`: the reverse FK-graph builder, topological sort + cycle
  detection, and the cascade emitter. It reuses `src/emit/sqlite.ts` primitives
  (`renderCreateTable`, the column carry/remap logic from `renderRecreate`,
  `renderCreateIndex`), extracted read-only without changing SQLite behavior.
- `src/emit/d1.ts` (`renderD1`): when `recreatedTables` contains a referenced table,
  dispatch to the cascade for an acyclic graph, or throw the cycle-refusal for a cycle.
  The no-referenced-rebuild common path stays exactly as today — **byte-identical**.
- `src/emit/index.ts` (`EmitOptions` + `emit`) and the two `cli` emit call sites: add
  and pass `actualSchema`.
- No change to `emit/postgres.ts` or the local-SQLite path.

## Down migrations

As today, the recreate/cascade down migration is best-effort — the emitter emits a
`-- WARNING` block (data-destructive reversals cannot be auto-generated). Unchanged
from the existing SQLite recreate behavior.

## Testing

Extend the libSQL real-engine gate (`test/integration/`, one-transaction model = remote
D1), each scenario asserting: the cascade applies cleanly, row data is intact, foreign
keys are re-enforced afterward, and a re-diff is **EMPTY** (the migrate-engine
doctrine):

- single parent + populated child;
- transitive chain `g→c→p`;
- multiple children of one parent;
- self-referential table;
- **the #226 residual gap**: one migration that rebuilds a parent AND drops a child's
  FK to it — applies cleanly (this is the case that regresses if the actual graph
  isn't used);
- **multi-table cycle** `A↔B` → refused at generation time (unit-level);
- a no-referenced-rebuild migration → D1 output byte-identical to today.

Plus unit tests for the FK-graph builder, topological ordering, and cycle detection.

## Non-goals

- Multi-table foreign-key cycles on D1 (refused, documented).
- Any change to the local SQLite or Postgres emitters.
- Changing `applyPending` / replay semantics.

## Docs

Remove #226's "Known limitation of the current refusal" note from
`docs/features/migrations-and-drift.md` (the gap is closed) and update the D1
limitation subsection to describe the cascade (with cycles as the remaining
hand-write case). CHANGELOG entry. Close #241.
