# Migration Chain Replayability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a committed migration chain provably replayable from an empty database, and stop `meta migrate` writing statements that cannot replay.

**Architecture:** Three independent layers. The emitter stops writing landmines (`IF EXISTS` on forward drops; `CREATE SCHEMA IF NOT EXISTS` ahead of a non-default schema). A new `meta verify --replay` gate replays the committed chain into an **in-process** database (PGlite for postgres, `:memory:` libsql for sqlite) and asserts it applies; `--replay-snapshot` additionally asserts it reproduces the committed snapshot via the already-built-but-unwired `verifyReplay`. An emit-time provenance guard refuses to drop an object the committed snapshot never contained, so the bad SQL is never authored.

**Tech Stack:** TypeScript, Bun test runner, Kysely, `@electric-sql/pglite` (new), `@libsql/client` (already present via the sqlite path).

**Spec:** [`docs/superpowers/specs/2026-08-19-migrate-chain-replayability-design.md`](../specs/2026-08-19-migrate-chain-replayability-design.md)

## Global Constraints

- **Scope is TypeScript only.** Schema migration is TS-owned ([ADR-0015](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md)). No Java/Kotlin/C#/Python work, no conformance-corpus fan-out.
- **`IF EXISTS` goes on FORWARD drops only.** Down statements stay bare. `rollbackTo` runs `down.sql` and the ledger delete in ONE transaction (`apply/apply.ts:185-189`), so a down that no-ops would still record the rollback as done.
- **Never `instanceof` a metadata node from another package** — use the exported guards (`isMetaObject`, `isWritableSource`, …). Two physical copies of `@metaobjectsdev/metadata` in one process make `instanceof` silently false.
- **No `any`.** Use `unknown` and narrow. A bare `let x;` is an implicit evolving `any`.
- **Never call `own*()` accessors** (ADR-0039) except where surrounding code documents a sanctioned reason.
- **Errors are `ParseError` with a structured `code`** and `codeSource(...)` — never a message prefix.
- **Backward compatibility is absolute:** a project that declares no new flag must emit byte-identical migrations except for the `IF EXISTS` tokens this plan adds, and `SNAPSHOT_FORMAT_VERSION` must remain 3.
- **Run tests scoped:** `cd server/typescript && bun test packages/<pkg>`. NEVER a bare `bun test` at the repository root — it walks java/python/csharp and takes many minutes.
- **`bun test` does NOT typecheck.** Run `bun run --filter '*' typecheck` from the repository root before every commit and confirm all 18 packages exit 0.
- **Public repository.** No private project names, no absolute home paths, in code, tests, fixtures, or commit messages.
- **Stage explicit paths only.** Never `git add -A` — other worktrees share this repository.

---

## File Structure

**Modified — `server/typescript/packages/migrate-ts/src/`**
- `emit/postgres.ts` — `IF EXISTS` on forward drops; `CREATE SCHEMA IF NOT EXISTS` emission
- `emit/sqlite.ts` — `IF EXISTS` on forward drops
- `verify/replay.ts` — thread scope inputs into the snapshot comparison
- `index.ts` — export the new replay-engine surface

**New — `server/typescript/packages/migrate-ts/src/`**
- `verify/replay-engine.ts` — provision an in-process database (PGlite / `:memory:` libsql), hand back a Kysely instance and a disposer. One responsibility: engine lifecycle. No replay logic, no comparison.

**Modified — `server/typescript/packages/cli/src/`**
- `lib/args.ts` — `--replay` / `--replay-snapshot` verify flags; `drop-unmanaged` allow token
- `commands/verify.ts` — the replay gate
- `commands/migrate.ts` — the emit-time provenance guard

**New — tests**
- `packages/migrate-ts/test/emit-drop-if-exists.test.ts`
- `packages/migrate-ts/test/emit-postgres-create-schema.test.ts`
- `packages/migrate-ts/test/unit/replay-engine.test.ts`
- `packages/migrate-ts/test/integrity/replay-scoped.test.ts`
- `packages/migrate-ts/test/integrity/replay-from-empty.test.ts` — the #313 regression
- `packages/cli/test/verify-replay.test.ts`
- `packages/cli/test/migrate-drop-unmanaged.test.ts`

---

## Task 1: `IF EXISTS` on forward drops, both dialects

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/emit/postgres.ts` (`renderUp`, `renderDropView`)
- Modify: `server/typescript/packages/migrate-ts/src/emit/sqlite.ts` (`renderUpNative`)
- Test: `server/typescript/packages/migrate-ts/test/emit-drop-if-exists.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: no new exports. Behaviour change only.

**Context the implementer needs:** `renderUp`/`renderUpNative` are the FORWARD renderers.
`renderDown`/`renderDownNative` are the down renderers and are **out of scope** — see the Global
Constraint. Two forward drops stay bare **deliberately**: `sqlite.ts:197` (inside the
recreate-and-copy rebuild) and `emit/d1-cascade.ts:126`, because each drops a table the same recipe
just `INSERT…SELECT`ed from, where `IF EXISTS` would convert a caught corruption into a silent one.

`emit/d1.ts:21` renders through `renderSqlite`, so the sqlite edits also change D1's committed
migrations. That is accepted and expected.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/migrate-ts/test/emit-drop-if-exists.test.ts
import { describe, test, expect } from "bun:test";
import { renderPostgres } from "../src/emit/postgres.js";
import { renderSqlite } from "../src/emit/sqlite.js";
import type { Change } from "../src/types.js";

const TABLE = { name: "gone", columns: [], indexes: [], foreignKeys: [], checks: [], primaryKey: [] };

describe("forward drops tolerate an absent object", () => {
  test("postgres drop-table", () => {
    const { up } = renderPostgres([{ kind: "drop-table", table: "gone" } as Change]);
    expect(up).toContain('DROP TABLE IF EXISTS "gone";');
  });

  test("postgres drop-view", () => {
    const { up } = renderPostgres([{ kind: "drop-view", view: "v_gone" } as Change]);
    expect(up).toContain("DROP VIEW IF EXISTS");
  });

  test("postgres drop-index, plain", () => {
    const { up } = renderPostgres([{ kind: "drop-index", table: "t", index: "idx_gone" } as Change]);
    expect(up).toContain('DROP INDEX IF EXISTS "idx_gone";');
  });

  test("postgres drop-index, constraint-backed", () => {
    const { up } = renderPostgres([
      { kind: "drop-index", table: "t", index: "uq_gone", restore: { constraint: "unique" } } as Change,
    ]);
    expect(up).toContain('DROP CONSTRAINT IF EXISTS "uq_gone";');
  });

  test("postgres drop-fk", () => {
    const { up } = renderPostgres([{ kind: "drop-fk", table: "t", fk: "fk_gone" } as Change]);
    expect(up).toContain('DROP CONSTRAINT IF EXISTS "fk_gone";');
  });

  test("sqlite drop-table", () => {
    const { up } = renderSqlite([{ kind: "drop-table", table: "gone" } as Change], undefined, undefined);
    expect(up).toContain('DROP TABLE IF EXISTS "gone";');
  });

  test("sqlite drop-index", () => {
    const { up } = renderSqlite([{ kind: "drop-index", table: "t", index: "idx_gone" } as Change], undefined, undefined);
    expect(up).toContain('DROP INDEX IF EXISTS "idx_gone";');
  });
});

describe("down statements stay bare — a rollback must fail loudly", () => {
  test("postgres create-table down", () => {
    const { down } = renderPostgres([{ kind: "create-table", table: TABLE } as Change]);
    expect(down).toContain('DROP TABLE "gone";');
    expect(down).not.toContain("DROP TABLE IF EXISTS");
  });

  test("sqlite create-table down", () => {
    const { down } = renderSqlite([{ kind: "create-table", table: TABLE } as Change], undefined, undefined);
    expect(down).toContain('DROP TABLE "gone";');
    expect(down).not.toContain("DROP TABLE IF EXISTS");
  });
});
```

**If a `Change` literal above does not typecheck**, widen it to match the real discriminated union
in `src/types.ts` rather than casting away the error — the `as Change` casts are there to keep the
fixtures short, not to hide a shape mismatch. If `renderSqlite`'s signature differs from
`(changes, expectedSchema, actualMeta)`, match the real one.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit-drop-if-exists.test.ts`
Expected: the seven "forward drops" tests FAIL (no `IF EXISTS` in the output). The two "down
statements stay bare" tests PASS already — they pin behaviour this task must not change.

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

`drop-check` is currently **unreachable** — the comment above that arm records that CHECKs are
create-time-only and the diff never produces this change. Guard it anyway for consistency, and do
not add a test asserting it fires, because it cannot.

In `renderDropView` (around `:375` and `:388`), change both the plain and the CASCADE form:

```ts
  if (dependents.length === 0) return `DROP VIEW IF EXISTS ${qualified};`;
```

```ts
    `DROP VIEW IF EXISTS ${qualified} CASCADE;`,
```

**Do NOT touch `renderRestoreView` (around `:431`).** It is reached only from `postgres.ts:178`
and `:179`, both inside `renderDown`.

- [ ] **Step 4: Implement — sqlite forward drops**

In `emit/sqlite.ts`, inside `renderUpNative`:

```ts
    case "drop-table":     return `DROP TABLE IF EXISTS ${quote(c.table)};`;
```

```ts
    case "drop-index":     return `DROP INDEX IF EXISTS ${quote(c.index)};`;
```

Leave `sqlite.ts:197` (the rebuild `DROP TABLE`) and `renderDownNative` untouched.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit-drop-if-exists.test.ts`
Expected: PASS, all nine.

- [ ] **Step 6: Run the affected suites**

Run: `cd server/typescript && bun test packages/migrate-ts && bun test packages/cli`
Expected: PASS. Existing assertions on exact `DROP TABLE "x";` strings will need updating to the
`IF EXISTS` form — that is expected churn, not a regression. **Read each one before changing it**:
if an assertion is on a DOWN statement, the correct fix is to leave the assertion alone and check
you did not edit a down renderer.

- [ ] **Step 7: Typecheck**

Run: `bun run --filter '*' typecheck` (from the repository root)
Expected: all 18 packages exit 0.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/emit/postgres.ts \
        server/typescript/packages/migrate-ts/src/emit/sqlite.ts \
        server/typescript/packages/migrate-ts/test/emit-drop-if-exists.test.ts
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
cannot apply to a virgin database — the schema does not exist. SQLite has no schema namespacing
(`emit-sqlite-schema-rejected.test.ts` pins that a schema is rejected there), so this is
Postgres-only and is NOT a dialect split.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/migrate-ts/test/emit-postgres-create-schema.test.ts
import { describe, test, expect } from "bun:test";
import { renderPostgres } from "../src/emit/postgres.js";
import type { Change } from "../src/types.js";

const t = (name: string, schema?: string) => ({
  name, schema, columns: [], indexes: [], foreignKeys: [], checks: [], primaryKey: [],
});

describe("a chain that creates a non-default schema's table creates the schema first", () => {
  test("emits CREATE SCHEMA IF NOT EXISTS before the table", () => {
    const { up } = renderPostgres([{ kind: "create-table", table: t("x", "reporting") } as Change]);
    expect(up).toContain('CREATE SCHEMA IF NOT EXISTS "reporting";');
    expect(up.indexOf('CREATE SCHEMA IF NOT EXISTS "reporting";'))
      .toBeLessThan(up.indexOf("CREATE TABLE"));
  });

  test("emits it once for two tables in the same schema", () => {
    const { up } = renderPostgres([
      { kind: "create-table", table: t("x", "reporting") } as Change,
      { kind: "create-table", table: t("y", "reporting") } as Change,
    ]);
    expect(up.match(/CREATE SCHEMA IF NOT EXISTS "reporting";/g)).toHaveLength(1);
  });

  test("emits nothing for the default schema", () => {
    const { up } = renderPostgres([{ kind: "create-table", table: t("x") } as Change]);
    expect(up).not.toContain("CREATE SCHEMA");
  });

  test("the down does NOT drop the schema", () => {
    const { down } = renderPostgres([{ kind: "create-table", table: t("x", "reporting") } as Change]);
    expect(down).not.toContain("DROP SCHEMA");
  });
});
```

The last case is a real decision, not filler: dropping a schema on rollback would destroy objects
this tool does not own and cannot restore.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit-postgres-create-schema.test.ts`
Expected: FAIL — the first two cases find no `CREATE SCHEMA`. The last two PASS already.

- [ ] **Step 3: Implement**

In `renderPostgres`, after `const sorted = …` and before the render loop, collect the distinct
non-default schemas the forward pass will create objects in, and prepend one statement each:

```ts
  // A chain must be appliable to a VIRGIN database (#313). CREATE TABLE "s"."x"
  // fails there unless the schema exists, and no migration has ever created one.
  // IF NOT EXISTS because a later migration in the same chain, or an operator,
  // may have created it already. Deliberately NOT dropped in `down`: the schema
  // may hold objects this tool does not own and cannot restore.
  const createdSchemas = new Set<string>();
  for (const c of sorted) {
    if (c.kind !== "create-table") continue;
    const s = c.table.schema;
    if (s !== undefined && s !== DEFAULT_DB_SCHEMA_POSTGRES) createdSchemas.add(s);
  }
  const schemaStmts = [...createdSchemas].sort().map((s) => `CREATE SCHEMA IF NOT EXISTS ${quote(s)};`);
```

then emit `schemaStmts` ahead of `upStmts` in the returned `up`:

```ts
    up: [...schemaStmts, ...upStmts].join("\n\n"),
```

Import `DEFAULT_DB_SCHEMA_POSTGRES` from wherever the file already resolves the default schema
name — `diff/index.ts:152` uses it, so it is exported from a shared module. If `renderPostgres`
already has a local notion of the default schema, use that instead of adding a second one.

Sorting `createdSchemas` keeps output deterministic, which the snapshot and golden tests rely on.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server/typescript && bun test packages/migrate-ts/test/emit-postgres-create-schema.test.ts`
Expected: PASS, all four.

- [ ] **Step 5: Run the affected suites**

Run: `cd server/typescript && bun test packages/migrate-ts`
Expected: PASS. `emit-postgres-schema-namespacing.test.ts` is the file most likely to need updating;
read its assertions before changing them.

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
- Modify: `server/typescript/packages/migrate-ts/package.json` (add `@electric-sql/pglite`)
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
  Tasks 5 and 6 call `openReplayEngine` and must `await engine.dispose()` in a `finally`.

**Context:** This is why the design needs no scratch database on the user's server: both engines run
in-process. PGlite is real Postgres compiled to WASM. `dispose()` must be safe to call twice, so a
caller can dispose in a `finally` after an early return.

- [ ] **Step 1: Add the dependency**

```bash
cd server/typescript/packages/migrate-ts && bun add @electric-sql/pglite
```

Then confirm it landed in `dependencies` (not `devDependencies`) in
`server/typescript/packages/migrate-ts/package.json` — the CLI imports this at runtime.

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
      // Schema namespacing + a CHECK — both are things sqlite cannot express,
      // so this proves the postgres engine is really Postgres.
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
// name derived from a real one. None of that is worth it when the engines run
// in-process: PGlite is real Postgres compiled to WASM, and libsql runs sqlite in
// memory. Nothing to provision, nothing to clean up, nothing to drop by mistake.
import { Kysely, PostgresDialect, SqliteDialect } from "kysely";

export interface ReplayEngine {
  /** An empty database. The caller owns applying migrations into it. */
  db: Kysely<Record<string, unknown>>;
  /** Release the engine. Safe to call more than once. */
  dispose: () => Promise<void>;
}

export async function openReplayEngine(
  dialect: "postgres" | "sqlite",
): Promise<ReplayEngine> {
  if (dialect === "postgres") return openPglite();
  return openMemorySqlite();
}
```

Then implement the two openers against whatever Kysely dialect adapters this repo already uses.
**Read `cli/src/lib/kysely.ts` first** — it is the existing place a `Kysely` is constructed for both
dialects, and this file should mirror its adapter choices rather than inventing new ones. For
sqlite, `:memory:` through the same client that file already uses. For postgres, PGlite exposes a
`pg`-compatible interface; wire it into `PostgresDialect` the same way.

Make `dispose` idempotent with a `disposed` flag; call `db.destroy()` and then the engine's own
`close()`/`end()` if it has one.

- [ ] **Step 5: Export it**

In `server/typescript/packages/migrate-ts/src/index.ts`, beside the existing
`export { verifyReplay } from "./verify/replay.js";`:

```ts
export { openReplayEngine, type ReplayEngine } from "./verify/replay-engine.js";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server/typescript && bun test packages/migrate-ts/test/unit/replay-engine.test.ts`
Expected: PASS, all four.

**If PGlite cannot execute the postgres case**, STOP and report it. The spec's engine tiering rests
on PGlite being real Postgres; if it is not sufficient, that is a design question, not something to
work around by weakening the test.

- [ ] **Step 7: Typecheck and commit**

Run: `bun run --filter '*' typecheck` — all 18 exit 0.

```bash
git add server/typescript/packages/migrate-ts/src/verify/replay-engine.ts \
        server/typescript/packages/migrate-ts/src/index.ts \
        server/typescript/packages/migrate-ts/package.json \
        server/typescript/packages/migrate-ts/test/unit/replay-engine.test.ts \
        server/typescript/bun.lock
git commit -m "feat(migrate): an in-process replay engine, so the gate provisions nothing"
```

---

## Task 4: Thread scope inputs into `verifyReplay`

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/verify/replay.ts`
- Test: `server/typescript/packages/migrate-ts/test/integrity/replay-scoped.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `VerifyReplayArgs` gains one optional field:
  ```ts
  /** Out-of-scope / @unmanaged names to exclude from BOTH sides, as `scopedDiffInputs` produces. */
  governed?: GovernedScope;
  ```
  Task 6 passes it.

**Context:** `verifyReplay` (`verify/replay.ts:31`) compares a replayed database against the
committed snapshot. A project declaring `migrate.scope` writes the *other* owner's tables into that
snapshot on purpose (`carryForwardOutOfScope`, `scope.ts:93`), and the chain never creates them — so
today the comparison reports them as missing. `excludeFromSnapshot` (`scope.ts:130`) exists for
exactly this and is already used by the committed-snapshot gate at `verify.ts:659`; this task
threads it here too.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/migrate-ts/test/integrity/replay-scoped.test.ts
import { describe, test, expect } from "bun:test";
import { verifyReplay } from "../../src/verify/replay.js";
import { openReplayEngine } from "../../src/verify/replay-engine.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SchemaSnapshot } from "../../src/types.js";

function chainWith(upSql: string): string {
  const dir = mkdtempSync(join(tmpdir(), "replay-scoped-"));
  mkdirSync(join(dir, "20260101000000-init"), { recursive: true });
  writeFileSync(join(dir, "20260101000000-init", "up.sql"), upSql, "utf8");
  writeFileSync(join(dir, "20260101000000-init", "down.sql"), "DROP TABLE mine;", "utf8");
  return dir;
}

const SNAPSHOT: SchemaSnapshot = {
  tables: [
    { name: "mine", columns: [{ name: "id", sqlType: { kind: "int", bits: 64 } as never, nullable: false }], indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"] },
    { name: "theirs", columns: [{ name: "id", sqlType: { kind: "int", bits: 64 } as never, nullable: false }], indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"] },
  ],
  views: [],
};

describe("verifyReplay honours scope", () => {
  test("an out-of-scope table in the snapshot is not reported as missing", async () => {
    const dir = chainWith("CREATE TABLE mine (id integer primary key);");
    const engine = await openReplayEngine("sqlite");
    try {
      const result = await verifyReplay({
        db: engine.db,
        dialect: "sqlite",
        migrationsDir: dir,
        snapshot: SNAPSHOT,
        governed: { outOfScope: ["theirs"] } as never,
      });
      expect(result.ok).toBe(true);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("without `governed`, the same case reports drift — the control", async () => {
    const dir = chainWith("CREATE TABLE mine (id integer primary key);");
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
`governed` and not from the fixture being trivially green. **Adjust the `SchemaSnapshot` literal and
the `GovernedScope` shape to the real types** — read `src/types.ts` and `src/scope.ts` — rather than
leaving the `as never` casts in the committed test.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/migrate-ts/test/integrity/replay-scoped.test.ts`
Expected: the first test FAILS (`governed` is not accepted / not honoured); the control PASSES.

- [ ] **Step 3: Implement**

In `verify/replay.ts`, add the optional field to `VerifyReplayArgs` and apply
`excludeFromSnapshot` to the snapshot before comparing:

```ts
  const expected = args.governed !== undefined
    ? excludeFromSnapshot(args.snapshot, args.governed)
    : args.snapshot;
  const classification = await driftAgainstSnapshot(expected, actual, args.dialect);
```

Import `excludeFromSnapshot` and the `GovernedScope` type from `../scope.js`. Do not change the
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
git commit -m "fix(migrate): verifyReplay honours migrate.scope on both sides"
```

---

## Task 5: `meta verify --replay` — the chain applies from empty

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts` (`VerifyFlags`, `parseVerifyArgs`)
- Modify: `server/typescript/packages/cli/src/commands/verify.ts`
- Test: `server/typescript/packages/migrate-ts/test/integrity/replay-from-empty.test.ts` (create)
- Test: `server/typescript/packages/cli/test/verify-replay.test.ts` (create)

**Interfaces:**
- Consumes: `openReplayEngine` (Task 3).
- Produces: the `--replay` flag on `VerifyFlags`; Task 6 adds `--replay-snapshot` beside it.

**Context:** `verify` composes gates and returns `Math.max(...)` of their exit codes
(`verify.ts:239`). `anyExplicit` (`args.ts:290`) decides whether the bare-`verify` default fires —
`--replay` must be included in it, or passing `--replay` alone would also silently run the template
gate. Refuse `--migration-format flyway` and `--dialect d1`, mirroring `apply-pending`
(`migrate.ts:419-426`, `:449-457`).

- [ ] **Step 1: Write the failing regression test — the #313 case**

```ts
// server/typescript/packages/migrate-ts/test/integrity/replay-from-empty.test.ts
import { describe, test, expect } from "bun:test";
import { applyPending } from "../../src/apply/apply.js";
import { openReplayEngine } from "../../src/verify/replay-engine.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("a committed chain must apply to an empty database (#313)", () => {
  test("a bare DROP TABLE for an object the chain never creates fails the replay", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-empty-"));
    mkdirSync(join(dir, "20260101000000-init"), { recursive: true });
    // Exactly the reported shape: another tool owned `theirs`, so the diff proposed
    // dropping it, and no migration in the chain ever created it.
    writeFileSync(join(dir, "20260101000000-init", "up.sql"),
      'CREATE TABLE "mine" (id integer primary key);\nDROP TABLE "theirs";', "utf8");
    writeFileSync(join(dir, "20260101000000-init", "down.sql"), 'DROP TABLE "mine";', "utf8");

    const engine = await openReplayEngine("sqlite");
    try {
      await expect(applyPending(engine.db, dir, { dryRun: false, dialect: "sqlite" }))
        .rejects.toThrow(/theirs/);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the same chain with IF EXISTS applies cleanly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "replay-empty-ok-"));
    mkdirSync(join(dir, "20260101000000-init"), { recursive: true });
    writeFileSync(join(dir, "20260101000000-init", "up.sql"),
      'CREATE TABLE "mine" (id integer primary key);\nDROP TABLE IF EXISTS "theirs";', "utf8");
    writeFileSync(join(dir, "20260101000000-init", "down.sql"), 'DROP TABLE "mine";', "utf8");

    const engine = await openReplayEngine("sqlite");
    try {
      const result = await applyPending(engine.db, dir, { dryRun: false, dialect: "sqlite" });
      expect(result.applied).toEqual(["20260101000000-init"]);
    } finally {
      await engine.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

This runs through `applyPending`, **not** through `emit()`. Every prior defect in this area
(#226/#241, #243, #255, #285, and 0.21.4's `BEGIN TRANSACTION` finding) shared one shape — SQL proven
statement-by-statement and never proven through the tool that applies it. `applyPending` rewrites
statements via `prepareForRunnerTransaction` before executing them, so an emit-level assertion
cannot see this class of bug.

Adjust `result.applied` to whatever `ApplyPendingResult` actually names its applied list.

- [ ] **Step 2: Run it to verify the shape is real**

Run: `cd server/typescript && bun test packages/migrate-ts/test/integrity/replay-from-empty.test.ts`
Expected: BOTH PASS immediately — this test characterises `applyPending`, which already behaves this
way. That is the point: it pins the mechanism the gate depends on. If the first case does NOT throw,
stop and report, because the gate cannot work.

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

- [ ] **Step 4: Write the CLI test**

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
  const replayExit = flags.replay ? await runReplayVerify() : 0;
  …
  return Math.max(templateExit, schemaExit, codegenExit, requirementExit, replayExit);
```

`runReplayVerify` must:

1. Refuse `--migration-format flyway` and `--dialect d1` with `log.error` and **exit 2**, matching
   `apply-pending`'s wording at `migrate.ts:419-426` and `:449-457`.
2. Resolve the migrations directory the same way `migrate apply-pending` does — do NOT re-derive it;
   read how `migrate.ts` computes it and use the same helper.
3. Report and return 0 when the directory holds no migrations, with the exact text
   `meta verify --replay: no committed migrations — nothing to replay`. `discoverMigrations`
   returns `[]` for a missing directory (`apply.ts:316-322`), so silence here would be a vacuous pass.
4. `openReplayEngine(dialect)`, `applyPending(engine.db, dir, { dryRun: false, dialect })`, and
   `await engine.dispose()` in a `finally`.
5. On an apply failure, print the failing statement and the remediation — an already-applied chain
   cannot be repaired by hand-editing (`apply/apply.ts:88-99` makes migrations checksum-immutable),
   so the message must name the compensating-migration path:
   `meta verify --replay: the committed chain does not apply to an empty database. Applied migrations are immutable, so fix this with a NEW migration that creates the missing object — not by editing a committed up.sql.`
   Return **1** (drift), not 2.
6. Return **2** only when the engine itself cannot start.

- [ ] **Step 6: Run the tests**

Run: `cd server/typescript && bun test packages/cli/test/verify-replay.test.ts && bun test packages/migrate-ts/test/integrity`
Expected: PASS.

- [ ] **Step 7: Run the suites, typecheck, commit**

Run: `cd server/typescript && bun test packages/cli && bun test packages/migrate-ts` — PASS.
Run: `bun run --filter '*' typecheck` — all 18 exit 0.

```bash
git add server/typescript/packages/cli/src/lib/args.ts \
        server/typescript/packages/cli/src/commands/verify.ts \
        server/typescript/packages/cli/test/verify-replay.test.ts \
        server/typescript/packages/migrate-ts/test/integrity/replay-from-empty.test.ts
git commit -m "feat(cli): meta verify --replay asserts the committed chain applies from empty"
```

---

## Task 6: `meta verify --replay-snapshot` — the chain reproduces the snapshot

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts`
- Modify: `server/typescript/packages/cli/src/commands/verify.ts`
- Test: `server/typescript/packages/cli/test/verify-replay.test.ts` (extend)

**Interfaces:**
- Consumes: `openReplayEngine` (Task 3), `verifyReplay` with `governed` (Task 4), the `runReplayVerify` structure (Task 5).
- Produces: nothing later tasks depend on.

**Context:** This is a **separate subverb, not `--strict`**. `verify` already owns a `--lax` flag on
a different axis (ADR-0023 attribute strictness, `args.ts:244`), and `--strict` beside it would read
as that flag's opposite rather than as a replay depth.

**This tier cannot pass for baseline-adopted projects and does not try to detect them.** The only
candidate signal, `BASELINE_NAME`/`recordBaseline` (`ledger.ts:205-227`), has no production caller
and would live in the target database's ledger while this gate runs against a fresh in-process
database with no ledger at all. The limitation is documented in Task 8, and the failure message
names it.

- [ ] **Step 1: Write the failing test**

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

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript && bun test packages/cli/test/verify-replay.test.ts`
Expected: FAIL — `--replay-snapshot` is not a known option (`strict: true` in `parseArgs`).

- [ ] **Step 3: Implement the flag**

Same three places as Task 5: the `VerifyFlags` field (`replaySnapshot: boolean`), the `parseArgs`
option (`"replay-snapshot": { type: "boolean", default: false }`), the parsed object
(`replaySnapshot: !!values["replay-snapshot"]`), and `anyExplicit`.

- [ ] **Step 4: Implement the tier**

Extend `runReplayVerify` so that when `flags.replaySnapshot` is set it additionally:

1. Loads the committed snapshot the same way the existing committed-snapshot gate does — read
   `verify.ts` around `:628-660` and reuse that path, do not re-implement snapshot loading.
2. Calls `verifyReplay({ db: engine.db, dialect, migrationsDir, snapshot, governed })`, where
   `governed` is what `scopedDiffInputs`/`excludeFromSnapshot` already produce at `verify.ts:659`.
3. On `ok === false`, reports the drift and returns **1**, with a message that names baseline
   adoption as the first thing to rule out:
   `meta verify --replay-snapshot: the replayed chain does not reproduce the committed snapshot. If this project was adopted with 'migrate baseline --from-db', its chain does not build the schema and this tier does not apply — use --replay instead.`

Both tiers share one engine and one `applyPending` call: `--replay-snapshot` implies `--replay`'s
work, so do not open two engines or replay twice.

- [ ] **Step 5: Run the tests**

Run: `cd server/typescript && bun test packages/cli/test/verify-replay.test.ts`
Expected: PASS, all six.

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
- Modify: `server/typescript/packages/cli/src/lib/args.ts` (`ALLOW_TOKENS`)
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

The guard does not false-fire on the brownfield classes, and the reason is that both of them *add*
to the snapshot: a `baseline --from-db` snapshot contains the foreign table, and a scoped project
carries out-of-scope entries forward into it. The guard fires precisely when nothing ever claimed
the object.

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/cli/test/migrate-drop-unmanaged.test.ts
import { describe, test, expect } from "bun:test";
import { ALLOW_TOKENS } from "../src/lib/args.js";

describe("drop-unmanaged allow token", () => {
  test("is a recognised allow token", () => {
    expect(ALLOW_TOKENS).toContain("drop-unmanaged");
  });
});
```

Then add the behavioural test. It must drive the real `migrate` path with a snapshot that does NOT
contain the table being dropped, and assert the run refuses. **Model it on the existing
`packages/cli/test/migrate-scope.test.ts`**, which already builds a config + snapshot + change set
for this command — read it first and follow its harness rather than inventing one.

The two cases:
1. A drop proposed for a table absent from the committed snapshot ⇒ refused, exit 2, message names
   the object and `--allow drop-unmanaged`.
2. The same run with `--allow drop-unmanaged` ⇒ proceeds.

And one non-false-fire case: a drop for a table that IS in the snapshot ⇒ proceeds without the flag.

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/cli/test/migrate-drop-unmanaged.test.ts`
Expected: FAIL — the token is not in `ALLOW_TOKENS`.

- [ ] **Step 3: Add the token**

In `cli/src/lib/args.ts`, add to `ALLOW_TOKENS` with a comment in the style of its neighbours:

```ts
  // drop-unmanaged permits dropping an object the COMMITTED SNAPSHOT never
  // contained — i.e. one this toolchain never managed. Without it such a drop is
  // refused at generation time, because it produces a migration that cannot replay
  // against a database where that object never existed (#313).
  "drop-unmanaged",
```

- [ ] **Step 4: Implement the guard**

In `migrate.ts`, after the diff produces its change list and BEFORE the migration is written,
collect every `drop-table` / `drop-view` whose name is absent from the committed snapshot, and if
that set is non-empty and `allow.dropUnmanaged` is not set, `log.error` naming each object and
return 2.

Read how `allow` tokens are converted to the options object (`tokensToAllowOptions`) and follow it.
Use the same qualified-name helper the scope machinery uses (`qualifiedDbName` in
`migrate-ts/src/qualified-name.ts`) so the guard and the snapshot agree on a name's spelling — three
independent sets already have to agree there, and a fourth spelling would silently un-guard objects.

- [ ] **Step 5: Run the tests**

Run: `cd server/typescript && bun test packages/cli/test/migrate-drop-unmanaged.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the suites, typecheck, commit**

Run: `cd server/typescript && bun test packages/cli && bun test packages/migrate-ts` — PASS.
Run: `bun run --filter '*' typecheck` — all 18 exit 0.

```bash
git add server/typescript/packages/cli/src/lib/args.ts \
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
they run in-process (PGlite / `:memory:` libsql) and provision nothing, that flyway and d1 are
refused, and — stated plainly — that `--replay-snapshot` does not apply to a project adopted with
`migrate baseline --from-db`, because such a chain does not build the schema.

- [ ] **Step 3: Document the guard**

Document `--allow drop-unmanaged`: what triggers the refusal, why (a migration that cannot replay),
and that the escape hatch exists for a drop you genuinely intend.

- [ ] **Step 4: Update the CLI help**

Add the two subverbs to `verify`'s help and to the one-line note at `verify.ts:127-130` that
advertises the explicit subverbs. Update `migrate --help`'s `apply-pending` line so it no longer
promises fresh-database provisioning unconditionally.

- [ ] **Step 5: CHANGELOG**

Add an `## [Unreleased]` entry covering the adopter-visible changes: emitted forward drops now carry
`IF EXISTS`; a chain creating a table in a non-default schema now emits `CREATE SCHEMA IF NOT
EXISTS`; two new verify subverbs; and a new refusal that requires `--allow drop-unmanaged`. The last
is the one that can fail an existing project's `meta migrate`, so it leads.

- [ ] **Step 6: Leak scan and commit**

```bash
grep -rniE "/home/|party" docs/features/migrations-and-drift.md CHANGELOG.md && echo LEAK || echo clean
```

```bash
git add docs/features/migrations-and-drift.md CHANGELOG.md \
        server/typescript/packages/cli/src/commands/migrate.ts \
        server/typescript/packages/cli/src/commands/verify.ts
git commit -m "docs: replay tiers, the drop-unmanaged refusal, and the provisioning promise"
```

---

## Self-Review

**Spec coverage.** §3.1 forward drops → Task 1. §3.1's deliberate exclusions (`postgres.ts:431`,
the rebuild drops, `sqlite.ts:275`) → Task 1 Steps 3–4 and its "down statements stay bare" tests.
§3.2 both tiers, engine, refusals, zero-migrations, exit codes → Tasks 3, 5, 6. §3.2's
`excludeFromSnapshot` threading → Task 4. §3.3 `CREATE SCHEMA` → Task 2. §3.4 provenance guard →
Task 7. §3.5 docs → Task 8. §4 remediation → Task 5 Step 5's message text and Task 8. §5 testing →
each task's own steps, with the `applyPending`-not-`emit()` requirement in Task 5 Step 1.

**Two things deliberately left to the implementer, both flagged inline rather than guessed:** the
exact Kysely adapter wiring for PGlite (Task 3 Step 4 says to mirror `cli/src/lib/kysely.ts`), and
the `migrate` test harness for the guard (Task 7 Step 1 says to follow `migrate-scope.test.ts`).
Inventing either from memory would put wrong code in the plan, which is worse than naming the file
to copy.

**Type consistency.** `openReplayEngine(dialect) → ReplayEngine { db, dispose }` is defined in Task
3 and used verbatim in Tasks 4, 5, 6. `VerifyReplayArgs.governed` is defined in Task 4 and consumed
in Task 6. `replay` / `replaySnapshot` are added in Tasks 5 and 6 and both feed `anyExplicit`.
`drop-unmanaged` is added to `ALLOW_TOKENS` in Task 7 and referenced nowhere earlier.

**Known ordering constraint:** Task 4's test imports `openReplayEngine`, so Task 3 must land first.
Tasks 1, 2 and 7 are independent of the rest and of each other.
