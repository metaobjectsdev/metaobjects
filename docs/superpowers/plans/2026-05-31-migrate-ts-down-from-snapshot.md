# migrate-ts Down-from-Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate real `down` migrations for lossy structural drops (`drop-table`/`drop-column`/`drop-index`/`drop-fk`) by re-creating the dropped object from the prior descriptor the diff already has — replacing today's `-- TODO restore manually` stubs (Postgres).

**Architecture:** The reference-snapshot diff (`diff(expected, actual)`) produces a `drop-*` change when the `actual` side (the committed snapshot, or live introspection) has an object the `expected` side doesn't — and it *already holds the full prior descriptor* at that point, then discards it. Carry that descriptor on the change as an **optional `restore?` field**, and have the Postgres `renderDown` re-create from it (the down of a `drop-X` is the up of `add-X`). Optional = backward-compatible: existing hand-built `drop-*` change literals (and the SQLite path) are unaffected and keep the stub.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Bun test runner, `@metaobjectsdev/migrate-ts`.

**Prerequisite:** Plans 1–3 + 6 on origin/main (the snapshot/diff/emit pipeline with CHECK).

**Scope:** Postgres `down` for `drop-table`/`drop-column`/`drop-index`/`drop-fk`, gated on a present `restore` descriptor. **Out of scope (own follow-on):** SQLite down-from-restore (its drop-column goes through recreate-and-copy, a more involved inverse); `drop-check`/`drop-view` restore (checks are create-time-only / views already re-emit their body on replace).

**Working directory for all commands:** `server/typescript/packages/migrate-ts`.

---

### Task 1: add optional `restore` to the four drop-* change kinds

**Files:**
- Modify: `src/types.ts`
- Test: `test/down/restore-shape.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/down/restore-shape.test.ts
import { describe, test, expect } from "bun:test";
import type { Change, TableDescriptor, ColumnDescriptor, IndexDescriptor, FkDescriptor } from "../../src/types.js";

describe("drop-* change kinds carry an optional restore descriptor", () => {
  test("drop-column accepts a restore ColumnDescriptor", () => {
    const col: ColumnDescriptor = { name: "email", sqlType: { kind: "text" }, nullable: false };
    const c: Change = { kind: "drop-column", table: "users", column: "email", restore: col, status: { state: "ok" } } as unknown as Change;
    expect(c.kind === "drop-column" && c.restore?.name).toBe("email");
  });
  test("drop-table accepts a restore TableDescriptor", () => {
    const t: TableDescriptor = { name: "users", columns: [], indexes: [], foreignKeys: [], primaryKey: [], checks: [] };
    const c: Change = { kind: "drop-table", table: "users", restore: t, status: { state: "ok" } } as unknown as Change;
    expect(c.kind === "drop-table" && c.restore?.name).toBe("users");
  });
  test("drop-index / drop-fk accept restore descriptors, and restore is optional", () => {
    const ix: IndexDescriptor = { name: "users_email_idx", columns: ["email"], unique: true };
    const fk: FkDescriptor = { name: "orders_user_fk", columns: ["user_id"], refTable: "users", refColumns: ["id"] };
    const c1: Change = { kind: "drop-index", table: "users", index: "users_email_idx", restore: ix, status: { state: "ok" } } as unknown as Change;
    const c2: Change = { kind: "drop-fk", table: "orders", fk: "orders_user_fk", restore: fk, status: { state: "ok" } } as unknown as Change;
    const c3: Change = { kind: "drop-index", table: "users", index: "x", status: { state: "ok" } } as unknown as Change; // restore omitted = legacy
    expect(c1.kind === "drop-index" && c1.restore?.unique).toBe(true);
    expect(c2.kind === "drop-fk" && c2.restore?.refTable).toBe("users");
    expect(c3.kind === "drop-index" && c3.restore).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/down/restore-shape.test.ts` (the `restore` property isn't on the union).

- [ ] **Step 3: Implement** — in `src/types.ts`, add `restore?` to each of the four drop change kinds (keep all existing fields):

```ts
  | { kind: "drop-table"; table: string; schema?: string; restore?: TableDescriptor; status: ChangeStatus }
  ...
  | { kind: "drop-column"; table: string; schema?: string; column: string; restore?: ColumnDescriptor; status: ChangeStatus }
  ...
  | { kind: "drop-index"; table: string; schema?: string; index: string; restore?: IndexDescriptor; status: ChangeStatus }
  ...
  | { kind: "drop-fk"; table: string; schema?: string; fk: string; restore?: FkDescriptor; status: ChangeStatus }
```

(`TableDescriptor`/`ColumnDescriptor`/`IndexDescriptor`/`FkDescriptor` are already declared in this file.)

- [ ] **Step 4: Run → PASS** — `bun test test/down/restore-shape.test.ts`, then `bun run build` (tsc exit 0; optional field → no existing literal breaks).

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/down/restore-shape.test.ts
git commit -m "feat(migrate-ts): optional restore descriptor on drop-* change kinds"
```

---

### Task 2: diff populates `restore` from the actual (prior) side

**Files:**
- Modify: `src/diff/index.ts`
- Test: `test/down/diff-restore.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/down/diff-restore.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";

const usersTable = (extraCols = true): TableDescriptor => ({
  name: "users",
  columns: [
    { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    ...(extraCols ? [{ name: "email", sqlType: { kind: "text" as const }, nullable: false }] : []),
  ],
  indexes: extraCols ? [{ name: "users_email_idx", columns: ["email"], unique: true }] : [],
  foreignKeys: [], primaryKey: ["id"], checks: [],
});
const snap = (t: TableDescriptor): SchemaSnapshot => ({ tables: [t], views: [] });

describe("diff attaches the prior descriptor as restore on drops", () => {
  test("drop-column carries the prior ColumnDescriptor", async () => {
    // expected lacks email; actual has it → drop-column with restore=email's descriptor
    const r = await diff({ expected: snap(usersTable(false)), actual: snap(usersTable(true)) });
    const dc = r.changes.find((c) => c.kind === "drop-column");
    expect(dc && dc.kind === "drop-column" && dc.restore?.name).toBe("email");
    expect(dc && dc.kind === "drop-column" && dc.restore?.sqlType.kind).toBe("text");
  });
  test("drop-index carries the prior IndexDescriptor", async () => {
    const r = await diff({ expected: snap(usersTable(false)), actual: snap(usersTable(true)) });
    const di = r.changes.find((c) => c.kind === "drop-index");
    expect(di && di.kind === "drop-index" && di.restore?.unique).toBe(true);
  });
  test("drop-table carries the prior TableDescriptor", async () => {
    const r = await diff({ expected: { tables: [], views: [] }, actual: snap(usersTable(true)) });
    const dt = r.changes.find((c) => c.kind === "drop-table");
    expect(dt && dt.kind === "drop-table" && dt.restore?.name).toBe("users");
    expect(dt && dt.kind === "drop-table" && dt.restore?.columns.length).toBe(2);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/down/diff-restore.test.ts` (`restore` is undefined).

- [ ] **Step 3: Implement** — in `src/diff/index.ts`, attach the descriptor the loops already hold:

In Pass 1b (drop-table), the loop is `for (const [id, t] of actualTables)`; add `restore: t` to the pushed change:

```ts
        kind: "drop-table", table: t.name, ...schemaSpread(t.schema), restore: t, status: ALLOWED,
```

In the column drop loop `for (const [name, ac] of actualCols)` add `restore: ac`:

```ts
        kind: "drop-column", table, ...sx, column: name, restore: ac, status: ALLOWED,
```

In the index drop loop, change `for (const [name] of actualIdx)` → `for (const [name, ai] of actualIdx)` and add `restore: ai`:

```ts
      changes.push({ kind: "drop-index", table, ...sx, index: name, restore: ai, status: ALLOWED });
```

In the fk drop loop, change `for (const [name] of actualFk)` → `for (const [name, af] of actualFk)` and add `restore: af` (match the actual fk-map variable name in the file — likely `actualFk`/`actualFks`):

```ts
      changes.push({ kind: "drop-fk", table, ...sx, fk: name, restore: af, status: ALLOWED });
```

(Verify the exact actual-map variable names — `actualCols`, `actualIdx`, and the fk map — against the file and match them. Only add `restore`; don't change any other field or the change ordering.)

- [ ] **Step 4: Run → PASS** — `bun test test/down/diff-restore.test.ts`, then `bun run build`.

- [ ] **Step 5: Commit**

```bash
git add src/diff/index.ts test/down/diff-restore.test.ts
git commit -m "feat(migrate-ts): diff records prior descriptor as restore on drops"
```

---

### Task 3: Postgres `renderDown` re-creates from `restore`

**Files:**
- Modify: `src/emit/postgres.ts`
- Test: `test/down/emit-postgres-down.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/down/emit-postgres-down.test.ts
import { describe, test, expect } from "bun:test";
import type { Change } from "../../src/types.js";
import { emit } from "../../src/emit/index.js";

const ALLOWED = { state: "ok" } as const;
const down = (c: Change) => emit([c], { dialect: "postgres" }).down;

describe("postgres down-from-restore", () => {
  test("drop-column with restore → ADD COLUMN + data-not-restored note", () => {
    const c = { kind: "drop-column", table: "users", column: "email",
      restore: { name: "email", sqlType: { kind: "text" }, nullable: false }, status: ALLOWED } as unknown as Change;
    const d = down(c);
    expect(d).toContain(`ALTER TABLE "users" ADD COLUMN "email" TEXT NOT NULL;`);
    expect(d).toMatch(/column data is not restored/i);
  });
  test("drop-table with restore → CREATE TABLE + data-not-restored note", () => {
    const c = { kind: "drop-table", table: "users",
      restore: { name: "users", columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [], foreignKeys: [], primaryKey: ["id"], checks: [] }, status: ALLOWED } as unknown as Change;
    const d = down(c);
    expect(d).toContain(`CREATE TABLE "users"`);
    expect(d).toMatch(/table data is not restored/i);
  });
  test("drop-index with restore → CREATE INDEX (full structural restore, no data note)", () => {
    const c = { kind: "drop-index", table: "users", index: "users_email_idx",
      restore: { name: "users_email_idx", columns: ["email"], unique: true }, status: ALLOWED } as unknown as Change;
    const d = down(c);
    expect(d).toContain(`CREATE UNIQUE INDEX "users_email_idx" ON "users" ("email");`);
    expect(d).not.toMatch(/not restored/i);
  });
  test("drop-fk with restore → ADD CONSTRAINT FOREIGN KEY", () => {
    const c = { kind: "drop-fk", table: "orders", fk: "orders_user_fk",
      restore: { name: "orders_user_fk", columns: ["user_id"], refTable: "users", refColumns: ["id"] }, status: ALLOWED } as unknown as Change;
    const d = down(c);
    expect(d).toContain(`ALTER TABLE "orders" ADD CONSTRAINT "orders_user_fk" FOREIGN KEY ("user_id") REFERENCES "users" ("id")`);
  });
  test("drop-column WITHOUT restore → falls back to the legacy TODO stub", () => {
    const c = { kind: "drop-column", table: "users", column: "email", status: ALLOWED } as unknown as Change;
    expect(down(c)).toMatch(/TODO: re-add dropped column/i);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/down/emit-postgres-down.test.ts` (down still emits stubs).

- [ ] **Step 3: Implement** — in `src/emit/postgres.ts` `renderDown(c)`, replace the four stub arms so they re-create when `restore` is present, else keep the stub. Reuse the existing up-helpers `renderCreateTable`, `renderColumn`, `renderCreateIndex`, `renderAddFk` (confirm their exact names/signatures in the file — `renderColumn(c)`, `renderCreateTable(t)`, `renderCreateIndex(table, schema, index)`, `renderAddFk(table, schema, fk)`):

```ts
    case "drop-table":
      return c.restore
        ? `${renderCreateTable(c.restore)}\n-- NOTE: table data is not restored by this down migration.`
        : `-- WARNING: down migration cannot restore data\n-- TODO: restore table "${c.table}" structure manually`;
    case "drop-column":
      return c.restore
        ? `ALTER TABLE ${quoteQualified(c.table, c.schema)} ADD COLUMN ${renderColumn(c.restore)};\n-- NOTE: column data is not restored by this down migration.`
        : `-- WARNING: down migration cannot restore data\n-- TODO: re-add dropped column "${c.column}" manually with original type/nullable/default`;
    case "drop-index":
      return c.restore
        ? renderCreateIndex(c.table, c.schema, c.restore)
        : `-- WARNING: down migration cannot restore the original index definition`;
    case "drop-fk":
      return c.restore
        ? renderAddFk(c.table, c.schema, c.restore)
        : `-- WARNING: down migration cannot restore the original FK definition`;
```

(If `renderCreateIndex`/`renderAddFk` have different parameter orders in the file, match them. Keep the other renderDown arms — drop-check/drop-view/replace-view — unchanged.)

- [ ] **Step 4: Run → PASS** — `bun test test/down/emit-postgres-down.test.ts`, then `bun test` (full suite), then `bun run build`.

- [ ] **Step 5: Commit**

```bash
git add src/emit/postgres.ts test/down/emit-postgres-down.test.ts
git commit -m "feat(migrate-ts): postgres down re-creates dropped table/column/index/fk from snapshot"
```

---

### Task 4: end-to-end — offline drop-a-field produces a real reversible migration

**Files:**
- Test: `test/down/e2e-down.test.ts`

- [ ] **Step 1: Write the failing test** (it should PASS once Tasks 1–3 are in; this is the integration guard the unit tests don't cover — full `buildExpectedSchema → diff → emit`)

```ts
// test/down/e2e-down.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { diff } from "../../src/diff/index.js";
import { emit } from "../../src/emit/index.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}
const ENTITY = (fields: string) => JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "User", children: [
      { "field.long": { name: "id" } },
      ...JSON.parse(fields),
      { "source.rdb": { name: "src", "@table": "users" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});

describe("e2e: dropping a field yields a reversible migration", () => {
  test("up drops the column; down re-adds it with the recorded type", async () => {
    // snapshot (prior) has `email`; new metadata removes it
    const prior = buildExpectedSchema(await load(ENTITY('[{"field.string":{"name":"email"}}]')), { dialect: "postgres" });
    const next = buildExpectedSchema(await load(ENTITY('[]')), { dialect: "postgres" });
    const r = await diff({ expected: next, actual: prior });
    const { up, down } = emit(r.changes, { dialect: "postgres" });
    expect(up).toContain(`DROP COLUMN "email"`);
    expect(down).toContain(`ADD COLUMN "email"`);
    expect(down).toMatch(/column data is not restored/i);
    // down is no longer a bare TODO stub
    expect(down).not.toMatch(/TODO: re-add dropped column/i);
  });
});
```

- [ ] **Step 2: Run → PASS** — `bun test test/down/e2e-down.test.ts`.

- [ ] **Step 3: Full verification** — `bun test` (all migrate-ts tests + the new down/* tests, 0 failures), `bun run build` (tsc exit 0), `bun run typecheck` (exit 0 — the optional `restore` field doesn't break the cli's `Record<ChangeKind>` since no kind was added).

- [ ] **Step 4: Commit**

```bash
git add test/down/e2e-down.test.ts
git commit -m "test(migrate-ts): e2e reversible drop-column migration (up DROP / down ADD)"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** implements spec §5 "real down-migrations for lossy ops" for Postgres (the snapshot records the prior shape → structural restore). SQLite down-from-restore + drop-check/drop-view restore are explicit follow-ons.
- **Why optional `restore`:** keeps every existing hand-built `drop-*` change literal compiling (no fixture churn like the CHECK work caused), and the SQLite emit path + any caller that doesn't set it transparently keeps the stub. Real generation (offline + `--from-db`) always sets it because the diff has it.
- **Down of drop = up of add:** Task 3 reuses `renderCreateTable`/`renderColumn`/`renderCreateIndex`/`renderAddFk` — no new SQL rendering logic, so the restored DDL is guaranteed consistent with create-time DDL.
- **Data caveat is explicit:** table/column down carry a `-- NOTE: data is not restored` line (structure only); index/fk are pure structure (full restore, no note).
- **Type anchors:** `TableDescriptor`/`ColumnDescriptor`/`IndexDescriptor`/`FkDescriptor`/`Change` in `src/types.ts`; helpers in `src/emit/postgres.ts`; diff loops in `src/diff/index.ts`.
