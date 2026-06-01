# Existing-table CHECK Evolution (Postgres) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve CHECK constraints on existing Postgres tables — generate `ALTER TABLE ADD/DROP CONSTRAINT` when a check is added, removed, or its expression changes — idempotently across the offline (snapshot) and `--from-db` (introspect) paths.

**Architecture:** Re-introduce a pass-2 `diffTableChecks` (removed in Plan 6's inline-only fix), now idempotent because `actual.checks` is populated — by the snapshot on the offline path, and by new Postgres `pg_constraint` introspection on the `--from-db` path. A `normalizeCheckExpr` comparator (mirroring `normalizeViewSql`) handles PG's parenthesized expression rewrite. `diffTableChecks` is Postgres-only (SQLite evolves checks via recreate). The `add-check`/`drop-check` emit arms already exist; `drop-check` gains a `restore` for a reversible down + `allow.dropCheck` gating.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Bun test runner, Kysely, `pg`/`pg-mem` (introspect tests), `@libsql/kysely-libsql`.

**Prerequisite:** Plan 6 (enum CHECK) + validator-derived checks + Plan 4 (drop-* `restore`) on origin/main.

**Scope:** Postgres existing-table check evolution. **Out of scope (spec §6/§10):** SQLite check-only evolution; multi-column / free-form checks; the `--from-db` CLI diff threading (the offline path is the default deliverable; `--from-db` benefits once Task 4 introspection lands + a one-line CLI thread, noted in Task 5).

**Working directory for all commands:** `server/typescript/packages/migrate-ts`.

---

### Task 1: `normalizeCheckExpr` + `checkExprEquals`

**Files:**
- Create: `src/check-expr-compare.ts`
- Test: `test/check-evolution/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/check-evolution/normalize.test.ts
import { describe, test, expect } from "bun:test";
import { normalizeCheckExpr, checkExprEquals } from "../../src/check-expr-compare.js";

describe("normalizeCheckExpr", () => {
  test("strips parens, collapses whitespace, lowercases", () => {
    expect(normalizeCheckExpr("(price >= 0) AND (price <= 100)")).toBe("price >= 0 and price <= 100");
    expect(normalizeCheckExpr("price >= 0 AND price <= 100")).toBe("price >= 0 and price <= 100");
  });
  test("PG-rewritten form equals the generated form", () => {
    expect(checkExprEquals("(col >= 0) AND (col <= 100)", "col >= 0 AND col <= 100")).toBe(true);
    expect(checkExprEquals("length(code) >= 3", "(length(code) >= 3)")).toBe(true);
    expect(checkExprEquals("status IN ('A', 'B')", "status in ('A', 'B')")).toBe(true);
  });
  test("genuinely different expressions are not equal", () => {
    expect(checkExprEquals("col >= 0", "col >= 5")).toBe(false);
  });
  test("undefined is never equal", () => {
    expect(checkExprEquals(undefined, "x")).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/check-evolution/normalize.test.ts` (module missing).

- [ ] **Step 3: Implement**

```ts
// src/check-expr-compare.ts
//
// CHECK-expression comparison. Postgres rewrites a stored CHECK body — adding
// parens around terms, normalizing whitespace/case — so the raw text we generate
// (`col >= 0 AND col <= 100`) and the introspected text (`(col >= 0) AND (col <= 100)`)
// differ textually but mean the same thing. This reduces both to ONE canonical
// form for comparison. Reliable here because every check expression we emit is
// machine-derived with a simple, known shape (comparison / IN / length / regex) —
// there is no arbitrary author SQL to mis-normalize.

/** Canonical form: drop all parens, collapse whitespace, trim, lower-case. */
export function normalizeCheckExpr(expr: string): string {
  return expr
    .replace(/[()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when two CHECK expressions are equivalent after normalization. */
export function checkExprEquals(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  return normalizeCheckExpr(a) === normalizeCheckExpr(b);
}
```

- [ ] **Step 4: Run → PASS** — `bun test test/check-evolution/normalize.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/check-expr-compare.ts test/check-evolution/normalize.test.ts
git commit -m "feat(migrate-ts): normalizeCheckExpr — compare CHECK exprs across PG rewrite"
```

---

### Task 2: drop-check `restore` + `allow.dropCheck` gating + reversible down

**Files:**
- Modify: `src/types.ts`, `src/diff/status.ts`, `src/emit/postgres.ts`
- Test: `test/check-evolution/drop-check-down.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/check-evolution/drop-check-down.test.ts
import { describe, test, expect } from "bun:test";
import type { Change } from "../../src/types.js";
import { emit } from "../../src/emit/index.js";
import { applyStatus } from "../../src/diff/status.js";

const CHK = { name: "orders_qty_numeric_chk", expression: "qty >= 1" };

describe("drop-check: restore down + allow gating", () => {
  test("drop-check with restore → down re-adds the constraint", () => {
    const c = { kind: "drop-check", table: "orders", check: CHK.name, restore: CHK, status: { state: "allowed" } } as unknown as Change;
    const r = emit([c], { dialect: "postgres" });
    expect(r.up).toContain(`ALTER TABLE "orders" DROP CONSTRAINT "orders_qty_numeric_chk";`);
    expect(r.down).toContain(`ALTER TABLE "orders" ADD CONSTRAINT "orders_qty_numeric_chk" CHECK (qty >= 1);`);
  });
  test("drop-check is blocked unless allow.dropCheck", () => {
    const blocked = [{ kind: "drop-check", table: "orders", check: CHK.name, status: { state: "allowed" } } as unknown as Change];
    applyStatus(blocked, {});
    expect(blocked[0]!.status.state).toBe("blocked");
    const allowed = [{ kind: "drop-check", table: "orders", check: CHK.name, status: { state: "allowed" } } as unknown as Change];
    applyStatus(allowed, { dropCheck: true });
    expect(allowed[0]!.status.state).toBe("allowed");
  });
  test("add-check stays always-allowed", () => {
    const c = [{ kind: "add-check", table: "orders", check: CHK, status: { state: "allowed" } } as unknown as Change];
    applyStatus(c, {});
    expect(c[0]!.status.state).toBe("allowed");
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/check-evolution/drop-check-down.test.ts` (`dropCheck` not on AllowOptions; drop-check not gated; down is a stub).

- [ ] **Step 3: Implement**

(a) `src/types.ts` — add `restore?` to the `drop-check` Change kind:

```ts
  | { kind: "drop-check"; table: string; schema?: string; check: string; restore?: CheckDescriptor; status: ChangeStatus }
```

and add `dropCheck` to `AllowOptions` (after `dropFk?`):

```ts
  dropCheck?: boolean;
```

(b) `src/diff/status.ts` — move `drop-check` out of the always-allowed group into a gated case (mirroring `drop-index`):

```ts
    case "drop-check":
      return allow.dropCheck ? null : "destructive: drop-check not allowed (pass allow.dropCheck)";
```

(remove `case "drop-check":` from the always-allowed fall-through list so the switch stays exhaustive).

(c) `src/emit/postgres.ts` — the `drop-check` `renderDown` arm uses `restore` when present (replace the WARNING stub):

```ts
    case "drop-check":
      return c.restore
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} ADD CONSTRAINT ${quote(c.restore.name)} CHECK (${c.restore.expression});`
        : `-- WARNING: down migration cannot restore the original CHECK definition`;
```

- [ ] **Step 4: Run → PASS** — `bun test test/check-evolution/drop-check-down.test.ts`, then `bun run build`.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/diff/status.ts src/emit/postgres.ts test/check-evolution/drop-check-down.test.ts
git commit -m "feat(migrate-ts): drop-check restore down + allow.dropCheck gating"
```

---

### Task 3: `diffTableChecks` (pass-2, Postgres-only) + offline evolution

**Files:**
- Modify: `src/diff/index.ts`, `src/snapshot/plan.ts`
- Test: `test/check-evolution/diff-offline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/check-evolution/diff-offline.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor, CheckDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";

const CHK = (name: string, expression: string): CheckDescriptor => ({ name, expression });
function tbl(checks: CheckDescriptor[]): TableDescriptor {
  return { name: "orders", columns: [{ name: "qty", sqlType: { kind: "integer", bits: 32 }, nullable: false }],
    indexes: [], foreignKeys: [], checks, primaryKey: ["qty"] };
}
const snap = (checks: CheckDescriptor[]): SchemaSnapshot => ({ tables: [tbl(checks)], views: [] });
const C0 = CHK("orders_qty_numeric_chk", "qty >= 1");
const C0b = CHK("orders_qty_numeric_chk", "qty >= 5"); // changed bound, same name
const C1 = CHK("orders_qty_max_chk", "qty <= 100");

describe("diffTableChecks — postgres existing-table evolution", () => {
  test("added check on an existing table → add-check", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]), dialect: "postgres" });
    expect(r.changes.filter((c) => c.kind === "add-check").map((c) => (c as any).check.name)).toEqual(["orders_qty_max_chk"]);
  });
  test("removed check → drop-check (gated, so blocked without allow)", async () => {
    const r = await diff({ expected: snap([C0]), actual: snap([C0, C1]), dialect: "postgres" });
    const drop = r.changes.find((c) => c.kind === "drop-check");
    expect(drop && (drop as any).check).toBe("orders_qty_max_chk");
    expect(drop!.status.state).toBe("blocked"); // no allow.dropCheck
  });
  test("changed expression (same name) → drop + add", async () => {
    const r = await diff({ expected: snap([C0b]), actual: snap([C0]), dialect: "postgres", allow: { dropCheck: true } });
    expect(r.changes.some((c) => c.kind === "drop-check")).toBe(true);
    expect(r.changes.some((c) => c.kind === "add-check" && (c as any).check.expression === "qty >= 5")).toBe(true);
  });
  test("PG-rewritten actual expression equal to expected → NO change (idempotent)", async () => {
    const r = await diff({ expected: snap([CHK("orders_qty_numeric_chk", "qty >= 1")]),
      actual: snap([CHK("orders_qty_numeric_chk", "(qty >= 1)")]), dialect: "postgres" });
    expect(r.changes.some((c) => c.kind.endsWith("-check"))).toBe(false);
  });
  test("dialect gate: sqlite produces NO check changes even when they differ", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]), dialect: "sqlite" });
    expect(r.changes.some((c) => c.kind.endsWith("-check"))).toBe(false);
  });
  test("no dialect passed → no check evolution (back-compat)", async () => {
    const r = await diff({ expected: snap([C0, C1]), actual: snap([C0]) });
    expect(r.changes.some((c) => c.kind.endsWith("-check"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/check-evolution/diff-offline.test.ts` (no `dialect` on DiffArgs; no check diff).

- [ ] **Step 3: Implement** — in `src/diff/index.ts`:

(a) add `dialect?` to `DiffArgs` and import `Dialect` + the comparator:

```ts
// in the existing type import:
  Change, ChangeStatus, DiffResult, AllowOptions, AmbiguousCallback, Dialect,
// add:
import { checkExprEquals } from "../check-expr-compare.js";
```

```ts
export interface DiffArgs {
  ...
  ignoreTables?: string[];
  /** Dialect; CHECK-constraint evolution on existing tables is emitted for postgres only. */
  dialect?: Dialect;
}
```

(b) in the pass-2 per-table block (next to `diffTableIndexes(expectedTable, actualTable, changes);` / `diffTableForeignKeys(...)`), add a postgres-gated call:

```ts
    if (args.dialect === "postgres") diffTableChecks(expectedTable, actualTable, changes);
```

(Confirm the variable holding the diff args is named `args` in that scope; match the real name.)

(c) add the helper (model it on `diffTableIndexes`, comparing by name with `checkExprEquals`):

```ts
function diffTableChecks(expected: TableDescriptor, actual: TableDescriptor, changes: Change[]): void {
  const sx = schemaSpread(expected.schema);
  const expectedChk = new Map(expected.checks.map((c) => [c.name, c]));
  const actualChk = new Map(actual.checks.map((c) => [c.name, c]));
  for (const [name, ec] of expectedChk) {
    const ac = actualChk.get(name);
    if (!ac) {
      changes.push({ kind: "add-check", table: expected.name, ...sx, check: ec, status: ALLOWED });
    } else if (!checkExprEquals(ec.expression, ac.expression)) {
      changes.push({ kind: "drop-check", table: expected.name, ...sx, check: name, restore: ac, status: ALLOWED });
      changes.push({ kind: "add-check", table: expected.name, ...sx, check: ec, status: ALLOWED });
    }
  }
  for (const [name, ac] of actualChk) {
    if (!expectedChk.has(name)) {
      changes.push({ kind: "drop-check", table: expected.name, ...sx, check: name, restore: ac, status: ALLOWED });
    }
  }
}
```

(d) In `src/snapshot/plan.ts`, thread `dialect` into the `diff(...)` call inside `planOffline` so the offline (default) path evolves checks. Find the `diff({ expected: ..., actual: ... })` call and add `dialect: args.dialect`. (Confirm `planOffline`'s args expose `dialect` — Plan 1 gave it one.)

- [ ] **Step 4: Run → PASS** — `bun test test/check-evolution/diff-offline.test.ts`, then `bun run build`. (`add-check`/`drop-check` were already exhaustive in `applyStatus` + emit, so no exhaustiveness breakage. `drop-check` blocked-status comes from `applyStatus` running after the diff — confirm the diff calls `applyStatus(changes, allow)` before returning; it does for the other drop-* kinds.)

- [ ] **Step 5: Commit**

```bash
git add src/diff/index.ts src/snapshot/plan.ts test/check-evolution/diff-offline.test.ts
git commit -m "feat(migrate-ts): diffTableChecks — evolve CHECKs on existing PG tables (offline)"
```

---

### Task 4: Postgres CHECK introspection (`readPgChecks`)

**Files:**
- Modify: `src/introspect/postgres.ts`
- Test: `test/integration/postgres-check-introspect.test.ts`

- [ ] **Step 1: Write the failing test** (gated on `MIGRATE_TS_PG_URL` — pg-mem can't introspect `pg_constraint`; mirror the existing FK/index gated integration tests)

```ts
// test/integration/postgres-check-introspect.test.ts
import { describe, test, expect } from "bun:test";
import { Kysely, PostgresDialect, sql } from "kysely";
import { Pool } from "pg";
import { introspectPostgres } from "../../src/introspect/postgres.js";

const PG_URL = process.env.MIGRATE_TS_PG_URL;
const d = PG_URL ? describe : describe.skip;

d("postgres CHECK introspection (real PG)", () => {
  test("reads a table's CHECK constraints with normalized-comparable expressions", async () => {
    const k = new Kysely<Record<string, unknown>>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: PG_URL }) }) });
    try {
      const t = "chk_introspect_" + Math.random().toString(36).slice(2, 8);
      await sql.raw(`CREATE TABLE ${t} ( qty INTEGER NOT NULL, CONSTRAINT ${t}_qty_chk CHECK (qty >= 1 AND qty <= 100) )`).execute(k);
      const snap = await introspectPostgres(k);
      const table = snap.tables.find((x) => x.name === t)!;
      const chk = table.checks.find((c) => c.name === `${t}_qty_chk`);
      expect(chk).toBeDefined();
      // pg_get_constraintdef returns a parenthesized form; assert the expression is captured
      expect(chk!.expression.toLowerCase()).toContain("qty >= 1");
      await sql.raw(`DROP TABLE ${t}`).execute(k);
    } finally { await k.destroy(); }
  });
});
```

- [ ] **Step 2: Run → behavior** — `bun test test/integration/postgres-check-introspect.test.ts`. With no `MIGRATE_TS_PG_URL` it SKIPS (expected in unit runs). With a real PG (`MIGRATE_TS_PG_URL=postgres://… bun test …`) it FAILS first (checks still `[]`).

- [ ] **Step 3: Implement** — in `src/introspect/postgres.ts`:

(a) replace the table-build `checks: []` line (it has a comment "CHECK introspection is out of scope") with:

```ts
      checks: await readPgChecks(k, schema, name),
```

(b) add `readPgChecks` modeled on `readPgForeignKeys` (raw SQL + a pg-mem catch returning `[]`); import `CheckDescriptor` into the file's type imports if not already present:

```ts
/**
 * Read CHECK constraints for a table from pg_constraint. pg-mem does not support
 * pg_constraint, so this catches and returns [] there (same accepted gap as
 * readPgForeignKeys/readPgIndexes); real-DB coverage is the MIGRATE_TS_PG_URL-gated
 * integration test. `pg_get_constraintdef` returns `CHECK (<expr>)`; the wrapper is
 * stripped to the expression, compared via normalizeCheckExpr at diff time.
 */
async function readPgChecks(k: RawKysely, schema: string, table: string): Promise<CheckDescriptor[]> {
  try {
    const rows = await sql<{ name: string; def: string }>`
      SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class rel ON rel.oid = con.conrelid
      JOIN pg_namespace ns ON ns.oid = rel.relnamespace
      WHERE con.contype = 'c' AND rel.relname = ${table} AND ns.nspname = ${schema}
    `.execute(k);
    return rows.rows.map((r) => ({ name: r.name, expression: stripCheckWrapper(r.def) }));
  } catch {
    return []; // pg-mem: pg_constraint unsupported
  }
}

/** `CHECK (<expr>)` → `<expr>` (balanced outer wrapper); returns input unchanged if no wrapper. */
function stripCheckWrapper(def: string): string {
  const m = /^\s*CHECK\s*\((.*)\)\s*$/is.exec(def);
  return m ? m[1]!.trim() : def.trim();
}
```

(Match the real `RawKysely`/`sql` names in the file — the survey shows `readPgForeignKeys(k: RawKysely, …)` and `sql\`…\`.execute(k)`.)

- [ ] **Step 4: Run → PASS (real PG) / SKIP (unit)** — without `MIGRATE_TS_PG_URL`: the new test skips and the full unit suite stays green (pg-mem introspect returns `[]` → no behavior change in unit tests). With `MIGRATE_TS_PG_URL`: the new test passes. Run `bun test` (full unit suite, 0 fail) + `bun run build`.

- [ ] **Step 5: Commit**

```bash
git add src/introspect/postgres.ts test/integration/postgres-check-introspect.test.ts
git commit -m "feat(migrate-ts): introspect Postgres CHECK constraints (pg_constraint)"
```

---

### Task 5: end-to-end + no-double-emit + full verification

**Files:**
- Test: `test/check-evolution/e2e.test.ts`

- [ ] **Step 1: Write the failing test** (passes once Tasks 1–3 land — the integration guard)

```ts
// test/check-evolution/e2e.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor, CheckDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

const CHK = (n: string, e: string): CheckDescriptor => ({ name: n, expression: e });
function tbl(checks: CheckDescriptor[]): TableDescriptor {
  return { name: "orders", columns: [{ name: "qty", sqlType: { kind: "integer", bits: 32 }, nullable: false }],
    indexes: [], foreignKeys: [], checks, primaryKey: ["qty"] };
}
const snap = (checks: CheckDescriptor[]): SchemaSnapshot => ({ tables: [tbl(checks)], views: [] });

describe("e2e: existing-table CHECK evolution (postgres)", () => {
  test("adding a check on an existing table emits ALTER TABLE ADD CONSTRAINT", async () => {
    const r = await diff({ expected: snap([CHK("orders_qty_chk", "qty >= 1")]), actual: snap([]), dialect: "postgres" });
    const { up } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(`ALTER TABLE "orders" ADD CONSTRAINT "orders_qty_chk" CHECK (qty >= 1);`);
  });
  test("create-table on empty actual inlines the check (no separate ADD CONSTRAINT)", async () => {
    // a brand-new table carries its checks inline in CREATE TABLE; diffTableChecks
    // runs only for tables present on BOTH sides, so no add-check fires here.
    const fresh: SchemaSnapshot = { tables: [tbl([CHK("orders_qty_chk", "qty >= 1")])], views: [] };
    const r = await diff({ expected: fresh, actual: { tables: [], views: [] }, dialect: "postgres" });
    const { up } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(`CONSTRAINT "orders_qty_chk" CHECK (qty >= 1)`); // inline in CREATE TABLE
    expect(up).not.toContain(`ADD CONSTRAINT "orders_qty_chk"`);          // not also an ALTER
  });
});
```

- [ ] **Step 2: Run → PASS** — `bun test test/check-evolution/e2e.test.ts`.

- [ ] **Step 3: Full verification** — `bun test` (all migrate-ts tests + `test/check-evolution/*`, 0 failures; the gated integration test skips), `bun run build` (tsc exit 0), `bun run typecheck` (exit 0). If `bun run build` reports missing `@metaobjectsdev/metadata` declarations, build `../metadata` first (gitignored, don't commit).

- [ ] **Step 4: Commit**

```bash
git add test/check-evolution/e2e.test.ts
git commit -m "test(migrate-ts): e2e existing-table CHECK evolution + no double-emit on create"
```

- [ ] **Step 5 (note, not a code change):** the `--from-db` CLI path benefits from Task 4 introspection once the CLI threads its `dialect` into the live-introspection `diff(...)` call in `packages/cli/src/commands/migrate.ts` (the offline path is threaded in Task 3). That one-line CLI thread + a `verify --replay` re-check are a small follow-on outside this migrate-ts plan.

---

## Self-review notes (for the executor)

- **Spec coverage:** §4 introspection = Task 4; §5 normalizer+diff+dialect-gate = Tasks 1+3; §7 down restore = Task 2; §8 gating = Task 2; §9 tests spread across Tasks 1/3/4/5. §6 SQLite-via-recreate is honored by the dialect gate (no code). §3 offline path = Task 3 (`planOffline` thread); `--from-db` path = Task 4 + the Task-5 CLI note.
- **Idempotency:** offline path is snapshot-driven (no DB); `--from-db`/replay need Task 4's introspection. The `normalizeCheckExpr` test proves the PG-rewrite equivalence (the idempotency crux).
- **No double-emit on new tables:** `diffTableChecks` runs only for tables present on both sides (pass-2); a created table carries checks inline (pass-1) — Task 5 guards this.
- **Type/name anchors:** `diffTableChecks(expected, actual, changes)`; `drop-check` carries `restore?: CheckDescriptor`; `AllowOptions.dropCheck`; `DiffArgs.dialect?: Dialect`; `normalizeCheckExpr`/`checkExprEquals` in `src/check-expr-compare.ts`; `readPgChecks` in `src/introspect/postgres.ts`. Match `applyStatus` (already exhaustive), `RawKysely`, and the `args`/`schemaSpread`/`ALLOWED` names in the real files.
