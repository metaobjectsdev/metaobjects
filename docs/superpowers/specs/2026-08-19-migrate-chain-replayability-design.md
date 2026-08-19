# Migration chain replayability — drop safety, a provisioning gate, and the promise the docs already make

**Issue:** [#313](https://github.com/metaobjectsdev/metaobjects/issues/313) · **Scope:** TypeScript
only (schema migration is TS-owned, [ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md))
· **Supersedes nothing.** Completes the `verify --replay` tier specified but never wired in
[2026-05-31 migrate-ts reference-snapshot design](2026-05-31-migrate-ts-reference-snapshot-and-generation-gaps-design.md) §8.

## 1. The problem, as reported

`meta migrate` writes a bare `DROP TABLE "x"` into a committed migration when `x` is present in the
live database and absent from metadata — **even when no migration in the chain ever creates `x`**.
In the reported case another tool owned that table. Replaying the chain against an empty database
then dies:

```
$ meta migrate apply-pending --db postgresql://…/fresh
meta: migrate apply-pending: apply failed: table "arena_season_standing" does not exist
```

Nothing warns at generation time. The reporter's chain was broken for roughly three months; the
only working database left was a leftover CI container. This contradicts a promise the toolchain
makes in two places — `meta migrate --help` (`migrate.ts:69-70`) and
[`docs/features/migrations-and-drift.md:58`](../../features/migrations-and-drift.md), which says
`apply-pending` "is the way to provision a fresh or CI database".

## 2. What the investigation changed about the obvious design

The obvious design — emit `IF EXISTS`, then add a gate that replays the chain and compares the
result to the committed snapshot — is wrong in a way that only shows up under review. Two findings
reshaped it.

**The two gates are not one gate.** `migrate-ts/src/verify/replay.ts:31` already implements
`verifyReplay`: replay into a caller-supplied database, introspect, and classify drift **against the
committed snapshot**. It is exported (`index.ts:112`) and has no CLI caller. That is not an
oversight — the 2026-05-31 design §3 ruled it: *"we keep the descriptor snapshot as the generate
reference and retain replay only as the optional `verify --replay` integrity aid (§8)."* Its purpose
is catching **hand-edited structural DDL** that diverges from the snapshot.

The reporter did not ask for that. Their failure was `table "x" does not exist` — the chain does not
**apply**. That is a strictly weaker assertion, and the difference decides who can use the gate:

| Project class | Chain applies from empty? | Chain reproduces the snapshot? |
|---|---|---|
| Adopted via `baseline --from-db` (`migrate.ts:870` snapshots the whole introspected DB against an empty chain) | **passes trivially** — nothing to apply | **fails by construction** |
| Declares `migrate.scope` (`carryForwardOutOfScope`, `scope.ts:93`, writes the other owner's tables into the snapshot) | **passes** — the chain only creates in-scope objects | **fails** unless `excludeFromSnapshot` is threaded |
| Uses `@schema` (`CREATE SCHEMA` is emitted nowhere but the ledger, `ledger.ts:126`) | **fails — a true positive** | fails |
| The reported bug | **fails — the defect** | fails |

Comparing against the snapshot makes the gate unpassable for three documented, supported adoption
paths. Asserting only that the chain applies makes it precise: it catches the reported bug, is
immune to the first two classes, and its one remaining failure is a real defect with a real fix.

**Both assertions are worth having, at different strengths.** So this ships one subverb with two
tiers rather than two commands.

## 3. Design

### 3.1 `IF EXISTS` on forward drops, and only forward drops

Change these to `IF EXISTS` — all verified present and bare:

| Site | Change |
|---|---|
| `emit/postgres.ts:66` | `drop-table` |
| `emit/sqlite.ts:219` | `drop-table` |
| `emit/postgres.ts:375`, `:388` | `renderDropView`, plain and CASCADE |
| `emit/postgres.ts:431` | `renderRestoreView`'s illegal-replace fallback |
| `emit/postgres.ts:93-96` | `drop-index` — **both arms**: the plain `DROP INDEX`, and the constraint-backed `ALTER TABLE … DROP CONSTRAINT`, which Postgres spells `DROP CONSTRAINT IF EXISTS` |
| `emit/sqlite.ts:225` | `drop-index` |

**The rule is per change-kind, not per statement:** every `drop-table`, `drop-view` and `drop-index`
is guarded in **both** dialects. Postgres's constraint-backed index arm is included because it is
how Postgres renders the *same* `drop-index` change whose SQLite rendering is guarded at
`sqlite.ts:225` — guarding one and not the other would leave the change kind half-covered.

**`drop-column`, `drop-fk` and `drop-check` are excluded**, for two different structural reasons:

- `drop-column` **does** emit a native SQLite statement (`sqlite.ts:222`,
  `ALTER TABLE … DROP COLUMN`), so it is excluded purely because **SQLite has no
  `DROP COLUMN IF EXISTS`** — a SQL-dialect fact.
- `drop-fk` / `drop-check` emit **no standalone SQLite statement at all**: `renderUpNative`
  throws for them (`sqlite.ts:225-235`, *"should have been handled by recreate bundler"*) because
  SQLite constraints are create-time-only and inline, so the change is folded into a table
  recreate.

Either way, guarding them on Postgres alone would make the guarantee dialect-dependent for the same
declared change, which is the failure mode this rule exists to avoid.

**Down statements stay bare** (`postgres.ts:113`, `:176`, `sqlite.ts:256`). `rollbackTo`
(`apply/apply.ts:149`) runs `down.sql` and deletes the ledger row in one transaction; with
`IF EXISTS` a rollback whose object is already gone would no-op and *still* record the rollback as
done. Rollback is the one place the loud failure is load-bearing, and the replay gate never
exercises the down direction. The rule is therefore: **`IF EXISTS` on forward drops; downs
unchanged.**

**Two forward drops stay bare deliberately** — `sqlite.ts:197` (the recreate-and-copy rebuild) and
`d1-cascade.ts:126`. Both drop a table the same recipe just `INSERT…SELECT`ed from; `IF EXISTS`
there converts a caught corruption into a silent one. This is stated so a later sweep does not
"finish the job".

**D1 inherits this.** `emit/d1.ts:21` renders through `renderSqlite`, so D1's committed migrations
change too, while `--dialect d1` is refused by the gate in §3.2. Accepted: the emitter fix is
independently correct, and D1 keeps the `apply-pending` refusal it already has.

### 3.2 `meta verify --replay` — the chain applies from empty

A new subverb alongside `--templates` / `--db` / `--codegen` (ADR-0021 D2, `verify.ts:116-130`).
Opt-in; a bare `verify` never runs it.

**Default tier — applies.** Provision an empty database, run `applyPending` against it, assert it
completes. Nothing is compared. This is the #313 gate.

**`--replay --strict`** additionally asserts the result equals the committed snapshot, via the
existing `verifyReplay`. This is the 2026-05-31 §8 integrity aid, finally wired, and it is where
`excludeFromSnapshot` (`scope.ts:130`) must be threaded so a scoped project can use it — today
`verify/replay.ts` does not thread it, though `verify.ts:659` shows the pattern.

**Engine, per 2026-05-31 §8's tiering** — in-process, so the gate needs no infrastructure and there
is no scratch database to name, collide with, or accidentally drop:

- **sqlite** → `:memory:` libsql
- **postgres** → PGlite (`@electric-sql/pglite`, WASM Postgres in-process), lazily imported so it
  costs nothing for projects that never run the gate
- **CI, optional higher fidelity** → real Postgres when `MIGRATE_TS_PG_URL` is set

This replaces the sibling-scratch-database approach considered earlier. That approach needed
`CREATEDB`, broke behind connection poolers and on managed Postgres, collided between parallel CI
jobs sharing one server, and — through Postgres's 63-byte identifier truncation — could derive a
scratch name that truncates back to the target database it was about to `DROP`.

**Refusals**, mirroring `apply-pending` (`migrate.ts:419-426`, `:449-457`): `--migration-format
flyway` and `--dialect d1`.

**Zero committed migrations** is not a silent pass. `discoverMigrations` returns `[]` for a missing
directory (`apply.ts:316-322`), so the run would otherwise succeed having proved nothing. The gate
reports "no committed migrations — nothing to replay" and, at `--strict` against a non-empty
snapshot, fails.

**A baselined chain is skipped with a reason, not failed.** At `--strict`, a chain that provably
cannot build the snapshot (baseline adoption) reports that it was skipped and why. A gate that
convicts a supported adoption path gets suppressed, and a suppressed gate protects nothing.

**Exit codes** follow `verify`'s convention (`Math.max` at `verify.ts:239`): a chain that fails to
apply, or a `--strict` mismatch, is **drift → 1**; an engine that cannot start is **operational → 2**.

### 3.3 `CREATE SCHEMA IF NOT EXISTS` for `@schema` projects

The one true positive the gate surfaces is real and fixable: a chain containing
`CREATE TABLE "reporting"."x"` cannot apply to a virgin database because no migration creates the
schema. The emitter emits `CREATE SCHEMA IF NOT EXISTS "<schema>";` ahead of the first object in a
non-default schema. Without this, `@schema` projects get a red gate and no remedy.

### 3.4 Emit-time provenance guard

The gate catches a broken chain after it is committed. The guard stops it being written.

When the diff proposes dropping an object that is **absent from the committed snapshot**, the object
was never managed by this toolchain — the `drop-table` in #313 is exactly this. Refuse at generation
time, naming the object, unless the drop is explicitly allowed by a new `--allow drop-unmanaged`
token.

The population problem that sinks the strict gate does not apply here, and for a pleasing reason:
both brownfield mechanisms *add* to the snapshot. A baselined project's snapshot contains the
foreign table, so the guard reads it as managed and does not fire; a scoped project's snapshot
carries out-of-scope entries forward for the same reason. The guard fires precisely when nothing
ever claimed the object — which is the reported case.

`classify.ts:6-9` already states the doctrine this extends: objects present in the DB but not the
snapshot "must never be treated as actionable drift or auto-dropped". The live path
(`migrate.ts:607-620`) compares metadata against introspection and never consults the snapshot,
which is why the doctrine was not enforced where it mattered.

### 3.5 Documentation

`docs/features/migrations-and-drift.md:58` and `meta migrate --help` both promise fresh-database
provisioning. §3.2 makes the promise true for projects whose chain builds the schema; the docs must
say that it is *those* projects, and point at `verify --replay` as the way to know you are one.

## 4. Remediation for a chain that is already broken

Applied migrations are checksum-immutable (`apply/apply.ts:88-99`): hand-editing a committed
`up.sql` to add `IF EXISTS` is rejected on any database that already applied it. So the reporter —
and anyone the new gate turns red — cannot fix history in place.

The supported path is a **compensating migration**: author a new migration that creates the missing
object as the chain expects, or that supersedes the bad drop. The gate's failure message must print
this, with the failing statement and the object name. **A gate whose failure has no documented exit
gets suppressed**, and this one would otherwise go red on exactly the population that asked for it.

## 5. Testing

- **§3.1** — emit assertions per dialect and per direction, including explicit assertions that the
  rebuild-path drops and the down statements remain bare, so the deliberate exclusions are pinned
  rather than remembered.
- **§3.2** — the reporter's scenario as a RED-first regression: a chain containing a drop for a
  table it never creates, replayed from empty. It must run **through `applyPending`**, not through
  `emit()`. Every prior defect in this area (#226/#241, #243, #255, #285, and 0.21.4's
  `BEGIN TRANSACTION` finding) shared one shape — SQL proven statement-by-statement and never proven
  through the tool that applies it — and `runSqlFileWithLedgerMutation` (`apply.ts:298`) rewrites
  statements before execution.
- **Each row of §2's table** as a case: baselined, scoped, `@schema`, and the reported bug.
- **§3.4** — a drop for a snapshot-absent object refuses; the same drop with `--allow drop-unmanaged`
  proceeds; a baselined project does not false-fire.
- The Postgres lane is `MIGRATE_TS_PG_URL`-gated and `describe.skip`s when unset
  (`apply-pg.test.ts:21-22`); `pg-gate-sentinel.test.ts` exists because that lane silently rotted red
  for eight releases. New Postgres cases must run on PGlite by default so they execute everywhere,
  with the real-PG lane as the higher-fidelity tier.

## 6. Non-goals

- Column and constraint `IF EXISTS` (§3.1's dialect reason).
- Repairing already-applied chains automatically (§4).
- Any cross-port work: `migrate` is TS-owned.
- Making `--strict` pass for baselined projects. It cannot, by construction, and §3.2 skips them
  with a reason instead.

## 7. Verified by

Every claim above was re-read at `286d50e6e` before writing: the bare-drop sites, the four existing
`IF EXISTS` sites, `verifyReplay` and its absent CLI caller, the 2026-05-31 §3 and §8 rulings,
`baseline --from-db`'s snapshot, `carryForwardOutOfScope`'s call sites, `CREATE SCHEMA`'s two
ledger-only occurrences, `discoverMigrations`'s empty-directory behaviour, `emit/d1.ts:21`, and the
env-gated Postgres lane.
