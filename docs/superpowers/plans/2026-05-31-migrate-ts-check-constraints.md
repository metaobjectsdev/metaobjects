# migrate-ts CHECK Constraints (from field.enum) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate `CHECK (col IN ('A','B',…))` constraints from the existing `field.enum` metamodel — the highest-value DDL-coverage gap (spec §7.1) — flowing through the same descriptor→diff→emit pipeline as indexes/FKs, for Postgres.

**Architecture:** Add a table-level `CheckDescriptor` to `SchemaSnapshot`, derive checks from `field.enum @values` in `buildExpectedSchema`, diff them (mirroring `diffTableIndexes`), and emit them in `CREATE TABLE` + as `ADD/DROP CONSTRAINT` (Postgres). Because the descriptor gains a field, bump `SNAPSHOT_FORMAT_VERSION` to 2 with a v1→v2 upgrade (older snapshots get empty `checks: []`). This is the first exercise of the `formatVersion` upgrade path.

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Bun test runner, `@metaobjectsdev/metadata` (`MetaDataLoader`, `field.enum` with `@values`).

**Prerequisite:** Plans 1–3 merged (the snapshot foundation + serializer + diff/emit are in place).

**Scope (Postgres, enum-derived):** descriptor + enum→check derivation + serialize/upgrade + diff + Postgres emit. **Out of scope (own follow-ons):** SQLite `add-check`/`drop-check` via recreate-and-copy (SQLite supports inline CHECK in `CREATE TABLE`, but altering a check needs the recreate machinery); an explicit free-form `@check` attr; introspecting checks for `verify --db`; a cross-port conformance fixture.

**Working directory for all commands:** `server/typescript/packages/migrate-ts`.

---

### Task 1: `CheckDescriptor` + table field + Change kinds

**Files:**
- Modify: `src/types.ts`
- Test: `test/check/types-shape.test.ts`

- [ ] **Step 1: Write the failing test** (a compile-level shape test)

```ts
// test/check/types-shape.test.ts
import { describe, test, expect } from "bun:test";
import type { CheckDescriptor, TableDescriptor, Change } from "../../src/types.js";

describe("CheckDescriptor shape", () => {
  test("a check has a name + expression and attaches to a table", () => {
    const check: CheckDescriptor = { name: "orders_status_chk", expression: "status IN ('OPEN','CLOSED')" };
    const table: Pick<TableDescriptor, "checks"> = { checks: [check] };
    expect(table.checks[0]?.name).toBe("orders_status_chk");
  });

  test("add-check / drop-check are Change kinds", () => {
    const add: Change = { kind: "add-check", table: "orders", check: { name: "c", expression: "x > 0" }, status: { state: "ok" } } as unknown as Change;
    const drop: Change = { kind: "drop-check", table: "orders", check: "c", status: { state: "ok" } } as unknown as Change;
    expect(add.kind).toBe("add-check");
    expect(drop.kind).toBe("drop-check");
  });
});
```

- [ ] **Step 2: Run → FAIL** — Run: `bun test test/check/types-shape.test.ts` — Expected: type errors / `CheckDescriptor` not exported.

- [ ] **Step 3: Implement** — in `src/types.ts`:

Add the descriptor (next to `IndexDescriptor`):

```ts
export interface CheckDescriptor {
  /** Constraint name, e.g. `<table>_<column>_chk`. Diff/identity key. */
  name: string;
  /** The boolean SQL expression, e.g. `status IN ('OPEN','CLOSED')`. */
  expression: string;
}
```

Add `checks` to `TableDescriptor` (after `foreignKeys`):

```ts
  checks: CheckDescriptor[];
```

Add two members to the `Change` union (after the `drop-fk` line):

```ts
  | { kind: "add-check"; table: string; schema?: string; check: CheckDescriptor; status: ChangeStatus }
  | { kind: "drop-check"; table: string; schema?: string; check: string; status: ChangeStatus }
```

- [ ] **Step 4: Run → PASS** — `bun test test/check/types-shape.test.ts`. (Note: existing code that constructs `TableDescriptor` literals will now fail `tsc` for a missing `checks` — that's expected and fixed in Tasks 2–3 where those literals live; the package `tsc` will be green again by Task 3. If any non-test source builds a `TableDescriptor` literal, add `checks: []` there now.)

- [ ] **Step 5: Commit**

```bash
git add src/types.ts test/check/types-shape.test.ts
git commit -m "feat(migrate-ts): CheckDescriptor + add-check/drop-check change kinds"
```

---

### Task 2: serialize `checks` + bump format version to 2 with v1→v2 upgrade

**Files:**
- Modify: `src/snapshot/serialize.ts`
- Test: `test/check/serialize-upgrade.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/check/serialize-upgrade.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot } from "../../src/types.js";
import { serializeSnapshot, parseSnapshot, SNAPSHOT_FORMAT_VERSION } from "../../src/snapshot/serialize.js";

const snap = (): SchemaSnapshot => ({
  tables: [{
    name: "orders", columns: [], indexes: [], foreignKeys: [], primaryKey: [],
    checks: [{ name: "orders_status_chk", expression: "status IN ('OPEN','CLOSED')" }],
  }],
  views: [],
});

describe("serialize with checks + formatVersion 2", () => {
  test("format version is 2", () => {
    expect(SNAPSHOT_FORMAT_VERSION).toBe(2);
  });

  test("checks round-trip and are order-stable", () => {
    const s = snap();
    expect(serializeSnapshot(parseSnapshot(serializeSnapshot(s)))).toBe(serializeSnapshot(s));
    expect(parseSnapshot(serializeSnapshot(s)).tables[0]?.checks[0]?.name).toBe("orders_status_chk");
  });

  test("a v1 snapshot (no checks) upgrades to tables with empty checks[]", () => {
    const v1 = JSON.stringify({
      formatVersion: 1,
      snapshot: { tables: [{ name: "orders", columns: [], indexes: [], foreignKeys: [], primaryKey: [] }], views: [] },
    });
    const parsed = parseSnapshot(v1);
    expect(parsed.tables[0]?.checks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/check/serialize-upgrade.test.ts` (SNAPSHOT_FORMAT_VERSION is 1; v1 parse yields tables with no `checks`).

- [ ] **Step 3: Implement** — in `src/snapshot/serialize.ts`:

Bump the constant:

```ts
export const SNAPSHOT_FORMAT_VERSION = 2;
```

Sort `checks` in `canonicalize` — add to the per-table mapping (alongside `columns`/`indexes`/`foreignKeys`):

```ts
      checks: sortByName(t.checks),
```

Add the v1→v2 upgrade in `parseSnapshot`, replacing the final `return file.snapshot;` with:

```ts
  if (file.formatVersion < 2) {
    // v1 → v2: the table descriptor gained `checks`; default older snapshots to [].
    for (const t of file.snapshot.tables) {
      if ((t as { checks?: unknown }).checks === undefined) {
        (t as { checks: unknown[] }).checks = [];
      }
    }
  }
  return file.snapshot;
```

- [ ] **Step 4: Run → PASS** — `bun test test/check/serialize-upgrade.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/serialize.ts test/check/serialize-upgrade.test.ts
git commit -m "feat(migrate-ts): serialize checks + formatVersion 2 with v1 upgrade"
```

---

### Task 3: derive checks from `field.enum` in `buildExpectedSchema`

**Files:**
- Modify: `src/expected-schema.ts`
- Test: `test/check/expected-enum-check.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/check/expected-enum-check.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";

async function load(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

const META = JSON.stringify({
  "metadata.root": { children: [{
    "object.entity": { name: "Order", children: [
      { "field.long": { name: "id" } },
      { "field.enum": { name: "status", "@values": ["OPEN", "CLOSED"] } },
      { "source.rdb": { name: "src", "@table": "orders" } },
      { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
    ] },
  }] },
});

describe("buildExpectedSchema — field.enum → CHECK", () => {
  let table: { checks: { name: string; expression: string }[] };
  beforeAll(async () => {
    table = buildExpectedSchema(await load(META), { dialect: "postgres" }).tables[0]! as never;
  });
  test("emits one check per enum field, named <table>_<column>_chk", () => {
    expect(table.checks).toHaveLength(1);
    expect(table.checks[0]?.name).toBe("orders_status_chk");
  });
  test("expression is `<column> IN (<quoted values>)` over the db column name", () => {
    expect(table.checks[0]?.expression).toBe("status IN ('OPEN', 'CLOSED')");
  });
  test("every table descriptor has a checks array (empty when no enum)", async () => {
    const noEnum = JSON.stringify({ "metadata.root": { children: [{
      "object.entity": { name: "Widget", children: [
        { "field.long": { name: "id" } },
        { "source.rdb": { name: "src", "@table": "widgets" } },
        { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
      ] } }] } });
    const t = buildExpectedSchema(await load(noEnum), { dialect: "postgres" }).tables[0]!;
    expect(t.checks).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/check/expected-enum-check.test.ts` (`checks` undefined / not derived).

- [ ] **Step 3: Implement** — in `src/expected-schema.ts`:

The file already iterates an entity's fields to build `columns` and resolves each field's db column name (search for where it builds `ColumnDescriptor[]` and the `resolveColumnName`/`applyColumnNamingStrategy` call). In the same per-entity scope, build a `checks: CheckDescriptor[]` array: for each field whose subType is `enum` (compare against the metadata constant `FIELD_SUBTYPE_ENUM` imported from `@metaobjectsdev/metadata`; read its `@values` string array via the field's attr accessor — mirror how the file reads other field attrs like `@column`/`@currency`), push:

```ts
// import at top:
import { FIELD_SUBTYPE_ENUM } from "@metaobjectsdev/metadata";
import type { CheckDescriptor } from "./types.js";

// where each enum field's db column name `col` and string values `values: string[]` are known:
const checkExpr = `${col} IN (${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`;
checks.push({ name: `${tableName}_${col}_chk`, expression: checkExpr });
```

Add `checks` to the returned `TableDescriptor` literal (the object that already sets `columns`/`indexes`/`foreignKeys`/`primaryKey`):

```ts
    checks,
```

Initialize `const checks: CheckDescriptor[] = [];` alongside the other per-table arrays. Read `@values` the same way the file reads other typed attrs (it returns a `string[]`); if a project author wrote `field.enum` without `@values`, the loader already rejects it (`ERR_MISSING_REQUIRED_ATTR`), so `values` is always a non-empty array here. Verify the exact field-subType + attr accessors against the existing column-building code and match them.

- [ ] **Step 4: Run → PASS** — `bun test test/check/expected-enum-check.test.ts`, then `bun run build` (tsc exit 0 — this also fixes any `TableDescriptor`-literal `checks` gap from Task 1).

- [ ] **Step 5: Commit**

```bash
git add src/expected-schema.ts test/check/expected-enum-check.test.ts
git commit -m "feat(migrate-ts): derive CHECK constraints from field.enum @values"
```

---

### Task 4: diff `checks` (create-table + pass-2 compare)

**Files:**
- Modify: `src/diff/index.ts`
- Test: `test/check/diff-checks.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/check/diff-checks.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot, TableDescriptor } from "../../src/types.js";
import { diff } from "../../src/diff/index.js";

const tbl = (checks: { name: string; expression: string }[]): TableDescriptor => ({
  name: "orders", columns: [{ name: "status", sqlType: { kind: "text" }, nullable: false }],
  indexes: [], foreignKeys: [], primaryKey: [], checks,
});
const snap = (checks: { name: string; expression: string }[]): SchemaSnapshot => ({ tables: [tbl(checks)], views: [] });
const CHK = { name: "orders_status_chk", expression: "status IN ('OPEN','CLOSED')" };

describe("diff checks", () => {
  test("create-table carries its checks as add-check", async () => {
    const r = await diff({ expected: snap([CHK]), actual: { tables: [], views: [] } });
    expect(r.changes.some((c) => c.kind === "create-table")).toBe(true);
    expect(r.changes.some((c) => c.kind === "add-check")).toBe(true);
  });
  test("check added to an existing table → add-check", async () => {
    const r = await diff({ expected: snap([CHK]), actual: snap([]) });
    expect(r.changes.filter((c) => c.kind === "add-check")).toHaveLength(1);
  });
  test("check removed → drop-check", async () => {
    const r = await diff({ expected: snap([]), actual: snap([CHK]) });
    expect(r.changes.filter((c) => c.kind === "drop-check")).toHaveLength(1);
  });
  test("identical checks → no change", async () => {
    const r = await diff({ expected: snap([CHK]), actual: snap([CHK]) });
    expect(r.changes.filter((c) => c.kind.endsWith("-check"))).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/check/diff-checks.test.ts`.

- [ ] **Step 3: Implement** — in `src/diff/index.ts`, mirroring the index handling exactly:

In Pass 1 (the `create-table` block, right after the `add-index`/`add-fk` loops over `table.indexes`/`table.foreignKeys`), add:

```ts
      for (const check of table.checks) {
        changes.push({ kind: "add-check", table: table.name, ...schemaSpread(table.schema), check, status: ALLOWED });
      }
```

In Pass 2 (next to `diffTableIndexes(expectedTable, actualTable, changes);`), add a call `diffTableChecks(expectedTable, actualTable, changes);` and define the helper modeled on `diffTableIndexes`:

```ts
function diffTableChecks(expected: TableDescriptor, actual: TableDescriptor, changes: Change[]): void {
  const sx = schemaSpread(expected.schema);
  const expectedChk = new Map(expected.checks.map((c) => [c.name, c]));
  const actualChk = new Map(actual.checks.map((c) => [c.name, c]));
  for (const [name, ec] of expectedChk) {
    const ac = actualChk.get(name);
    if (!ac) {
      changes.push({ kind: "add-check", table: expected.name, ...sx, check: ec, status: ALLOWED });
    } else if (ac.expression !== ec.expression) {
      // expression change = drop + re-add (no in-place ALTER for a CHECK body)
      changes.push({ kind: "drop-check", table: expected.name, ...sx, check: name, status: ALLOWED });
      changes.push({ kind: "add-check", table: expected.name, ...sx, check: ec, status: ALLOWED });
    }
  }
  for (const [name] of actualChk) {
    if (!expectedChk.has(name)) {
      changes.push({ kind: "drop-check", table: expected.name, ...sx, check: name, status: ALLOWED });
    }
  }
}
```

(Use the same `ALLOWED` status constant + `schemaSpread` helper the index/fk code uses — match their exact names in this file.)

- [ ] **Step 4: Run → PASS** — `bun test test/check/diff-checks.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/diff/index.ts test/check/diff-checks.test.ts
git commit -m "feat(migrate-ts): diff CHECK constraints (add/drop-check)"
```

---

### Task 5: emit checks for Postgres (CREATE TABLE inline + ALTER)

**Files:**
- Modify: `src/emit/postgres.ts`
- Test: `test/check/emit-postgres-check.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/check/emit-postgres-check.test.ts
import { describe, test, expect } from "bun:test";
import type { TableDescriptor, Change } from "../../src/types.js";
import { emit } from "../../src/emit/index.js";

const ALLOWED = { state: "ok" } as const;
const CHK = { name: "orders_status_chk", expression: "status IN ('OPEN','CLOSED')" };
const table: TableDescriptor = {
  name: "orders", columns: [{ name: "status", sqlType: { kind: "text" }, nullable: false }],
  indexes: [], foreignKeys: [], primaryKey: [], checks: [CHK],
};

describe("emit postgres — checks", () => {
  test("create-table inlines the CHECK constraint", () => {
    const r = emit([{ kind: "create-table", table, status: ALLOWED } as unknown as Change], { dialect: "postgres" });
    expect(r.up).toContain(`CONSTRAINT "orders_status_chk" CHECK (status IN ('OPEN','CLOSED'))`);
  });
  test("add-check → ALTER TABLE ADD CONSTRAINT; down drops it", () => {
    const r = emit([{ kind: "add-check", table: "orders", check: CHK, status: ALLOWED } as unknown as Change], { dialect: "postgres" });
    expect(r.up).toContain(`ALTER TABLE "orders" ADD CONSTRAINT "orders_status_chk" CHECK (status IN ('OPEN','CLOSED'));`);
    expect(r.down).toContain(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_chk";`);
  });
  test("drop-check → ALTER TABLE DROP CONSTRAINT", () => {
    const r = emit([{ kind: "drop-check", table: "orders", check: "orders_status_chk", status: ALLOWED } as unknown as Change], { dialect: "postgres" });
    expect(r.up).toContain(`ALTER TABLE "orders" DROP CONSTRAINT "orders_status_chk";`);
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/check/emit-postgres-check.test.ts`.

- [ ] **Step 3: Implement** — in `src/emit/postgres.ts`:

Add priorities to the `PRIORITY` map (checks after columns exist — same tier as indexes/fks; match the value used for `add-index`):

```ts
  "add-check": 2, "drop-check": 2,
```

In `renderCreateTable(t)`, after the `primaryKey` `colDefs.push(...)` block, inline each check:

```ts
  for (const chk of t.checks) {
    colDefs.push(`  CONSTRAINT ${quote(chk.name)} CHECK (${chk.expression})`);
  }
```

In `renderUp(c)` (the up `switch`), add:

```ts
    case "add-check":  return `ALTER TABLE ${quoteQualified(c.table, c.schema)} ADD CONSTRAINT ${quote(c.check.name)} CHECK (${c.check.expression});`;
    case "drop-check": return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT ${quote(c.check)};`;
```

In `renderDown(c)`, add the inverses:

```ts
    case "add-check":  return `ALTER TABLE ${quoteQualified(c.table, c.schema)} DROP CONSTRAINT ${quote(c.check.name)};`;
    case "drop-check": return `-- WARNING: down migration cannot restore the original CHECK definition`;
```

(Match the existing `quote`/`quoteQualified` helpers and the switch's existing style. If the emit switch is exhaustive over `Change["kind"]`, adding these cases also satisfies `tsc`.)

- [ ] **Step 4: Run → PASS** — `bun test test/check/emit-postgres-check.test.ts`, then `bun test` (full suite), then `bun run build` (tsc exit 0).

Note: `emit` for SQLite/D1 will throw or no-op on `add-check`/`drop-check` until the SQLite recreate path is added (a follow-on). Confirm the Postgres path is green; if the SQLite emit `switch` is exhaustive and now fails `tsc` for the new kinds, add `case "add-check": case "drop-check":` arms to `src/emit/sqlite.ts` that throw a clear "CHECK migration not implemented for sqlite (recreate path pending)" error so the type stays exhaustive without silently mis-emitting.

- [ ] **Step 5: Commit**

```bash
git add src/emit/postgres.ts test/check/emit-postgres-check.test.ts
git commit -m "feat(migrate-ts): emit CHECK constraints for postgres (create-table + alter)"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** implements spec §7.1 CHECK constraints derived from `field.enum`, through the full descriptor→diff→emit pipeline, and exercises the §4 `formatVersion` upgrade for the first time (v1→v2). Deferred (own follow-ons): SQLite `add-check`/`drop-check` via recreate, explicit `@check` attr, introspecting checks for `verify --db`, cross-port conformance fixture.
- **Pattern anchors:** checks mirror **indexes** exactly — Task 4's `diffTableChecks` is modeled on `diffTableIndexes`; Task 5's emit mirrors `add-index`/`drop-index`. Match the real `ALLOWED`/`schemaSpread`/`quote`/`quoteQualified`/`PRIORITY` names in those files.
- **Type-consistency:** `CheckDescriptor { name, expression }`; `TableDescriptor.checks: CheckDescriptor[]`; Change kinds `add-check` (carries `check: CheckDescriptor`) / `drop-check` (carries `check: string` name). Used consistently across Tasks 1–5.
- **Determinism:** Task 2 sorts `checks` by name in `canonicalize` so the snapshot stays byte-stable; the enum-derived check name `<table>_<col>_chk` is deterministic.
- **Verification gotcha:** building deps' `dist/` may be needed for `tsc` in a fresh worktree (the `@metaobjectsdev/metadata` declarations) — rebuild `../metadata` first if tsc reports missing modules; that output is gitignored.
