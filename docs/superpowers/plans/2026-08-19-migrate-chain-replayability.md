# Migration Chain Replayability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a committed migration chain provably replayable from an empty database, and stop `meta migrate` writing statements that cannot replay.

**Architecture:** Three independent layers. The emitter stops writing landmines (`IF EXISTS` on forward drops; `CREATE SCHEMA IF NOT EXISTS` ahead of a non-default schema). A new `meta verify --replay` gate replays the committed chain into an **in-process** database (PGlite for postgres, `:memory:` libsql for sqlite) and asserts it applies; `--replay-snapshot` additionally asserts it reproduces the committed snapshot via the already-built-but-unwired `verifyReplay`. An emit-time provenance guard refuses to drop an object the committed snapshot never contained, so the bad SQL is never authored.

**Tech Stack:** TypeScript, Bun test runner, Kysely, `@electric-sql/pglite` (new, optional peer), `@libsql/kysely-libsql` (already a hard dependency of `cli`, a devDependency of `migrate-ts`).

**Spec:** [`docs/superpowers/specs/2026-08-19-migrate-chain-replayability-design.md`](../specs/2026-08-19-migrate-chain-replayability-design.md)

## Global Constraints

- **Scope is TypeScript only.** Schema migration is TS-owned ([ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md)). No Java/Kotlin/C#/Python work, no conformance-corpus fan-out.
- **`IF EXISTS` goes on FORWARD drops only.** Down statements stay bare. `rollbackTo` runs `down.sql` and the ledger delete in ONE transaction (`apply/apply.ts:185-189`), so a down that no-ops would still record the rollback as done.
- **Never `instanceof` a metadata node from another package** — use the exported guards (`isMetaObject`, `isWritableSource`, …). Two physical copies of `@metaobjectsdev/metadata` in one process make `instanceof` silently false.
- **No `any`.** Use `unknown` and narrow. A bare `let x;` is an implicit evolving `any`. **No `as never` / `as unknown as T` in committed test fixtures** — every literal in this plan is written against the real type; if one does not compile, the type is the authority, not the cast.
- **Never call `own*()` accessors** (ADR-0039) except where surrounding code documents a sanctioned reason.
- **Errors are `ParseError` with a structured `code`** and `codeSource(...)` — never a message prefix.
- **Backward compatibility is absolute:** a project that declares no new flag must emit byte-identical migrations except for the `IF EXISTS` and `CREATE SCHEMA` tokens this plan adds, and `SNAPSHOT_FORMAT_VERSION` must remain 3.
- **Every new gate FAILS OPEN on a missing input.** A project that has never generated a snapshot, or has no committed migrations, is not in an error state — but it must SAY so, never pass silently. A gate that is quiet when it checked nothing is indistinguishable from a gate that passed.
- **Run tests scoped:** `cd server/typescript && bun test packages/<pkg>`. NEVER a bare `bun test` at the repository root — it walks java/python/csharp and takes many minutes.
- **`bun test` does NOT typecheck.** Run `bun run --filter '*' typecheck` from the repository root before every commit and confirm all 18 packages exit 0.
- **Every task ends GREEN.** No task may leave `bun test packages/migrate-ts` or `packages/cli` red for a later task to inherit. Test churn caused by a task is fixed inside that task.
- **Public repository.** No private project names, no absolute home paths, in code, tests, fixtures, or commit messages. The committed `.githooks/pre-commit` enforces this (`git config core.hooksPath .githooks`) using the denylist at `git config hooks.denyListPath`.
- **Stage explicit paths only.** Never `git add -A` — other worktrees share this repository.

---

## Task ordering (a DAG, not a line)

```
Task 1 (emit: IF EXISTS)     ─┐
Task 2 (emit: CREATE SCHEMA) ─┤
Task 7 (provenance guard)    ─┼─→ Task 8 (docs + CHANGELOG)
Task 3 (replay engine) ─┬─ Task 4 (verifyReplay governed) ─┐
                        └─ Task 5 (--replay) ──────────────┴─→ Task 6 (--replay-snapshot)
```

- **Tasks 1, 2, 3 and 7 are independent** of each other and of everything else, and may run in any order or in parallel.
- **Task 4 needs Task 3** — its test imports `openReplayEngine`.
- **Task 5 needs Task 3** — the gate calls `openReplayEngine`.
- **Task 6 needs Tasks 3, 4 AND 5** — it extends `runReplayVerify` (Task 5) and passes `governed` (Task 4).
- **Task 8 needs 1, 2, 5, 6, 7** — it documents what they ship.

---

## File Structure

**Modified — `server/typescript/packages/migrate-ts/src/`**
- `emit/postgres.ts` — `IF EXISTS` on forward drops; `CREATE SCHEMA IF NOT EXISTS` emission
- `emit/sqlite.ts` — `IF EXISTS` on forward drops (two lines only; see Task 1)
- `verify/replay.ts` — thread scope inputs into the snapshot comparison
- `types.ts` — `AllowOptions.dropUnmanaged`
- `index.ts` — export the new replay-engine surface
- `package.json` — `@electric-sql/pglite` as an optional peer + devDependency

**New — `server/typescript/packages/migrate-ts/src/`**
- `verify/replay-engine.ts` — provision an in-process database (PGlite / `:memory:` libsql), hand back a Kysely instance and a disposer. One responsibility: engine lifecycle. No replay logic, no comparison.

**Modified — `server/typescript/packages/cli/src/`**
- `lib/args.ts` — `--replay` / `--replay-snapshot` verify flags; `drop-unmanaged` allow token
- `lib/allow.ts` — `drop-unmanaged` → `dropUnmanaged` grant mapping
- `commands/verify.ts` — the replay gate
- `commands/migrate.ts` — the emit-time provenance guard
- `package.json` — `--external @electric-sql/pglite` on `build:binary`

**Modified — `server/typescript/packages/sdk/src/`**
- `config.ts` — `drop-unmanaged` in `AllowTokenEnum`

**Modified — existing tests (churn, fixed inside the task that causes it)**
- `packages/migrate-ts/test/unit/emit-postgres.test.ts` (Task 1)
- `packages/migrate-ts/test/unit/emit-sqlite.test.ts` (Task 1)
- `packages/migrate-ts/test/check/emit-postgres-check.test.ts` (Task 1)
- `packages/migrate-ts/test/check-evolution/drop-check-down.test.ts` (Task 1)
- `packages/migrate-ts/test/integration/pg-constraint-backed-index-285.test.ts` (Task 1 — **both** lines 142 and 143)

**New — tests**
- `packages/migrate-ts/test/emit-drop-if-exists.test.ts`
- `packages/migrate-ts/test/emit-postgres-create-schema.test.ts`
- `packages/migrate-ts/test/unit/replay-engine.test.ts`
- `packages/migrate-ts/test/integrity/replay-emitted-chain.test.ts` — the #313 regression, emitter→apply
- `packages/migrate-ts/test/integrity/replay-scoped.test.ts`
- `packages/cli/test/verify-replay.test.ts`
- `packages/cli/test/migrate-drop-unmanaged.test.ts`

---

## Task 1: `IF EXISTS` on forward drops, both dialects

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/emit/postgres.ts` (`renderUp`, `renderDropView`)
- Modify: `server/typescript/packages/migrate-ts/src/emit/sqlite.ts` (`renderUpNative`)
- Test: `server/typescript/packages/migrate-ts/test/emit-drop-if-exists.test.ts` (create)
- Fix churn: `test/unit/emit-postgres.test.ts`, `test/unit/emit-sqlite.test.ts`, `test/check/emit-postgres-check.test.ts`, `test/check-evolution/drop-check-down.test.ts`, `test/integration/pg-constraint-backed-index-285.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behaviour change only.

**Context the implementer needs.** `renderUp` (postgres) / `renderUpNative` (sqlite) are the FORWARD
renderers. `renderDown` / `renderDownNative` are out of scope — see the Global Constraint.

The exact sites, all verified bare at HEAD:

| File:line | Change kind | Action |
|---|---|---|
| `postgres.ts:66` | `drop-table` | add `IF EXISTS` |
| `postgres.ts:95` | `drop-index`, constraint-backed arm | `DROP CONSTRAINT IF EXISTS` |
| `postgres.ts:96` | `drop-index`, plain arm | `DROP INDEX IF EXISTS` |
| `postgres.ts:98` | `drop-fk` | `DROP CONSTRAINT IF EXISTS` |
| `postgres.ts:104` | `drop-check` | `DROP CONSTRAINT IF EXISTS` |
| `postgres.ts:375` | `renderDropView`, plain | `DROP VIEW IF EXISTS` |
| `postgres.ts:388` | `renderDropView`, CASCADE | `DROP VIEW IF EXISTS … CASCADE` |
| `sqlite.ts:219` | `drop-table` | add `IF EXISTS` |
| `sqlite.ts:225` | `drop-index` | add `IF EXISTS` |

**SQLite is two lines, not more.** `sqlite.ts:240` (`drop-view`) and `:241` (`replace-view`) already
emit `DROP VIEW IF EXISTS` on the forward side. The sqlite `drop-fk`/`drop-check`/`add-check` arms
**throw** (`sqlite.ts:226-235`) — those change kinds are folded into a table recreate, so there is no
standalone statement to guard, which is why the Postgres-only guard on `drop-fk`/`drop-check` is not
a dialect split (spec §3.1).

**Deliberately left bare — do not "finish the job":**
- `sqlite.ts:197` — the recreate-and-copy rebuild's `DROP TABLE`. It drops a table the same recipe
  just `INSERT…SELECT`ed from; `IF EXISTS` there converts a caught corruption into a silent one.
- `emit/d1-cascade.ts:126` — same reason.
- `postgres.ts:431` — inside `renderRestoreView`, reached only from `postgres.ts:178`/`:179`, both in
  `renderDown`. Guarding it violates the forward-only rule in the same change that states it.
- Every down site: `postgres.ts:113`, `:147`, `:164`, `:171`, `:176`; `sqlite.ts:256`, `:262`, `:275`.

**`drop-check` IS reachable — the code comment saying otherwise is wrong.** `emit/postgres.ts:99-102`
claims `add-check`/`drop-check` are "declared but NOT yet produced by the diff". That comment is
false: `diff/index.ts:579` and `:592` both push `drop-check`, an evolved `field.enum @values` is a
live producer, and `test/check/emit-postgres-check.test.ts:25` plus
`test/check-evolution/drop-check-down.test.ts:12` already assert the emitted forward statement.
**Delete the false half of that comment as part of this task** and assert `drop-check` in the new
test like every other forward drop.

`emit/d1.ts:21` renders through `renderSqlite`, so the sqlite edits also change D1's committed
migrations. That is accepted and expected (spec §3.1).

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/migrate-ts/test/emit-drop-if-exists.test.ts
//
// Forward drops must tolerate an absent object so a committed chain replays into
// an empty database (#313). Down statements must NOT — `rollbackTo` runs down.sql
// and the ledger delete in one transaction, so a silently-no-op down would record
// the rollback as done.
import { describe, test, expect } from "bun:test";
import { renderPostgres } from "../src/emit/postgres.js";
import { renderSqlite } from "../src/emit/sqlite.js";
import type { Change, ChangeStatus, TableDescriptor } from "../src/types.js";

const ALLOWED: ChangeStatus = { state: "allowed" };

const GONE: TableDescriptor = {
  name: "gone",
  columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
  indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
};

describe("forward drops tolerate an absent object (#313)", () => {
  test("postgres drop-table", () => {
    const { up } = renderPostgres([{ kind: "drop-table", table: "gone", status: ALLOWED }]);
    expect(up).toContain('DROP TABLE IF EXISTS "gone";');
  });

  test("postgres drop-view", () => {
    const { up } = renderPostgres([{ kind: "drop-view", view: "v_gone", status: ALLOWED }]);
    expect(up).toContain('DROP VIEW IF EXISTS "v_gone";');
  });

  test("postgres drop-index, plain", () => {
    const { up } = renderPostgres([{ kind: "drop-index", table: "t", index: "idx_gone", status: ALLOWED }]);
    expect(up).toContain('DROP INDEX IF EXISTS "idx_gone";');
  });

  test("postgres drop-index, constraint-backed (#285)", () => {
    const { up } = renderPostgres([{
      kind: "drop-index", table: "t", index: "uq_gone", status: ALLOWED,
      restore: { name: "uq_gone", columns: ["a"], unique: true, constraint: "unique" },
    }]);
    expect(up).toContain('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "uq_gone";');
  });

  test("postgres drop-fk", () => {
    const { up } = renderPostgres([{ kind: "drop-fk", table: "t", fk: "fk_gone", status: ALLOWED }]);
    expect(up).toContain('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "fk_gone";');
  });

  // drop-check IS produced by the diff (diff/index.ts:579, :592) — an evolved
  // `field.enum @values` is a live producer. The `renderUp` comment claiming
  // otherwise is deleted by this task.
  test("postgres drop-check", () => {
    const { up } = renderPostgres([{ kind: "drop-check", table: "t", check: "t_qty_chk", status: ALLOWED }]);
    expect(up).toContain('ALTER TABLE "t" DROP CONSTRAINT IF EXISTS "t_qty_chk";');
  });

  test("sqlite drop-table", () => {
    const { up } = renderSqlite([{ kind: "drop-table", table: "gone", status: ALLOWED }]);
    expect(up).toContain('DROP TABLE IF EXISTS "gone";');
  });

  test("sqlite drop-index", () => {
    const { up } = renderSqlite([{ kind: "drop-index", table: "t", index: "idx_gone", status: ALLOWED }]);
    expect(up).toContain('DROP INDEX IF EXISTS "idx_gone";');
  });

  // Already guarded before this task; pinned so a later sweep cannot un-guard it.
  test("sqlite drop-view was already guarded", () => {
    const { up } = renderSqlite([{ kind: "drop-view", view: "v_gone", status: ALLOWED }]);
    expect(up).toContain('DROP VIEW IF EXISTS "v_gone";');
  });
});

describe("down statements stay bare — a rollback must fail loudly", () => {
  test("postgres create-table down", () => {
    const { down } = renderPostgres([{ kind: "create-table", table: GONE, status: ALLOWED }]);
    expect(down).toContain('DROP TABLE "gone";');
    expect(down).not.toContain("DROP TABLE IF EXISTS");
  });

  test("postgres create-view down", () => {
    const { down } = renderPostgres([{
      kind: "create-view", status: ALLOWED,
      view: { name: "v", sql: "SELECT 1 AS one", columns: ["one"] },
    }]);
    expect(down).toContain('DROP VIEW "v";');
    expect(down).not.toContain("DROP VIEW IF EXISTS");
  });

  test("sqlite create-table down", () => {
    const { down } = renderSqlite([{ kind: "create-table", table: GONE, status: ALLOWED }]);
    expect(down).toContain('DROP TABLE "gone";');
    expect(down).not.toContain("DROP TABLE IF EXISTS");
  });
});

describe("the recreate-and-copy rebuild drop stays bare — deliberately", () => {
  test("sqlite recreate emits a bare DROP TABLE for the table it just copied from", () => {
    const expectedSchema = {
      tables: [{
        name: "orders",
        columns: [
          { name: "id", sqlType: { kind: "integer" as const, bits: 64 as const }, nullable: false },
          { name: "amount", sqlType: { kind: "integer" as const, bits: 64 as const }, nullable: false },
        ],
        indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
      }],
      views: [],
    };
    const { up } = renderSqlite(
      [{
        kind: "change-column-type", table: "orders", column: "amount",
        from: { kind: "real" }, to: { kind: "integer", bits: 64 }, status: ALLOWED,
      }],
      expectedSchema,
    );
    // IF EXISTS here would turn a caught corruption into a silent one: the recipe
    // just INSERT…SELECTed out of this exact table.
    expect(up).toContain('DROP TABLE "orders";');
    expect(up).not.toContain('DROP TABLE IF EXISTS "orders";');
  });
});
```

**If a literal above does not compile**, read the real shape in `src/types.ts` (`Change`,
`ChangeStatus`, `TableDescriptor`, `IndexDescriptor`, `ViewDescriptor`) and correct the literal.
Do not add a cast. `renderSqlite(changes, expectedSchema?, actualMeta?)` and
`renderPostgres(changes)` are the real signatures.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit-drop-if-exists.test.ts`
Expected: the six postgres + two sqlite "forward drops" tests FAIL. The "sqlite drop-view was
already guarded", the three "down statements stay bare" and the rebuild test PASS already — they pin
behaviour this task must not change.

- [ ] **Step 3: Implement — postgres forward drops**

In `emit/postgres.ts`, inside `renderUp`:

```ts
    case "drop-table":             return `DROP TABLE IF EXISTS ${quoteQualified(c.table, c.schema)};`;
```

```ts
    case "drop-index":
      return c.restore?.constraint !== undefined
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT IF EXISTS ${quote(c.index)};`
        : `DROP INDEX IF EXISTS ${quoteIndexQualified(c.index, c.schema)};`;
```

```ts
    case "drop-fk":                return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT IF EXISTS ${quote(c.fk)};`;
```

```ts
    case "drop-check":             return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT IF EXISTS ${quote(c.check)};`;
```

Replace the false comment above the check arms (`postgres.ts:99-102`) with the truth:

```ts
    // `drop-check` IS produced by the diff — diff/index.ts:579 and :592 push it,
    // and an evolved `field.enum @values` is a live producer. (An earlier comment
    // here claimed these arms were unreachable; they are not.) `add-check` is the
    // paired ADD and rides the same passes.
```

In `renderDropView` (`:375` and `:388`), change both forms:

```ts
  if (dependents.length === 0) return `DROP VIEW IF EXISTS ${qualified};`;
```

```ts
    `DROP VIEW IF EXISTS ${qualified} CASCADE;`,
```

**Do NOT touch `renderRestoreView` (`:431`).**

- [ ] **Step 4: Implement — sqlite forward drops**

In `emit/sqlite.ts`, inside `renderUpNative`, exactly two lines:

```ts
    case "drop-table":     return `DROP TABLE IF EXISTS ${quote(c.table)};`;
```

```ts
    case "drop-index":     return `DROP INDEX IF EXISTS ${quote(c.index)};`;
```

Leave `sqlite.ts:197` and `renderDownNative` untouched.

- [ ] **Step 5: Run the new test to verify it passes**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit-drop-if-exists.test.ts`
Expected: PASS, all thirteen.

- [ ] **Step 6: Fix the expected churn — five named files**

These assertions pin the exact bare statement and will go RED. Each is a FORWARD (`up`) assertion;
update it to the `IF EXISTS` form. **Read each one first**: if an assertion is on a `down`, the
correct fix is to leave it alone and check you did not edit a down renderer.

| File:line | Current | Becomes |
|---|---|---|
| `test/unit/emit-postgres.test.ts:136` | `DROP TABLE "legacy";` | `DROP TABLE IF EXISTS "legacy";` |
| `test/unit/emit-postgres.test.ts:164` | `DROP INDEX "old_idx";` | `DROP INDEX IF EXISTS "old_idx";` |
| `test/unit/emit-postgres.test.ts:187` | `ALTER TABLE "weeks" DROP CONSTRAINT "weeks_program_id_fk";` | `… DROP CONSTRAINT IF EXISTS "weeks_program_id_fk";` |
| `test/unit/emit-sqlite.test.ts:61` | `DROP TABLE "old";` | `DROP TABLE IF EXISTS "old";` |
| `test/unit/emit-sqlite.test.ts:77` | `DROP INDEX "i";` | `DROP INDEX IF EXISTS "i";` |
| `test/check/emit-postgres-check.test.ts:25` | `r.up` ⊃ `ALTER TABLE "orders" DROP CONSTRAINT "orders_status_chk";` | `… DROP CONSTRAINT IF EXISTS …` |
| `test/check-evolution/drop-check-down.test.ts:12` | `r.up` ⊃ `ALTER TABLE "orders" DROP CONSTRAINT "orders_qty_numeric_chk";` | `… DROP CONSTRAINT IF EXISTS …` |
| `test/integration/pg-constraint-backed-index-285.test.ts:143` | `/ALTER TABLE .*DROP CONSTRAINT "work_item_message_id_unique"/` | `/ALTER TABLE .*DROP CONSTRAINT IF EXISTS "work_item_message_id_unique"/` |

**Do NOT change these — they must stay green, and their staying green is the evidence:**
`test/unit/emit-postgres.test.ts:318` and `test/unit/emit-sqlite.test.ts:237` (down assertions),
`test/check/emit-postgres-check.test.ts:21` (down), `test/unit/emit-sqlite.test.ts:128` (the
recreate-and-copy rebuild drop), `test/write-migration*.test.ts` (hand-written SQL, not emitter
output), `test/unit/emit-views.test.ts:20` and `test/unit/diff.test.ts:264` (`/DROP VIEW/i`, which
still matches).

- [ ] **Step 7: Re-anchor the one negative assertion that would go VACUOUSLY green**

`test/integration/pg-constraint-backed-index-285.test.ts:142` is a *negative* assertion:

```ts
    expect(sqlText).not.toMatch(/DROP INDEX "?work_item_message_id_unique/);
```

Adding `IF EXISTS` puts ` IF EXISTS ` between `DROP INDEX` and the quote, so the regex stops matching
for a reason that has nothing to do with #285 — it would keep passing even if #285 fully regressed.
Re-anchor it so it still tests what it was written to test:

```ts
    // Anchored to tolerate the #313 `IF EXISTS` token: without `(IF EXISTS )?` this
    // negative assertion passes because the SPELLING changed, not because the
    // constraint-backed index is correctly dropped via ALTER TABLE.
    expect(sqlText).not.toMatch(/DROP INDEX (IF EXISTS )?"?work_item_message_id_unique/);
```

Then **prove the re-anchoring works**: temporarily revert the `drop-index` constraint-backed arm to
`DROP INDEX IF EXISTS …`, confirm line 142 goes RED, and restore. A negative assertion you have not
seen fail is not a test.

- [ ] **Step 8: Run the affected suites**

Run: `cd server/typescript && bun test packages/migrate-ts && bun test packages/cli`
Expected: PASS, both. If anything is still red, it is churn Step 6 missed — fix it here, not later.

- [ ] **Step 9: Typecheck**

Run: `bun run --filter '*' typecheck` (from the repository root)
Expected: all 18 packages exit 0.

- [ ] **Step 10: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/emit/postgres.ts \
        server/typescript/packages/migrate-ts/src/emit/sqlite.ts \
        server/typescript/packages/migrate-ts/test/emit-drop-if-exists.test.ts \
        server/typescript/packages/migrate-ts/test/unit/emit-postgres.test.ts \
        server/typescript/packages/migrate-ts/test/unit/emit-sqlite.test.ts \
        server/typescript/packages/migrate-ts/test/check/emit-postgres-check.test.ts \
        server/typescript/packages/migrate-ts/test/check-evolution/drop-check-down.test.ts \
        server/typescript/packages/migrate-ts/test/integration/pg-constraint-backed-index-285.test.ts
git commit -m "fix(migrate): forward drops tolerate an absent object so a chain can replay"
```

---

## Task 2: `CREATE SCHEMA IF NOT EXISTS` for non-default schemas

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/emit/postgres.ts` (`renderPostgres`)
- Test: `server/typescript/packages/migrate-ts/test/emit-postgres-create-schema.test.ts` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: no new exports.

**Context:** `CREATE SCHEMA` is emitted nowhere in `migrate-ts/src` or `cli/src` today except the
ledger's own (`apply/ledger.ts:126`). A chain containing `CREATE TABLE "reporting"."x"` therefore
cannot apply to a virgin database. SQLite has no schema namespacing
(`emit-sqlite-schema-rejected.test.ts` pins that a schema is rejected there), so this is
Postgres-only and is NOT a dialect split.

**Collect from `create-view` too, not only `create-table`.** Spec §3.3 says "ahead of the first
**object** in a non-default schema", and a first migration that creates only a *view* in
`"reporting"` fails identically. `create-view` carries the schema in **two** places — the change's
own `schema?` and `view.schema` — so read `c.schema ?? c.view.schema`, the same precedence
`renderCreateView(c.view, c.schema, …)` already uses.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/migrate-ts/test/emit-postgres-create-schema.test.ts
import { describe, test, expect } from "bun:test";
import { renderPostgres } from "../src/emit/postgres.js";
import type { ChangeStatus, TableDescriptor, ViewDescriptor } from "../src/types.js";

const ALLOWED: ChangeStatus = { state: "allowed" };

const t = (name: string, schema?: string): TableDescriptor => ({
  name,
  ...(schema !== undefined ? { schema } : {}),
  columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
  indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
});

const v = (name: string, schema?: string): ViewDescriptor => ({
  name,
  ...(schema !== undefined ? { schema } : {}),
  sql: "SELECT 1 AS one",
  columns: ["one"],
});

describe("a chain that creates an object in a non-default schema creates the schema first", () => {
  test("emits CREATE SCHEMA IF NOT EXISTS before the table", () => {
    const { up } = renderPostgres([{ kind: "create-table", table: t("x", "reporting"), status: ALLOWED }]);
    expect(up).toContain('CREATE SCHEMA IF NOT EXISTS "reporting";');
    expect(up.indexOf('CREATE SCHEMA IF NOT EXISTS "reporting";'))
      .toBeLessThan(up.indexOf("CREATE TABLE"));
  });

  // Spec §3.3 says "the first OBJECT", not "the first table". A chain whose first
  // migration creates only a view in a non-default schema fails identically.
  test("emits it for a create-view too", () => {
    const { up } = renderPostgres([{ kind: "create-view", view: v("v_x", "reporting"), status: ALLOWED }]);
    expect(up).toContain('CREATE SCHEMA IF NOT EXISTS "reporting";');
    expect(up.indexOf('CREATE SCHEMA IF NOT EXISTS "reporting";'))
      .toBeLessThan(up.indexOf("CREATE VIEW"));
  });

  test("emits it once for two objects in the same schema", () => {
    const { up } = renderPostgres([
      { kind: "create-table", table: t("x", "reporting"), status: ALLOWED },
      { kind: "create-table", table: t("y", "reporting"), status: ALLOWED },
      { kind: "create-view", view: v("v_x", "reporting"), status: ALLOWED },
    ]);
    expect(up.match(/CREATE SCHEMA IF NOT EXISTS "reporting";/g)).toHaveLength(1);
  });

  test("emits one per distinct schema, in sorted order", () => {
    const { up } = renderPostgres([
      { kind: "create-table", table: t("x", "zeta"), status: ALLOWED },
      { kind: "create-table", table: t("y", "alpha"), status: ALLOWED },
    ]);
    expect(up.indexOf('CREATE SCHEMA IF NOT EXISTS "alpha";'))
      .toBeLessThan(up.indexOf('CREATE SCHEMA IF NOT EXISTS "zeta";'));
  });

  test("emits nothing for the default schema", () => {
    const { up } = renderPostgres([{ kind: "create-table", table: t("x"), status: ALLOWED }]);
    expect(up).not.toContain("CREATE SCHEMA");
  });

  test("emits nothing for an explicit 'public'", () => {
    const { up } = renderPostgres([{ kind: "create-table", table: t("x", "public"), status: ALLOWED }]);
    expect(up).not.toContain("CREATE SCHEMA");
  });

  test("the down does NOT drop the schema", () => {
    const { down } = renderPostgres([{ kind: "create-table", table: t("x", "reporting"), status: ALLOWED }]);
    expect(down).not.toContain("DROP SCHEMA");
  });
});
```

The last case is a real decision, not filler: dropping a schema on rollback would destroy objects
this tool does not own and cannot restore.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit-postgres-create-schema.test.ts`
Expected: FAIL — the first four cases find no `CREATE SCHEMA`. The last three PASS already.

- [ ] **Step 3: Implement**

In `renderPostgres`, after the changes are sorted and before the returned `up` is joined:

```ts
  // A chain must be appliable to a VIRGIN database (#313). `CREATE TABLE "s"."x"`
  // fails there unless the schema exists, and no migration has ever created one.
  // IF NOT EXISTS because a later migration in the same chain, or an operator, may
  // have created it already. Views count as objects too, so a first migration that
  // creates only a view in a non-default schema is covered. Deliberately NOT dropped
  // in `down`: the schema may hold objects this tool does not own and cannot restore.
  const createdSchemas = new Set<string>();
  for (const c of sorted) {
    const s =
      c.kind === "create-table" ? c.table.schema
      : c.kind === "create-view" ? (c.schema ?? c.view.schema)
      : undefined;
    if (s !== undefined && s !== DEFAULT_DB_SCHEMA_POSTGRES) createdSchemas.add(s);
  }
  // Sorted so output is deterministic — the snapshot and golden tests rely on it.
  const schemaStmts = [...createdSchemas].sort().map((s) => `CREATE SCHEMA IF NOT EXISTS ${quote(s)};`);
```

then prepend to the returned `up`:

```ts
    up: [...schemaStmts, ...upStmts].join("\n\n"),
```

`DEFAULT_DB_SCHEMA_POSTGRES` is exported from `@metaobjectsdev/metadata` — `qualified-name.ts` and
`diff/index.ts:17` both already import it from there. If `postgres.ts` already has a local notion of
the default schema, use that rather than adding a second one.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit-postgres-create-schema.test.ts`
Expected: PASS, all seven.

- [ ] **Step 5: Run the affected suites**

Run: `cd server/typescript && bun test packages/migrate-ts && bun test packages/cli`
Expected: PASS. `emit-postgres-schema-namespacing.test.ts` is the file most likely to need updating;
read its assertions before changing them. Any churn is fixed here, in this task.

- [ ] **Step 6: Typecheck and commit**

Run: `bun run --filter '*' typecheck` — all 18 exit 0.

```bash
git add server/typescript/packages/migrate-ts/src/emit/postgres.ts \
        server/typescript/packages/migrate-ts/test/emit-postgres-create-schema.test.ts
git commit -m "fix(migrate): a chain creates the schema it needs, so it applies to a virgin database"
```

---

## Task 3: The in-process replay engine

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/verify/replay-engine.ts`
- Modify: `server/typescript/packages/migrate-ts/src/index.ts` (export it)
- Modify: `server/typescript/packages/migrate-ts/package.json` (optional peer + devDependency)
- Modify: `server/typescript/packages/cli/package.json` (`build:binary` external)
- Test: `server/typescript/packages/migrate-ts/test/unit/replay-engine.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export interface ReplayEngine {
    db: Kysely<Record<string, unknown>>;
    dispose: () => Promise<void>;
  }
  export function openReplayEngine(dialect: "postgres" | "sqlite"): Promise<ReplayEngine>;
  ```
  Tasks 4, 5 and 6 call `openReplayEngine` and must `await engine.dispose()` in a `finally`.

### Two decisions this task settles, both already verified

**Where it lives, and how the dependency is declared.** `openReplayEngine` goes in **`migrate-ts`**,
not `cli`: `migrate-ts`'s own tests (Tasks 4 and 5) need it, and `cli` depends on `migrate-ts`, so
putting it in `cli` would be a cycle. But `migrate-ts` today declares only `@iarna/toml` and
`@metaobjectsdev/metadata` as dependencies — `kysely` is a peer and every driver is dev-only,
deliberately. **PGlite is 22 MB of WASM**; a hard dependency would make every CLI adopter download it
to run `meta gen`. So:

- `@electric-sql/pglite` → **optional peerDependency** `">=0.3.0 <0.6.0"` + **devDependency**
  `"^0.5.0"`. Both 0.3.16 and 0.5.5 were verified against the adapter below.
- `@libsql/kysely-libsql` → **optional peerDependency** `">=0.4.0 <0.5.0"` + keep the existing
  devDependency. It is already a hard `dependencies` entry of `cli` (`^0.4.0`), so the CLI path
  always resolves it and only a direct `migrate-ts` embedder can miss it.
- Both are imported **lazily** inside the opener, with an install hint on failure, mirroring
  `cli/src/lib/kysely.ts`'s `buildKyselyFromUrl`.
- Peer ranges must be **bounded** or `scripts/check-peer-ranges.ts` fails the `gates` lane (its test
  is: a range is unbounded exactly when it accepts `9999.0.0`). Set
  `peerDependenciesMeta.<pkg>.optional = true` for both.
- `cli`'s `build:binary` bundles the CLI (`bun build ./bin/meta.ts --compile`). Add
  `--external @electric-sql/pglite` beside the two existing `--external @biomejs/*` flags, so the
  standalone binary does not embed 22 MB of WASM and instead resolves it from the adopter's project
  at run time.

**PGlite is NOT `pg`-compatible — a shim is required.** PGlite exposes `query`/`exec`/`close`;
kysely's `PostgresDialect` wants a `pg.Pool` (`connect()` → a client with `query()`/`release()`, plus
`end()`). The ~20-line shim below was **executed against PGlite 0.3.16 and 0.5.5** and verified to
handle: `CREATE SCHEMA`, a CHECK constraint, `information_schema` reads, kysely transactions,
transaction *rollback*, `pg_advisory_lock`/`pg_advisory_unlock` (which `applyPending` takes on
postgres), and — the one that matters — rejecting `DROP TABLE "theirs"` with exactly
`table "theirs" does not exist`, the reporter's error.

Also verified: `LibsqlDialect({ url: ":memory:" })` works, and two `:memory:` instances are fully
isolated from each other.

- [ ] **Step 1: Declare the dependencies**

In `server/typescript/packages/migrate-ts/package.json`:

```jsonc
  "peerDependencies": {
    "kysely": ">=0.27.0 <0.30.0",
    "@electric-sql/pglite": ">=0.3.0 <0.6.0",
    "@libsql/kysely-libsql": ">=0.4.0 <0.5.0"
  },
  "peerDependenciesMeta": {
    "@electric-sql/pglite": { "optional": true },
    "@libsql/kysely-libsql": { "optional": true }
  },
```

and add `"@electric-sql/pglite": "^0.5.0"` to `devDependencies` (`@libsql/kysely-libsql` is already
there). Then from the repository root: `bun install`.

In `server/typescript/packages/cli/package.json`, extend `build:binary`:

```
bun build ./bin/meta.ts --compile --outfile dist/meta --external @biomejs/wasm-bundler --external @biomejs/wasm-web --external @electric-sql/pglite
```

Run `bun run scripts/check-peer-ranges.ts` (or the `gates` lane's equivalent) and confirm it passes.

- [ ] **Step 2: Write the failing test**

```ts
// server/typescript/packages/migrate-ts/test/unit/replay-engine.test.ts
import { describe, test, expect } from "bun:test";
import { sql } from "kysely";
import { openReplayEngine } from "../../src/verify/replay-engine.js";

describe("openReplayEngine", () => {
  test("sqlite: gives an empty, usable database", async () => {
    const engine = await openReplayEngine("sqlite");
    try {
      await sql`CREATE TABLE t (id integer primary key)`.execute(engine.db);
      await sql`INSERT INTO t (id) VALUES (1)`.execute(engine.db);
      const rows = await sql<{ id: number }>`SELECT id FROM t`.execute(engine.db);
      expect(rows.rows).toHaveLength(1);
    } finally {
      await engine.dispose();
    }
  });

  test("postgres: gives an empty, usable database with real PG DDL", async () => {
    const engine = await openReplayEngine("postgres");
    try {
      // Schema namespacing + a CHECK — neither is expressible in sqlite, so this
      // proves the postgres engine is really Postgres.
      await sql`CREATE SCHEMA IF NOT EXISTS "reporting"`.execute(engine.db);
      await sql`CREATE TABLE "reporting"."t" (id integer primary key, n integer CHECK (n > 0))`.execute(engine.db);
      const rows = await sql<{ table_name: string }>`
        SELECT table_name FROM information_schema.tables WHERE table_schema = 'reporting'
      `.execute(engine.db);
      expect(rows.rows.map((r) => r.table_name)).toContain("t");
    } finally {
      await engine.dispose();
    }
  });

  // applyPending runs each migration file inside a kysely transaction and takes a
  // pg advisory lock on postgres. Both must work through the shim, or the gate
  // fails for a reason that has nothing to do with the chain under test.
  test("postgres: transactions roll back, and advisory locks work", async () => {
    const engine = await openReplayEngine("postgres");
    try {
      await sql`CREATE TABLE t (id integer primary key)`.execute(engine.db);
      await expect(
        engine.db.transaction().execute(async (trx) => {
          await sql`INSERT INTO t (id) VALUES (1)`.execute(trx);
          throw new Error("boom");
        }),
      ).rejects.toThrow(/boom/);
      const after = await sql<{ c: string }>`SELECT count(*)::text AS c FROM t`.execute(engine.db);
      expect(after.rows[0]?.c).toBe("0");

      await sql`SELECT pg_advisory_lock(hashtext('meta'))`.execute(engine.db);
      await sql`SELECT pg_advisory_unlock(hashtext('meta'))`.execute(engine.db);
    } finally {
      await engine.dispose();
    }
  });

  // The whole gate rests on this: a statement against a missing object must REJECT.
  test("postgres: dropping a missing table rejects — the #313 signal", async () => {
    const engine = await openReplayEngine("postgres");
    try {
      await expect(sql`DROP TABLE "theirs"`.execute(engine.db)).rejects.toThrow(/theirs/);
    } finally {
      await engine.dispose();
    }
  });

  test("sqlite: dropping a missing table rejects — the #313 signal", async () => {
    const engine = await openReplayEngine("sqlite");
    try {
      await expect(sql`DROP TABLE "theirs"`.execute(engine.db)).rejects.toThrow(/theirs/);
    } finally {
      await engine.dispose();
    }
  });

  test("two engines of the same dialect do not share state", async () => {
    const a = await openReplayEngine("sqlite");
    const b = await openReplayEngine("sqlite");
    try {
      await sql`CREATE TABLE only_in_a (id integer)`.execute(a.db);
      const rows = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE name = 'only_in_a'`.execute(b.db);
      expect(rows.rows).toHaveLength(0);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  test("dispose is idempotent", async () => {
    const engine = await openReplayEngine("sqlite");
    await engine.dispose();
    await engine.dispose();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/migrate-ts/test/unit/replay-engine.test.ts`
Expected: FAIL — `openReplayEngine` is not defined.

- [ ] **Step 4: Implement**

```ts
// server/typescript/packages/migrate-ts/src/verify/replay-engine.ts
//
// An empty, throwaway database that lives INSIDE this process.
//
// The replay gate has to apply a whole committed chain from nothing. Doing that
// against the user's server would mean CREATE DATABASE — which needs CREATEDB,
// breaks behind a connection pooler, is restricted on managed Postgres, collides
// between parallel CI jobs sharing one server, and puts a DROP DATABASE next to a
// name derived from a real one (Postgres truncates identifiers at 63 bytes, so a
// long enough target derives a scratch name that truncates back ONTO the target).
// None of that is worth it when the engines run in-process: PGlite is real Postgres
// compiled to WASM, and libsql runs sqlite in memory. Nothing to provision, nothing
// to clean up, nothing to drop by mistake.
//
// Both drivers are OPTIONAL peers imported lazily: PGlite is 22 MB of WASM and must
// not land in every `meta gen` adopter's node_modules. The install hints mirror
// `cli/src/lib/kysely.ts`'s.
import { Kysely } from "kysely";

export interface ReplayEngine {
  /** An empty database. The caller owns applying migrations into it. */
  db: Kysely<Record<string, unknown>>;
  /** Release the engine. Safe to call more than once. */
  dispose: () => Promise<void>;
}

export async function openReplayEngine(
  dialect: "postgres" | "sqlite",
): Promise<ReplayEngine> {
  return dialect === "postgres" ? openPglite() : openMemorySqlite();
}

async function openMemorySqlite(): Promise<ReplayEngine> {
  type LibsqlDialectCtor = new (opts: { url: string }) =>
    ConstructorParameters<typeof Kysely<Record<string, unknown>>>[0]["dialect"];
  let LibsqlDialect: LibsqlDialectCtor;
  try {
    const mod = await import("@libsql/kysely-libsql");
    LibsqlDialect = mod.LibsqlDialect as unknown as LibsqlDialectCtor;
  } catch {
    throw new Error(
      `the sqlite replay engine requires '@libsql/kysely-libsql'; install it to run 'meta verify --replay'`,
    );
  }
  const db = new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: ":memory:" }) });
  return disposable(db, async () => {});
}

async function openPglite(): Promise<ReplayEngine> {
  let PGliteCtor: new () => PgliteInstance;
  try {
    const mod = await import("@electric-sql/pglite");
    PGliteCtor = mod.PGlite as unknown as new () => PgliteInstance;
  } catch {
    throw new Error(
      `the postgres replay engine requires '@electric-sql/pglite' (in-process WASM Postgres); ` +
        `install it to run 'meta verify --replay' against a postgres chain`,
    );
  }
  const { PostgresDialect } = await import("kysely");
  const pg = new PGliteCtor();
  const db = new Kysely<Record<string, unknown>>({
    dialect: new PostgresDialect({ pool: pgliteAsPool(pg) as never }),
  });
  return disposable(db, () => pg.close());
}

/** The slice of PGlite's surface this file uses. */
interface PgliteInstance {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number; statement?: string }>;
  close(): Promise<void>;
}

/**
 * Kysely's PostgresDialect wants a `pg.Pool`: `connect()` returning a client with
 * `query()`/`release()`, plus `end()`. PGlite offers `query`/`close` and is a SINGLE
 * session, so every `connect()` hands back the same underlying instance — which is
 * correct here because a replay is strictly sequential, and it is what makes a
 * session advisory lock taken on one kysely connection visible to the next.
 *
 * `command` is only read by kysely to decide whether to report numAffectedRows; the
 * replay path never reads it, so PGlite's `statement` (or a SELECT default) suffices.
 */
function pgliteAsPool(pg: PgliteInstance): unknown {
  return {
    async connect() {
      return {
        async query(sqlText: unknown, params?: readonly unknown[]) {
          if (typeof sqlText !== "string") {
            throw new Error("the PGlite replay engine does not support cursors");
          }
          const r = await pg.query(sqlText, params ? [...params] : []);
          return {
            command: r.statement ?? "SELECT",
            rowCount: r.affectedRows ?? r.rows.length,
            rows: r.rows,
          };
        },
        release() { /* single session — nothing to return to a pool */ },
      };
    },
    async end() { await pg.close(); },
  };
}

function disposable(
  db: Kysely<Record<string, unknown>>,
  closeEngine: () => Promise<void>,
): ReplayEngine {
  let disposed = false;
  return {
    db,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      try { await db.destroy(); } catch { /* the engine is throwaway */ }
      try { await closeEngine(); } catch { /* idem */ }
    },
  };
}
```

- [ ] **Step 5: Export it**

In `server/typescript/packages/migrate-ts/src/index.ts`, beside the existing
`export { verifyReplay } from "./verify/replay.js";`:

```ts
export { openReplayEngine, type ReplayEngine } from "./verify/replay-engine.js";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server/typescript && bun test packages/migrate-ts/test/unit/replay-engine.test.ts`
Expected: PASS, all seven. PGlite's first boot takes ~1s; that is expected.

- [ ] **Step 7: Prove `introspect` works against PGlite**

`--replay-snapshot` (Task 6) introspects the replayed database. `introspect/postgres.ts` reads
`information_schema` and `pg_catalog` and calls `pg_get_viewdef` — all real Postgres, so this should
just work, but Task 6 stalls if it does not. Add one case to the same file:

```ts
  test("postgres: introspect reads back a table and a view", async () => {
    const engine = await openReplayEngine("postgres");
    try {
      await sql`CREATE TABLE t (id integer primary key, n integer NOT NULL)`.execute(engine.db);
      await sql`CREATE VIEW v AS SELECT id FROM t`.execute(engine.db);
      const snap = await introspect(engine.db, "postgres");
      expect(snap.tables.map((x) => x.name)).toContain("t");
      expect(snap.views.map((x) => x.name)).toContain("v");
    } finally {
      await engine.dispose();
    }
  });
```

(import `introspect` from `../../src/introspect/index.js`.)

**If PGlite cannot execute the postgres cases**, STOP and report it. The spec's engine tiering rests
on PGlite being real Postgres; if it is not sufficient, that is a design question, not something to
work around by weakening the test.

- [ ] **Step 8: Typecheck and commit**

Run: `bun run --filter '*' typecheck` — all 18 exit 0.
Run: `cd server/typescript && bun test packages/migrate-ts` — PASS.

```bash
git add server/typescript/packages/migrate-ts/src/verify/replay-engine.ts \
        server/typescript/packages/migrate-ts/src/index.ts \
        server/typescript/packages/migrate-ts/package.json \
        server/typescript/packages/cli/package.json \
        server/typescript/packages/migrate-ts/test/unit/replay-engine.test.ts \
        bun.lock
git commit -m "feat(migrate): an in-process replay engine, so the gate provisions nothing"
```

(The lockfile is at the repository root — confirm the path before staging.)

---

## Task 4: Thread scope inputs into `verifyReplay`

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/verify/replay.ts`
- Test: `server/typescript/packages/migrate-ts/test/integrity/replay-scoped.test.ts` (create)

**Interfaces:**
- Consumes: `openReplayEngine` (Task 3).
- Produces: `VerifyReplayArgs` gains one optional field:
  ```ts
  /** Out-of-scope names to exclude from the SNAPSHOT side, as `scopeExpectedSchema` produces. */
  governed?: GovernedScope;
  ```
  Task 6 passes it.

**Context:** `verifyReplay` (`verify/replay.ts:31`) compares a replayed database against the
committed snapshot. A project declaring `migrate.scope` writes the *other* owner's tables into that
snapshot on purpose (`carryForwardOutOfScope`, `scope.ts:93`), and the chain never creates them — so
today the comparison reports them as missing. `excludeFromSnapshot` (`scope.ts:130`) exists for
exactly this and is already used by the committed-snapshot gate at `verify.ts:659`.

**`excludeFromSnapshot` returns a `ScopedExpectedSchema`, not a `SchemaSnapshot`.** Its shape is
`{ snapshot, outOfScope, declaredSchemas? }` — take `.snapshot`. An empty `outOfScope` returns the
SAME snapshot object, so an unscoped caller's comparison is byte-for-byte what it was.

**`GovernedScope`** (`scope.ts:149`) is `{ outOfScope: readonly string[]; declaredSchemas?: readonly string[] }`,
and names are **qualified**: `<schema>.<name>` with an absent schema normalized to Postgres `public`
(`qualifiedDbName`, `qualified-name.ts:20`). SQLite objects normalize to the same `public.` prefix.
So the fixture below says `"public.theirs"`, not `"theirs"`.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/migrate-ts/test/integrity/replay-scoped.test.ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyReplay } from "../../src/verify/replay.js";
import { openReplayEngine } from "../../src/verify/replay-engine.js";
import type { SchemaSnapshot } from "../../src/types.js";

function chainWith(upSql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-scoped-"));
  mkdirSync(join(dir, "20260101000000-init"), { recursive: true });
  writeFileSync(join(dir, "20260101000000-init", "up.sql"), upSql, "utf8");
  writeFileSync(join(dir, "20260101000000-init", "down.sql"), 'DROP TABLE "mine";', "utf8");
  return dir;
}

// `id INTEGER NOT NULL PRIMARY KEY`, not a bare `INTEGER PRIMARY KEY`: sqlite reports
// notnull=0 for the latter, so `nullable: false` here would read as drift and the
// test would fail for a reason unrelated to scope. `test/integrity/replay.test.ts:47`
// writes it the same way, for the same reason.
const CHAIN = 'CREATE TABLE "mine" (id INTEGER NOT NULL PRIMARY KEY);';

const table = (name: string) => ({
  name,
  columns: [{ name: "id", sqlType: { kind: "integer" as const, bits: 64 as const }, nullable: false }],
  indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
});

// `theirs` belongs to another owner: `carryForwardOutOfScope` put it in the snapshot,
// and the chain — correctly — never creates it.
const SNAPSHOT: SchemaSnapshot = { tables: [table("mine"), table("theirs")], views: [] };

describe("verifyReplay honours migrate.scope", () => {
  test("an out-of-scope table in the snapshot is not reported as missing", async () => {
    const dir = chainWith(CHAIN);
    const engine = await openReplayEngine("sqlite");
    try {
      const result = await verifyReplay({
        db: engine.db,
        dialect: "sqlite",
        migrationsDir: dir,
        snapshot: SNAPSHOT,
        // Qualified: `<schema>.<name>`, absent schema normalized to `public`.
        governed: { outOfScope: ["public.theirs"] },
      });
      expect(result.ok).toBe(true);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without `governed`, the same case reports drift — the control", async () => {
    const dir = chainWith(CHAIN);
    const engine = await openReplayEngine("sqlite");
    try {
      const result = await verifyReplay({
        db: engine.db, dialect: "sqlite", migrationsDir: dir, snapshot: SNAPSHOT,
      });
      expect(result.ok).toBe(false);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

The control case is what makes the first test non-vacuous: it proves the difference comes from
`governed` and not from the fixture being trivially green.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/migrate-ts/test/integrity/replay-scoped.test.ts`
Expected: the first test FAILS (`governed` is not accepted / not honoured); the control PASSES.

- [ ] **Step 3: Implement**

In `verify/replay.ts`, add the optional field to `VerifyReplayArgs`:

```ts
  /**
   * The scope decision the run made, as `scopeExpectedSchema` reports it. A project
   * declaring `migrate.scope` carries the OTHER owner's tables into the committed
   * snapshot on purpose (`carryForwardOutOfScope`), and the chain never creates them —
   * so without this they read as missing on every replay. Excluded from the SNAPSHOT
   * side only; the replayed database never had them either.
   */
  governed?: GovernedScope;
```

and apply the exclusion before comparing:

```ts
  const expected = args.governed !== undefined
    ? excludeFromSnapshot(args.snapshot, args.governed).snapshot
    : args.snapshot;
  const classification = await driftAgainstSnapshot(expected, actual, args.dialect);
```

Import `excludeFromSnapshot` and `type GovernedScope` from `../scope.js`. Do not change the
signature's required fields — an existing caller passing no `governed` must behave exactly as before.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server/typescript && bun test packages/migrate-ts/test/integrity/replay-scoped.test.ts`
Expected: PASS, both.

- [ ] **Step 5: Run the suite, typecheck, commit**

Run: `cd server/typescript && bun test packages/migrate-ts` — PASS.
Run: `bun run --filter '*' typecheck` — all 18 exit 0.

```bash
git add server/typescript/packages/migrate-ts/src/verify/replay.ts \
        server/typescript/packages/migrate-ts/test/integrity/replay-scoped.test.ts
git commit -m "fix(migrate): verifyReplay honours migrate.scope on the snapshot side"
```

---

## Task 5: `meta verify --replay` — the chain applies from empty

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts` (`VerifyFlags`, `parseVerifyArgs`)
- Modify: `server/typescript/packages/cli/src/commands/verify.ts`
- Test: `server/typescript/packages/migrate-ts/test/integrity/replay-emitted-chain.test.ts` (create)
- Test: `server/typescript/packages/cli/test/verify-replay.test.ts` (create)

**Interfaces:**
- Consumes: `openReplayEngine` (Task 3).
- Produces: the `--replay` flag on `VerifyFlags`; Task 6 adds `--replay-snapshot` beside it.

**Context:** `verify` composes gates and returns `Math.max(...)` of their exit codes
(`verify.ts:239`). `anyExplicit` (`args.ts:290`) decides whether the bare-`verify` default fires —
`--replay` must be included in it, or passing `--replay` alone would also silently run the template
gate. Refuse `--migration-format flyway` and `--dialect d1`, mirroring `apply-pending`
(`migrate.ts:419-426`, `:449-457`).

### The dialect, when there is no `--db`

`--replay` has no connection URL to infer a dialect from, and `--replay-snapshot` needs one to name
the snapshot file (`snapshotPath(dir, dialect)`). **Precedence, stated so it is not invented twice:**

1. an explicit `--dialect`,
2. else `resolveMigrateConfig(EMPTY_MIGRATE_FLAGS, projectRoot).dialect`,
3. else refuse with **exit 2**, naming `--dialect`.

Step 2 requires amending the comment on `EMPTY_MIGRATE_FLAGS` (`verify.ts:81-87`), which today says
verify "consumes only `outDir`… reading any of them here would be reaching into migrate's
decisions". Amend it, do not quietly contradict it:

```ts
 * `verify` consumes `outDir` (#292) and — for the replay gate only — `dialect`. The
 * #292 restriction was about the DRIFT gate, whose dialect comes from the live `--db`
 * URL; the replay gate has no `--db`, and the dialect a committed chain was emitted
 * for IS a migrate decision, so migrate's own resolution is the only correct source.
 * Everything else here exists to satisfy the shared shape.
```

### Zero committed migrations

`discoverMigrations` is **not exported** from `apply/apply.ts` (it is a module-private function at
`:316`), so the gate cannot call it. Use `applyPending`'s return value instead:
`ApplyPendingResult` is `{ pending: string[]; applied: string[] }`, and on a fresh in-process
database with no ledger every discovered migration is pending — so `pending.length === 0` means the
directory held none. Report it and return 0; do not pass silently.

- [ ] **Step 1: Write the RED-first regression — the emitter's own SQL, through `applyPending`**

This is the test the previous draft of this plan was missing. Hand-writing the SQL proves nothing
about the emitter: such a test stays green if Task 1 is reverted. This one builds a `drop-table`
change, runs it through `emit()` and `writeMigration()`, and applies the resulting file — so it is
RED before Task 1 and GREEN after, and it is the only assertion that proves an *emitted* chain
replays.

```ts
// server/typescript/packages/migrate-ts/test/integrity/replay-emitted-chain.test.ts
//
// #313, end to end: the EMITTER's output, written by writeMigration, applied by
// applyPending into an empty in-process database. Every prior defect in this area
// (#226/#241, #243, #255, #285, 0.21.4's BEGIN TRANSACTION finding) shared one shape
// — SQL proven statement-by-statement and never proven through the tool that applies
// it. applyPending rewrites statements via prepareForRunnerTransaction before
// executing, so an emit-level assertion cannot see this class of bug.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emit } from "../../src/emit/index.js";
import { writeMigration } from "../../src/write-migration.js";
import { applyPending } from "../../src/apply/apply.js";
import { openReplayEngine } from "../../src/verify/replay-engine.js";
import type { Change, ChangeStatus } from "../../src/types.js";

const ALLOWED: ChangeStatus = { state: "allowed" };

// Exactly the reported shape: another tool owned `theirs`, so the diff proposed
// dropping it, and no migration in the chain ever created it.
const REPORTED: Change[] = [
  {
    kind: "create-table", status: ALLOWED,
    table: {
      name: "mine",
      columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
      indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
    },
  },
  { kind: "drop-table", table: "theirs", status: ALLOWED },
];

describe("an EMITTED chain applies to an empty database (#313)", () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    test(`${dialect}: emit → writeMigration → applyPending, from empty`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `replay-emitted-${dialect}-`));
      const engine = await openReplayEngine(dialect);
      try {
        const result = emit(REPORTED, { dialect });
        await writeMigration(dir, "init", result);
        const applied = await applyPending(engine.db, dir, { dryRun: false, dialect });
        expect(applied.applied).toHaveLength(1);
      } finally {
        await engine.dispose();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("the control: a HAND-WRITTEN bare drop still fails, so the assertion has teeth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-emitted-control-"));
    const engine = await openReplayEngine("sqlite");
    try {
      await writeMigration(dir, "init", {
        up: 'CREATE TABLE "mine" (id INTEGER NOT NULL PRIMARY KEY);\n\nDROP TABLE "theirs";',
        down: 'DROP TABLE "mine";',
        recreatedTables: new Set<string>(),
      });
      await expect(applyPending(engine.db, dir, { dryRun: false, dialect: "sqlite" }))
        .rejects.toThrow(/theirs/);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

**Adjust `writeMigration`'s call shape to the real signature** — read
`migrate-ts/src/write-migration.ts` first; it may take an options object rather than
`(dir, slug, result)`, and its `EmitResult` may carry more fields than the three above.
`ApplyPendingResult` names its list `applied`.

- [ ] **Step 2: Run it — it must be RED unless Task 1 has landed**

Run: `cd server/typescript && bun test packages/migrate-ts/test/integrity/replay-emitted-chain.test.ts`
Expected **if Task 1 has landed**: PASS, all three.
Expected **if Task 1 has not landed**: the two emitted-chain cases FAIL with `theirs`, the control
passes. Either outcome is informative — record which one you saw. If Task 1 has landed and a case
still fails, STOP: the emitter fix is incomplete.

- [ ] **Step 3: Add the flag**

In `cli/src/lib/args.ts`, add to `VerifyFlags`:

```ts
  /** Replay the committed migration chain into an in-process database and assert it applies. */
  replay: boolean;
```

add to the `parseArgs` options:

```ts
      replay: { type: "boolean", default: false },
```

include it in the parsed object (`replay: !!values.replay`), and add it to `anyExplicit`:

```ts
  const anyExplicit = templates || codegen || values.db !== undefined || dialect === "d1" || !!values.replay;
```

- [ ] **Step 4: Write the CLI tests**

```ts
// server/typescript/packages/cli/test/verify-replay.test.ts
import { describe, test, expect } from "bun:test";
import { parseVerifyArgs } from "../src/lib/args.js";

describe("verify --replay flag", () => {
  test("is parsed", () => {
    expect(parseVerifyArgs(["--replay"]).replay).toBe(true);
  });

  test("counts as an explicit subverb, so it does not also run the template gate", () => {
    expect(parseVerifyArgs(["--replay"]).anyExplicit).toBe(true);
  });

  test("defaults off", () => {
    expect(parseVerifyArgs([]).replay).toBe(false);
  });
});
```

- [ ] **Step 5: Implement the gate**

In `cli/src/commands/verify.ts`, add a `runReplayVerify()` beside the existing gates and include it
in the `Math.max`:

```ts
  const replayExit = (flags.replay || flags.replaySnapshot) ? await runReplayVerify() : 0;
  …
  return Math.max(templateExit, schemaExit, codegenExit, requirementExit, replayExit);
```

**Write the condition as `(flags.replay || flags.replaySnapshot)` now, in this task**, even though
`replaySnapshot` does not exist yet — add the field in Task 6 and this line needs no second edit.
(If TypeScript objects to the missing field, add `replaySnapshot: boolean` to `VerifyFlags` here and
wire its parsing in Task 6; do not leave the condition reading `flags.replay` alone, which is how
`--replay-snapshot` would ship dead.)

`runReplayVerify` must:

1. **Resolve the dialect** by the precedence above. Refuse `d1` and `--migration-format flyway` with
   `log.error` and **exit 2**, matching `apply-pending`'s wording at `migrate.ts:419-426` and
   `:449-457`. Refuse with exit 2 and a message naming `--dialect` when no dialect can be resolved.
2. **Resolve the migrations directory through migrate's OWN precedence** — the same
   `resolveMigrateConfig(EMPTY_MIGRATE_FLAGS, projectRoot)` → `resolvePath(projectRoot, migrateConfig.outDir)`
   pair `checkCommittedSnapshot` uses (`verify.ts:639-641`). Do not re-derive it.
3. `openReplayEngine(dialect)` inside a `try`, with `await engine.dispose()` in the `finally`.
   An engine that cannot start (including a missing optional peer) is **operational → return 2**,
   and the error's own message already carries the install hint.
4. `applyPending(engine.db, dir, { dryRun: false, dialect })`.
5. **Zero migrations is not a silent pass.** When the result's `pending` is empty, print
   `meta verify --replay: no committed migrations — nothing to replay` and return 0.
6. On an apply failure, print the failing statement and the remediation. An already-applied chain
   cannot be repaired by hand-editing (`apply/apply.ts:88-99` makes migrations checksum-immutable),
   so the message must name the compensating-migration path:
   `meta verify --replay: the committed chain does not apply to an empty database. Applied migrations are immutable, so fix this with a NEW migration that creates the missing object — not by editing a committed up.sql.`
   Return **1** (drift), not 2.

- [ ] **Step 6: Add a behavioural CLI test, not only a flag-parse test**

Three flag-parse assertions do not prove the gate runs. Add one case that drives `verifyCommand`
against a temporary project whose committed chain contains a bare drop for an object it never
creates, and assert the command returns **1**. Model the project fixture on
`packages/cli/test/migrate-scope.test.ts`'s harness — read it first — but note it drives the
**offline** path (`runOfflineGenerate`/`runBaseline`); what you need here is a `metaobjects/`
directory, a `.metaobjects/config.json` declaring `migrate.dialect`, and a committed
`migrations/<ts>-init/up.sql`. No database is involved, which is the point.

Also assert the zero-migrations case returns 0 and says so.

- [ ] **Step 7: Run the tests**

Run: `cd server/typescript && bun test packages/cli/test/verify-replay.test.ts && bun test packages/migrate-ts/test/integrity`
Expected: PASS.

- [ ] **Step 8: Run the suites, typecheck, commit**

Run: `cd server/typescript && bun test packages/cli && bun test packages/migrate-ts` — PASS.
Run: `bun run --filter '*' typecheck` — all 18 exit 0.

```bash
git add server/typescript/packages/cli/src/lib/args.ts \
        server/typescript/packages/cli/src/commands/verify.ts \
        server/typescript/packages/cli/test/verify-replay.test.ts \
        server/typescript/packages/migrate-ts/test/integrity/replay-emitted-chain.test.ts
git commit -m "feat(cli): meta verify --replay asserts the committed chain applies from empty"
```

---

## Task 6: `meta verify --replay-snapshot` — the chain reproduces the snapshot

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts`
- Modify: `server/typescript/packages/cli/src/commands/verify.ts`
- Test: `server/typescript/packages/cli/test/verify-replay.test.ts` (extend)

**Interfaces:**
- Consumes: `openReplayEngine` (Task 3), `verifyReplay` with `governed` (Task 4), the
  `runReplayVerify` structure and the `(flags.replay || flags.replaySnapshot)` condition (Task 5).
- Produces: nothing later tasks depend on.

**Context:** This is a **separate subverb, not `--strict`**. `verify` already owns a `--lax` flag on
a different axis (ADR-0023 attribute strictness, `args.ts:244`), and `--strict` beside it would read
as that flag's opposite rather than as a replay depth.

**This tier cannot pass for baseline-adopted projects and does not try to detect them.** The only
candidate signal, `BASELINE_NAME`/`recordBaseline` (`ledger.ts:205-227`), has no production caller
and would live in the target database's ledger while this gate runs against a fresh in-process
database with no ledger at all. The limitation is documented in Task 8, and the failure message
names it.

### `governed` has to be derived OFFLINE

`verify.ts:659` gets its `GovernedScope` from `driftResult` (`verify.ts:498`), which comes from
`computeDriftFromActual` and needs a live `--db`. This gate has none. Derive it instead:

- `collection.inMigrateScope` (already read at `verify.ts:217` as `schemaScope`) is the predicate.
- **When it is `undefined`, pass no `governed` at all** — an unscoped project's comparison is then
  byte-for-byte unchanged, which is most projects and keeps the added surface confined.
- When it is defined, build the provenance-bearing expected schema and scope it, exactly as
  `verify.ts:435-441` already does inside `migrateScopeMismatch`:
  ```ts
  const viewStrategy = forgeConfig?.columnNamingStrategy ?? "snake_case";
  const built = buildExpectedSchemaWithProvenance(root, {
    dialect,
    columnNamingStrategy: viewStrategy,
    views: buildProjectionViews(root, { dialect, columnNamingStrategy: viewStrategy }),
  });
  const governed = scopeExpectedSchema(built, schemaScope);  // satisfies GovernedScope
  ```
  `scopeExpectedSchema` needs `ExpectedSchemaWithProvenance` — a snapshot plus a
  qualified-name → metadata-FQN map — which is why the committed snapshot alone cannot be scoped
  and the metadata must be rebuilt here.

### One engine, one real apply

`verifyReplay` calls `applyPending` unconditionally (`replay.ts:31`). That is **not** a second
replay: the first `applyPending` (Task 5 step 5.4) recorded every migration in the in-process
ledger, so the second call finds nothing pending and returns immediately. Share one engine, let each
tier keep its own failure message, and do not restructure `verifyReplay` to avoid the call.

- [ ] **Step 1: Write the failing tests**

Append to `packages/cli/test/verify-replay.test.ts`:

```ts
describe("verify --replay-snapshot flag", () => {
  test("is parsed", () => {
    expect(parseVerifyArgs(["--replay-snapshot"]).replaySnapshot).toBe(true);
  });

  test("counts as an explicit subverb", () => {
    expect(parseVerifyArgs(["--replay-snapshot"]).anyExplicit).toBe(true);
  });

  test("does not collide with --lax, which is a different axis", () => {
    const f = parseVerifyArgs(["--replay-snapshot", "--lax"]);
    expect(f.replaySnapshot).toBe(true);
    expect(f.lax).toBe(true);
  });
});
```

**And the behavioural test that keeps the flag from shipping dead** — the previous draft had three
flag-parse tests and nothing that ran the gate, so `--replay-snapshot` would have parsed fine and
done nothing. Using the Task 5 Step 6 project harness:

```ts
describe("verify --replay-snapshot actually runs the gate", () => {
  test("a chain that does not apply fails under --replay-snapshot alone", async () => {
    // --replay-snapshot implies --replay's work; a broken chain must fail even when
    // --replay was not passed.
    const project = await projectWithBrokenChain();
    expect(await verifyCommand(["--replay-snapshot"], project)).toBe(1);
  });

  test("a chain that applies but does not reproduce the snapshot fails", async () => {
    const project = await projectWithChainDivergentFromSnapshot();
    expect(await verifyCommand(["--replay-snapshot"], project)).toBe(1);
  });

  test("a chain that applies and reproduces the snapshot passes", async () => {
    const project = await projectWithGoodChain();
    expect(await verifyCommand(["--replay-snapshot"], project)).toBe(0);
  });
});
```

Adapt the helper names and the `verifyCommand` call shape to the real harness.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/cli/test/verify-replay.test.ts`
Expected: FAIL — `--replay-snapshot` is not a known option (`strict: true` in `parseArgs`).

- [ ] **Step 3: Implement the flag**

Same places as Task 5: the `VerifyFlags` field (`replaySnapshot: boolean`), the `parseArgs` option
(`"replay-snapshot": { type: "boolean", default: false }`), the parsed object
(`replaySnapshot: !!values["replay-snapshot"]`), and `anyExplicit`. **Verify that Task 5's
`(flags.replay || flags.replaySnapshot)` condition is present and now reachable** — this is the exact
line whose absence would ship the flag dead.

- [ ] **Step 4: Implement the tier**

Extend `runReplayVerify` so that when `flags.replaySnapshot` is set it additionally:

1. Loads the committed snapshot the way `checkCommittedSnapshot` does (`verify.ts:639-644`):
   `readSnapshot(snapshotPath(dir, dialect))` on the already-resolved `dir`, inside a `try`.
   **Fail OPEN**: a `null` snapshot, or an unreadable/unparseable file, reports
   `meta verify --replay-snapshot: no committed snapshot — nothing to compare` and contributes 0.
   A project that has never generated one offline is not in an error state, and a parse failure is
   migrate's error to raise with its own message, not a drift verdict.
2. Derives `governed` per the section above.
3. Calls `verifyReplay({ db: engine.db, dialect, migrationsDir: dir, snapshot, ...(governed !== undefined ? { governed } : {}) })`.
4. On `ok === false`, reports the drift and returns **1**, with a message that names baseline
   adoption as the first thing to rule out:
   `meta verify --replay-snapshot: the replayed chain does not reproduce the committed snapshot. If this project was adopted with 'migrate baseline --from-db', its chain does not build the schema and this tier does not apply — use --replay instead.`

- [ ] **Step 5: Run the tests**

Run: `cd server/typescript && bun test packages/cli/test/verify-replay.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the suites, typecheck, commit**

Run: `cd server/typescript && bun test packages/cli && bun test packages/migrate-ts` — PASS.
Run: `bun run --filter '*' typecheck` — all 18 exit 0.

```bash
git add server/typescript/packages/cli/src/lib/args.ts \
        server/typescript/packages/cli/src/commands/verify.ts \
        server/typescript/packages/cli/test/verify-replay.test.ts
git commit -m "feat(cli): meta verify --replay-snapshot asserts the chain reproduces the snapshot"
```

---

## Task 7: Emit-time provenance guard

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/types.ts` (`AllowOptions.dropUnmanaged`)
- Modify: `server/typescript/packages/cli/src/lib/args.ts` (`ALLOW_TOKENS`)
- Modify: `server/typescript/packages/cli/src/lib/allow.ts` (`ALLOW_TOKEN_MAP`)
- Modify: `server/typescript/packages/sdk/src/config.ts` (`AllowTokenEnum`)
- Modify: `server/typescript/packages/cli/src/commands/migrate.ts`
- Test: `server/typescript/packages/cli/test/migrate-drop-unmanaged.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: the `drop-unmanaged` allow token.

**Context:** Tasks 1–6 make a bad chain survivable and detectable. This stops it being written. The
live path (`migrate.ts:607-620`) diffs metadata against introspection and **never consults the
committed snapshot**, which is why an object no snapshot ever contained gets proposed for a drop.
`drift/classify.ts:6-9` already states the doctrine: objects present in the DB but not the snapshot
"must never be treated as actionable drift or auto-dropped".

The guard does not false-fire on the brownfield classes, because both of them *add* to the snapshot:
a `baseline --from-db` snapshot contains the foreign table, and a scoped project carries out-of-scope
entries forward into it. The guard fires precisely when nothing ever claimed the object.

### A new `--allow` token touches FOUR files, and a pin test will catch three of them

`cli/test/unit/allow-tokens-pinned.test.ts` asserts three invariants, all self-deriving (so it needs
no edit, and it fails loudly if any file is missed):

1. `ALLOW_TOKENS` (`cli/src/lib/args.ts:173`) ≡ `AllowTokenEnum.options` (`sdk/src/config.ts:22`) —
   the sdk enum validates `migrate.allow` in `.metaobjects/config.json`.
2. `ALLOW_TOKEN_MAP` (`cli/src/lib/allow.ts:13`) has exactly one key per token — the map is what
   *grants* the permission; a token in the list but not the map validates cleanly and silently grants
   nothing.
3. Every mapped value is a **distinct** `AllowOptions` field.

**Decision: add `dropUnmanaged?: boolean` to `AllowOptions`** (`migrate-ts/src/types.ts:300`) and
wire the token through all four structures. The alternative — keeping `drop-unmanaged` out of
`ALLOW_TOKENS` and validating it separately — means a second token list and a second parse path for
exactly one token, which is precisely the drift the pin test exists to prevent. The cost is that one
`AllowOptions` field is read by the CLI rather than by `diff()`'s status pass; document that at the
field, so it is a stated exception rather than a puzzle.

- [ ] **Step 1: Write the failing tests**

```ts
// server/typescript/packages/cli/test/migrate-drop-unmanaged.test.ts
import { describe, test, expect } from "bun:test";
import { ALLOW_TOKENS } from "../src/lib/args.js";
import { ALLOW_TOKEN_MAP } from "../src/lib/allow.js";
import { tokensToAllowOptions } from "../src/lib/allow.js";

describe("drop-unmanaged allow token", () => {
  test("is a recognised allow token", () => {
    expect(ALLOW_TOKENS).toContain("drop-unmanaged");
  });

  test("grants a permission rather than validating into nothing", () => {
    expect(ALLOW_TOKEN_MAP["drop-unmanaged"]).toBe("dropUnmanaged");
    expect(tokensToAllowOptions(["drop-unmanaged"]).dropUnmanaged).toBe(true);
  });
});
```

Then the behavioural tests. They must drive the real live `migrate` path with a committed snapshot
that does NOT contain the table being dropped, and assert the run refuses. Three cases:

1. A drop proposed for a table absent from the committed snapshot ⇒ refused, **exit 2**, message
   names the object and `--allow drop-unmanaged`.
2. The same run with `--allow drop-unmanaged` ⇒ proceeds.
3. **Non-false-fire:** a drop for a table that IS in the snapshot ⇒ proceeds without the flag.
4. **Fail open:** the same run with NO snapshot on disk ⇒ proceeds without the flag.

**The harness is the hard part, and `migrate-scope.test.ts` is not it.** That file drives the
OFFLINE path (`runOfflineGenerate`/`runBaseline`), where the expected side already *is* the snapshot,
so the guard can never fire there. The guard's target is the **live** path (`migrate.ts:607-620`),
which needs a real database. Use the `:memory:` libsql engine from Task 3 — or, if Task 7 runs before
Task 3, `LibsqlDialect({ url: ":memory:" })` directly (verified working) — seed it with the tables the
scenario needs, and point `meta migrate --db` at it. Read
`packages/migrate-ts/test/integration/` for how the existing live-path tests build a database and a
project side by side.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/cli/test/migrate-drop-unmanaged.test.ts`
Expected: FAIL — the token is not in `ALLOW_TOKENS`.

- [ ] **Step 3: Add the token — all four files**

`migrate-ts/src/types.ts`, in `AllowOptions`:

```ts
  /**
   * Permits dropping an object the COMMITTED SNAPSHOT never contained — i.e. one
   * this toolchain never managed. Without it such a drop is refused at generation
   * time, because it produces a migration that cannot replay against a database
   * where that object never existed (#313).
   *
   * The one field here read by the CLI's generation-time provenance guard rather
   * than by `diff()`'s status pass: it lives in `AllowOptions` so `--allow` keeps
   * ONE token list and ONE grant map (`ALLOW_TOKENS` / `ALLOW_TOKEN_MAP`, pinned by
   * `cli/test/unit/allow-tokens-pinned.test.ts`). A second parallel validation path
   * for a single token is the drift that pin exists to prevent.
   */
  dropUnmanaged?: boolean;
```

`cli/src/lib/args.ts`, in `ALLOW_TOKENS`, with a comment in the style of its neighbours:

```ts
  // drop-unmanaged permits dropping an object the COMMITTED SNAPSHOT never
  // contained — i.e. one this toolchain never managed. Without it such a drop is
  // refused at generation time, because it produces a migration that cannot replay
  // against a database where that object never existed (#313).
  "drop-unmanaged",
```

`cli/src/lib/allow.ts`, in `ALLOW_TOKEN_MAP`:

```ts
  // Read by migrate's generation-time provenance guard, not by diff()'s status pass
  // — see AllowOptions.dropUnmanaged for why it still lives in that shape.
  "drop-unmanaged": "dropUnmanaged",
```

`sdk/src/config.ts`, in `AllowTokenEnum`:

```ts
  "drop-unmanaged",
```

- [ ] **Step 4: Implement the guard**

In `cli/src/commands/migrate.ts`, in the **live** path, immediately after
`changeCounts = summarizeChanges(diffResult.changes);` (`migrate.ts:657`) and **before** the
`emit(...)` block:

```ts
    // #313 — refuse to author a drop for an object the committed snapshot never
    // contained. The live path diffs metadata against introspection and never reads
    // the snapshot, so an object another tool owns reads as "in the DB, not in the
    // model" and is proposed for a drop; the resulting migration then cannot replay
    // against a database where the object never existed. `classify.ts:6-9` already
    // states the doctrine — this is where it is enforced.
    //
    // Fails OPEN when there is no snapshot on disk: a project that has never
    // generated one is not in an error state, and refusing there would break the
    // first `meta migrate` of every greenfield project.
```

The implementation:

1. Load the snapshot the way `migrate.ts:781-782` already spells it:
   `readSnapshot(snapshotPath(resolvePath(metaRoot, config.outDir), kysely.dialect))`, inside a
   `try`. A thrown read, or a `null` result, **skips the guard entirely**.
2. Build the set of snapshot object names with **`qualifiedDbName`** (`migrate-ts/src/qualified-name.ts`)
   over `snapshot.tables` and `snapshot.views`. Use that helper and nothing else — three independent
   sets already have to agree on this spelling, and a fourth would silently un-guard objects.
3. Collect every `drop-table` / `drop-view` in `diffResult.changes` whose `qualifiedDbName({ name, schema })`
   is absent from that set. (`drop-table` carries `table: string` + `schema?`; `drop-view` carries
   `view: string` + `schema?`.)
4. If that set is non-empty and `tokensToAllowOptions(config.allow).dropUnmanaged` is not true,
   `log.error` naming each object and `--allow drop-unmanaged`, close the connection, and return 2.

- [ ] **Step 5: Run the tests**

Run: `cd server/typescript && bun test packages/cli/test/migrate-drop-unmanaged.test.ts && bun test packages/cli/test/unit/allow-tokens-pinned.test.ts`
Expected: PASS. The pin test passing is the evidence all four files were updated.

- [ ] **Step 6: Run the suites, typecheck, commit**

Run: `cd server/typescript && bun test packages/cli && bun test packages/migrate-ts && bun test packages/sdk` — PASS.
Run: `bun run --filter '*' typecheck` — all 18 exit 0.

```bash
git add server/typescript/packages/migrate-ts/src/types.ts \
        server/typescript/packages/cli/src/lib/args.ts \
        server/typescript/packages/cli/src/lib/allow.ts \
        server/typescript/packages/sdk/src/config.ts \
        server/typescript/packages/cli/src/commands/migrate.ts \
        server/typescript/packages/cli/test/migrate-drop-unmanaged.test.ts
git commit -m "feat(cli): refuse to drop an object the committed snapshot never managed"
```

---

## Task 8: Documentation and CHANGELOG

**Files:**
- Modify: `docs/features/migrations-and-drift.md`
- Modify: `server/typescript/packages/cli/src/commands/migrate.ts` (help text)
- Modify: `server/typescript/packages/cli/src/commands/verify.ts` (help/subverb note)
- Modify: `CHANGELOG.md`

**Interfaces:** none.

- [ ] **Step 1: Correct the overclaim**

`docs/features/migrations-and-drift.md:58` currently says `apply-pending` "is the way to provision a
fresh or CI database". That is true only of a chain that builds the schema. Scope the sentence, and
point at `meta verify --replay` as the way to know your chain is one of those.

- [ ] **Step 2: Document both tiers**

In the same file, document `meta verify --replay` and `--replay-snapshot`: what each asserts, that
they run in-process (PGlite / `:memory:` libsql) and provision nothing, that PGlite is an **optional
peer** a postgres project installs to use the gate, that flyway and d1 are refused, how the dialect
is resolved without `--db`, and — stated plainly — that `--replay-snapshot` does not apply to a
project adopted with `migrate baseline --from-db`, because such a chain does not build the schema.

- [ ] **Step 3: Document the guard**

Document `--allow drop-unmanaged`: what triggers the refusal, why (a migration that cannot replay),
that it fails open when there is no committed snapshot, and that the escape hatch exists for a drop
you genuinely intend.

- [ ] **Step 4: Update the CLI help**

Add the two subverbs to `verify`'s help and to the one-line note at `verify.ts:127-130` that
advertises the explicit subverbs. Add `drop-unmanaged` to `migrate --help`'s `--allow` token list.
Update `migrate --help`'s `apply-pending` line (`migrate.ts:69-70`) so it no longer promises
fresh-database provisioning unconditionally.

- [ ] **Step 5: CHANGELOG**

Add an `## [Unreleased]` entry covering the adopter-visible changes, in this order:

1. **The new refusal** — a `meta migrate` that proposes dropping an object the committed snapshot
   never contained now exits 2 and requires `--allow drop-unmanaged`. This leads because it is the
   one change that can fail an existing project's `meta migrate`.
2. Emitted **forward** drops now carry `IF EXISTS` (`drop-table`, `drop-view`, `drop-index` incl. the
   constraint-backed arm, `drop-fk`, `drop-check`); downs are unchanged, and D1 inherits the sqlite
   change. Note the deliberate exclusions.
3. A chain creating a table **or view** in a non-default schema now emits `CREATE SCHEMA IF NOT EXISTS`.
4. Two new verify subverbs, `--replay` and `--replay-snapshot`, with `@electric-sql/pglite` as a new
   **optional peer** of `@metaobjectsdev/migrate-ts` (only needed to replay a postgres chain).

- [ ] **Step 6: Leak scan and commit**

The committed hook is the mechanism — do not invent a pattern list. Confirm it is wired, then let it
run on commit:

```bash
git config core.hooksPath          # must print .githooks
git config hooks.denyListPath      # must print a path that exists
grep -rnE '/home/[a-z]' docs/features/migrations-and-drift.md CHANGELOG.md && echo "ABSOLUTE HOME PATH" || echo "no home paths"
```

If the hook blocks the commit, **genericize** — never `--no-verify`.

```bash
git add docs/features/migrations-and-drift.md CHANGELOG.md \
        server/typescript/packages/cli/src/commands/migrate.ts \
        server/typescript/packages/cli/src/commands/verify.ts
git commit -m "docs: replay tiers, the drop-unmanaged refusal, and the provisioning promise"
```

---

## Self-Review

**Spec coverage.** §3.1 forward drops → Task 1, with every site tabulated and every deliberate
exclusion pinned by a test that must stay green. §3.2 both tiers, engine, refusals,
zero-migrations, exit codes → Tasks 3, 5, 6. §3.2's `excludeFromSnapshot` threading → Task 4.
§3.3 `CREATE SCHEMA` → Task 2, extended to `create-view` because the spec says "the first object".
§3.4 provenance guard → Task 7. §3.5 docs → Task 8. §4 remediation → Task 5 Step 5.6's message text
and Task 8. §5 testing → each task's own steps; §5's "must run through `applyPending`, not `emit()`"
is Task 5 Step 1, which now runs through **both** — `emit()` → `writeMigration()` → `applyPending()` —
so it is RED before Task 1 rather than green regardless.

**What was verified in code before this revision, not assumed.** The `drop-check` "unreachable"
comment is false (`diff/index.ts:579`, `:592`). `sqlType` is `{ kind: "integer"; bits: 32|64 }`, and
`GovernedScope` names are `<schema>.<name>`. `excludeFromSnapshot` returns a `ScopedExpectedSchema`,
so the fix takes `.snapshot`. `discoverMigrations` is module-private, so zero-migrations is detected
from `ApplyPendingResult.pending`. `migrate-ts` has two dependencies and no driver, so PGlite (22 MB)
is an optional peer and `build:binary` needs an `--external`. The PGlite→kysely pool shim in Task 3
was **executed** against 0.3.16 and 0.5.5 — DDL, schemas, CHECK, transactions, rollback, advisory
locks, and `table "theirs" does not exist`. `LibsqlDialect({ url: ":memory:" })` works and two
instances are isolated. `pg-constraint-backed-index-285.test.ts` needs **two** edits, not one: `:143`
goes red, `:142` goes vacuously green.

**Two things deliberately left to the implementer, both flagged inline rather than guessed:** the
exact `writeMigration` call shape (Task 5 Step 1), and the live-path `migrate` test harness for the
guard (Task 7 Step 1, which also records that `migrate-scope.test.ts` is the WRONG model because it
drives the offline path).

**Type consistency.** `openReplayEngine(dialect) → ReplayEngine { db, dispose }` is defined in Task 3
and used verbatim in Tasks 4, 5, 6. `VerifyReplayArgs.governed?: GovernedScope` is defined in Task 4
and consumed in Task 6. `replay` / `replaySnapshot` are added in Tasks 5 and 6, both feed
`anyExplicit`, and the `Math.max` condition covering both is written **once**, in Task 5.
`AllowOptions.dropUnmanaged` is added in Task 7 alongside all three token structures the pin test
compares.
