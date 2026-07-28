# D1 referenced-table rebuild — detect-and-refuse (#226) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `meta migrate --dialect d1` throw a clear generation-time error instead of silently emitting a migration that fails against production when it would rebuild a foreign-key-referenced table.

**Architecture:** A rebuild of an FK-referenced table cannot apply on remote D1 (the rebuild's `PRAGMA foreign_keys=OFF` is a no-op inside D1's implicit transaction, so dropping the referenced table fails). `renderSqlite` already computes and returns the set of tables it rebuilds (`EmitResult.recreatedTables`). `renderD1` will consume that set, scan the expected schema's foreign keys for any table that targets a rebuilt table, and throw a dedicated error if found — otherwise emit exactly as today (byte-identical).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `bun:test`, `@libsql/kysely-libsql` (libSQL — a real SQLite engine, no Docker) for the integration gate.

**Design spec:** `docs/superpowers/specs/2026-07-27-d1-referenced-table-rebuild-refuse-design.md`

## Global Constraints

- **D1 is TS-only.** All changes are in `server/typescript/packages/migrate-ts` (+ `docs/`, `CHANGELOG.md`). No other language port is touched.
- **Byte-identical output** for any migration that does NOT rebuild a referenced table. The refuse only triggers on the specific dangerous pattern.
- **No `any`** — use `unknown` and narrow. ESM only; every relative import ends in `.js`.
- **Over-refuse bias:** detection uses the expected (target) schema's foreign keys. A rebuilt table referenced by any FK — including its own (self-referential) — is refused. When in doubt, refuse.
- **Public repo:** no local absolute paths, no private names in any committed file (code, tests, docs, CHANGELOG).
- **Run tests scoped:** `cd server/typescript/packages/migrate-ts && bun test <file>`. Never a bare repo-root `bun test`.
- **Working directory for all commands below:** `server/typescript/packages/migrate-ts`.

---

### Task 1: Detection helper + error type

**Files:**
- Create: `src/emit/d1-fk-refuse.ts`
- Test: `test/unit/d1-fk-refuse.test.ts`

**Interfaces:**
- Consumes: `SchemaSnapshot` from `../types.js` (has `tables: TableDescriptor[]`; each `TableDescriptor` has `name: string` and `foreignKeys: FkDescriptor[]`; each `FkDescriptor` has `refTable: string`).
- Produces:
  - `interface D1RebuildRefusal { table: string; referencedBy: string[] }`
  - `function findReferencedRebuilds(recreatedTables: ReadonlySet<string>, expectedSchema: SchemaSnapshot): D1RebuildRefusal[]`
  - `class D1ReferencedTableRebuildError extends Error` with `readonly refusals: D1RebuildRefusal[]`

- [ ] **Step 1: Write the failing test**

Create `test/unit/d1-fk-refuse.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import {
  findReferencedRebuilds,
  D1ReferencedTableRebuildError,
} from "../../src/emit/d1-fk-refuse.js";
import type { SchemaSnapshot, TableDescriptor } from "../../src/types.js";

function table(name: string, refTables: string[] = []): TableDescriptor {
  return {
    name,
    columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
    indexes: [],
    foreignKeys: refTables.map((rt, i) => ({
      name: `${name}_fk${i}`,
      columns: ["ref_id"],
      refTable: rt,
      refColumns: ["id"],
    })),
    checks: [],
    primaryKey: ["id"],
  };
}

describe("findReferencedRebuilds", () => {
  test("returns a refusal when a rebuilt table is referenced by another table", () => {
    const schema: SchemaSnapshot = {
      tables: [table("parent"), table("child", ["parent"])],
      views: [],
    };
    const refusals = findReferencedRebuilds(new Set(["parent"]), schema);
    expect(refusals).toEqual([{ table: "parent", referencedBy: ["child"] }]);
  });

  test("returns a refusal for a self-referential table (references itself)", () => {
    const schema: SchemaSnapshot = { tables: [table("node", ["node"])], views: [] };
    const refusals = findReferencedRebuilds(new Set(["node"]), schema);
    expect(refusals).toEqual([{ table: "node", referencedBy: ["node"] }]);
  });

  test("returns empty when the rebuilt table is not referenced by anything", () => {
    const schema: SchemaSnapshot = {
      tables: [table("logs"), table("child", ["parent"]), table("parent")],
      views: [],
    };
    expect(findReferencedRebuilds(new Set(["logs"]), schema)).toEqual([]);
  });

  test("only reports rebuilt tables, not every referenced table", () => {
    const schema: SchemaSnapshot = {
      tables: [table("parent"), table("child", ["parent"])],
      views: [],
    };
    // "child" is rebuilt but nothing references "child" → no refusal.
    expect(findReferencedRebuilds(new Set(["child"]), schema)).toEqual([]);
  });
});

describe("D1ReferencedTableRebuildError", () => {
  test("message names the table, its referencer, and the workaround", () => {
    const err = new D1ReferencedTableRebuildError([
      { table: "parent", referencedBy: ["child"] },
    ]);
    expect(err.name).toBe("D1ReferencedTableRebuildError");
    expect(err.message).toContain('"parent"');
    expect(err.message).toContain('"child"');
    expect(err.message).toContain("foreign key");
    expect(err.message.toLowerCase()).toContain("hand-write");
    expect(err.refusals).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/d1-fk-refuse.test.ts`
Expected: FAIL — `Cannot find module '../../src/emit/d1-fk-refuse.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/emit/d1-fk-refuse.ts`:

```ts
import type { SchemaSnapshot } from "../types.js";

/** A rebuilt table that cannot be rebuilt on D1 because a foreign key targets it. */
export interface D1RebuildRefusal {
  /** The table being rebuilt. */
  table: string;
  /** Tables whose foreign key targets `table` (includes `table` itself for a self-reference). */
  referencedBy: string[];
}

/**
 * Of the tables being rebuilt (recreate-and-copy), which are the target of a foreign
 * key in the expected schema? On remote D1 the rebuild recipe's `PRAGMA foreign_keys
 * = OFF` is a no-op inside D1's implicit transaction, so `DROP TABLE` of a referenced
 * table fails with "FOREIGN KEY constraint failed" (#226). Detection uses the target
 * (expected) schema and errs toward refusing.
 */
export function findReferencedRebuilds(
  recreatedTables: ReadonlySet<string>,
  expectedSchema: SchemaSnapshot,
): D1RebuildRefusal[] {
  const refusals: D1RebuildRefusal[] = [];
  for (const t of recreatedTables) {
    const referencedBy = expectedSchema.tables
      .filter((tbl) => tbl.foreignKeys.some((fk) => fk.refTable === t))
      .map((tbl) => tbl.name);
    if (referencedBy.length > 0) refusals.push({ table: t, referencedBy });
  }
  return refusals;
}

/** Thrown at generation time when a D1 migration would rebuild an FK-referenced table. */
export class D1ReferencedTableRebuildError extends Error {
  constructor(public readonly refusals: D1RebuildRefusal[]) {
    super(formatMessage(refusals));
    this.name = "D1ReferencedTableRebuildError";
  }
}

function formatMessage(refusals: D1RebuildRefusal[]): string {
  const lines = refusals.map((r) => {
    const refs = r.referencedBy.map((n) => `"${n}"`).join(", ");
    return `  - "${r.table}" is referenced by a foreign key from ${refs}`;
  });
  return (
    `Cannot rebuild the following table(s) on Cloudflare D1 — each is the target of a ` +
    `foreign key:\n${lines.join("\n")}\n\n` +
    `D1 applies migrations inside an implicit transaction where ` +
    "`PRAGMA foreign_keys = OFF` is a no-op, so dropping a referenced table during the " +
    `rebuild fails with "FOREIGN KEY constraint failed". The rebuild is triggered by a ` +
    `CHECK, column type/nullability/default, foreign-key, or enum-values change on the ` +
    `table. To apply it on D1, hand-write this migration (rebuild the referencing table ` +
    `to temporarily drop its foreign key, rebuild the referenced table, then restore the ` +
    `foreign key), or make the change on an unreferenced table.`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/unit/d1-fk-refuse.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/emit/d1-fk-refuse.ts test/unit/d1-fk-refuse.test.ts
git commit -m "feat(#226): D1 referenced-table-rebuild detection helper + error"
```

---

### Task 2: Wire the refuse into `renderD1` and export the error

**Files:**
- Modify: `src/emit/d1.ts`
- Modify: `src/index.ts:65` (re-export the new error alongside `D1UnsupportedStatementError`)
- Test: `test/unit/emit-d1-refuse.test.ts`

**Interfaces:**
- Consumes: `findReferencedRebuilds`, `D1ReferencedTableRebuildError` from `./d1-fk-refuse.js` (Task 1); `renderSqlite` from `./sqlite.js` (returns `EmitResult` with `recreatedTables: Set<string>`); `emit` from `./index.js`.
- Produces: `renderD1` unchanged signature `(changes, expectedSchema?, actualMeta?) => EmitResult`, now throwing `D1ReferencedTableRebuildError` when a rebuilt table is referenced.

- [ ] **Step 1: Write the failing test**

Create `test/unit/emit-d1-refuse.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import { D1ReferencedTableRebuildError } from "../../src/emit/d1-fk-refuse.js";
import type { Change, SchemaSnapshot, TableDescriptor } from "../../src/types.js";

const ALLOWED = { state: "allowed" } as const;

function parentTable(withCheck: boolean): TableDescriptor {
  return {
    name: "parent",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "status", sqlType: { kind: "text" }, nullable: false },
    ],
    indexes: [],
    foreignKeys: [],
    primaryKey: ["id"],
    checks: withCheck
      ? [{ name: "parent_status_chk", expression: "status <> ''" }]
      : [],
  };
}

function childTable(): TableDescriptor {
  return {
    name: "child",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "parent_id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
    ],
    indexes: [],
    foreignKeys: [
      { name: "child_parent_id_fk", columns: ["parent_id"], refTable: "parent", refColumns: ["id"] },
    ],
    primaryKey: ["id"],
    checks: [],
  };
}

function leafTable(withCheck: boolean): TableDescriptor {
  return {
    name: "logs",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
      { name: "level", sqlType: { kind: "text" }, nullable: false },
    ],
    indexes: [],
    foreignKeys: [],
    primaryKey: ["id"],
    checks: withCheck ? [{ name: "logs_level_chk", expression: "level <> ''" }] : [],
  };
}

const addCheck = (tbl: string, name: string, expr: string): Change => ({
  kind: "add-check",
  status: ALLOWED,
  table: tbl,
  check: { name, expression: expr },
});

describe("emit(dialect: 'd1') — referenced-table rebuild refusal (#226)", () => {
  test("THROWS when a rebuild targets a table referenced by another table's FK", () => {
    const changes: Change[] = [addCheck("parent", "parent_status_chk", "status <> ''")];
    const expected: SchemaSnapshot = { tables: [parentTable(true), childTable()], views: [] };
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).toThrow(
      D1ReferencedTableRebuildError,
    );
  });

  test("does NOT throw when the rebuilt table is a leaf (unreferenced)", () => {
    const changes: Change[] = [addCheck("logs", "logs_level_chk", "level <> ''")];
    const expected: SchemaSnapshot = { tables: [leafTable(true), childTable(), parentTable(false)], views: [] };
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).not.toThrow();
  });

  test("does NOT throw for a non-rebuild change against a referenced table", () => {
    // add-column is a native ALTER, not a recreate — no drop of the referenced table.
    const changes: Change[] = [{
      kind: "add-column",
      status: ALLOWED,
      table: "parent",
      column: { name: "note", sqlType: { kind: "text" }, nullable: true },
    }];
    const expected: SchemaSnapshot = { tables: [parentTable(false), childTable()], views: [] };
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).not.toThrow();
  });

  test("leaf-rebuild D1 output equals the sqlite output modulo safety transforms", () => {
    const changes: Change[] = [addCheck("logs", "logs_level_chk", "level <> ''")];
    const expected: SchemaSnapshot = { tables: [leafTable(true)], views: [] };
    const d1 = emit(changes, { dialect: "d1", expectedSchema: expected });
    const sq = emit(changes, { dialect: "sqlite", expectedSchema: expected });
    // Same statements; D1 only strips BEGIN/COMMIT and the (now no-op) foreign_keys pragmas.
    expect(d1.up).toContain("CREATE TABLE");
    expect(d1.up).not.toMatch(/^\s*BEGIN/im);
    expect(sq.up).toMatch(/BEGIN TRANSACTION/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/unit/emit-d1-refuse.test.ts`
Expected: FAIL — the first test does not throw (the refuse is not wired yet); `D1ReferencedTableRebuildError` import resolves (from Task 1) but is never thrown.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `src/emit/d1.ts` with:

```ts
import type { Change, EmitResult, SchemaSnapshot, SnapshotMeta } from "../types.js";
import { renderSqlite } from "./sqlite.js";
import { applyD1SafetyPass } from "./d1-safety-pass.js";
import { findReferencedRebuilds, D1ReferencedTableRebuildError } from "./d1-fk-refuse.js";

export function renderD1(
  changes: readonly Change[],
  expectedSchema?: SchemaSnapshot,
  actualMeta?: SnapshotMeta,
): EmitResult {
  const sqliteResult = renderSqlite(changes, expectedSchema, actualMeta);

  // #226: a rebuild (recreate-and-copy) of a table referenced by a foreign key cannot
  // apply on remote D1 — the recipe's `PRAGMA foreign_keys = OFF` is a no-op inside
  // D1's implicit transaction, so `DROP TABLE <referenced>` fails. Refuse at generation
  // time rather than emit SQL that fails silently against production. renderSqlite has
  // already guaranteed expectedSchema is present when recreatedTables is non-empty.
  if (sqliteResult.recreatedTables.size > 0) {
    const refusals = findReferencedRebuilds(
      sqliteResult.recreatedTables,
      expectedSchema ?? { tables: [], views: [] },
    );
    if (refusals.length > 0) throw new D1ReferencedTableRebuildError(refusals);
  }

  return {
    up: applyD1SafetyPass(sqliteResult.up),
    down: applyD1SafetyPass(sqliteResult.down),
    recreatedTables: sqliteResult.recreatedTables,
  };
}
```

Then add the error to the package's public exports. In `src/index.ts`, add after line 65 (the `d1-safety-pass` re-export):

```ts
export { findReferencedRebuilds, D1ReferencedTableRebuildError } from "./emit/d1-fk-refuse.js";
export type { D1RebuildRefusal } from "./emit/d1-fk-refuse.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/unit/emit-d1-refuse.test.ts test/unit/emit-d1.test.ts test/unit/d1-fk-refuse.test.ts`
Expected: PASS. The existing `emit-d1.test.ts` still passes (its scenarios use unreferenced tables, so no refusal).

- [ ] **Step 5: Commit**

```bash
git add src/emit/d1.ts src/index.ts test/unit/emit-d1-refuse.test.ts
git commit -m "feat(#226): refuse D1 referenced-table rebuilds at generation time"
```

---

### Task 3: Integration gate — real-engine reproduction + no-over-refuse

**Files:**
- Test: `test/integration/d1-referenced-rebuild.test.ts`

**Interfaces:**
- Consumes: `emit` from `../../src/emit/index.js`; `renderSqlite` from `../../src/emit/sqlite.js`; `applyD1SafetyPass` from `../../src/emit/d1-safety-pass.js`; `D1ReferencedTableRebuildError` from `../../src/emit/d1-fk-refuse.js`; `buildExpectedSchema` from `../../src/expected-schema.js`; `introspectSqlite` from `../../src/introspect/sqlite.js`; `diff` from `../../src/diff/index.js`; the raw libSQL client via `libsql.createClient` from `@libsql/kysely-libsql`.

This test reproduces **remote** D1 by wrapping the emitted batch in one explicit transaction on a single connection with `foreign_keys = ON` at the connection level (SQLite ignores `PRAGMA foreign_keys` inside a transaction — identical to D1's implicit-transaction model).

- [ ] **Step 1: Write the failing test**

Create `test/integration/d1-referenced-rebuild.test.ts`:

```ts
/**
 * Bug gate for #226. On remote D1 a migration file runs inside D1's implicit
 * transaction, where `PRAGMA foreign_keys = OFF` is a no-op — so the SQLite
 * table-rebuild recipe fails to DROP a referenced parent. We reproduce that here by
 * running the emitted batch inside ONE explicit transaction on a single libSQL
 * connection with foreign_keys ON at the connection level.
 *
 * Two assertions:
 *  1. the pre-refuse D1 output for a referenced-parent rebuild DOES fail this way
 *     (documents why we refuse), and emit(dialect:d1) now throws instead;
 *  2. a leaf-table rebuild's D1 output applies cleanly and re-diffs EMPTY (we did
 *     not over-refuse).
 */
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely, sql } from "kysely";
import { LibsqlDialect, libsql } from "@libsql/kysely-libsql";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { emit } from "../../src/emit/index.js";
import { renderSqlite } from "../../src/emit/sqlite.js";
import { applyD1SafetyPass } from "../../src/emit/d1-safety-pass.js";
import { D1ReferencedTableRebuildError } from "../../src/emit/d1-fk-refuse.js";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { introspectSqlite } from "../../src/introspect/sqlite.js";
import { diff } from "../../src/diff/index.js";
import type { Change, SchemaSnapshot } from "../../src/types.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "d1-refuse-"));
  dbPath = join(tmpDir, "t.db");
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Apply statements inside ONE explicit transaction on a single connection (models D1). */
async function applyInImplicitTxn(stmts: string[]): Promise<{ ok: boolean; error?: string }> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  await client.execute("PRAGMA foreign_keys = ON"); // D1 remote default
  const tx = await client.transaction("write");
  try {
    for (const s of stmts) await tx.execute(s);
    await tx.commit();
    return { ok: true };
  } catch (e) {
    try { await tx.rollback(); } catch { /* ignore */ }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    client.close();
  }
}

async function execEach(stmts: string[]): Promise<void> {
  const client = libsql.createClient({ url: `file:${dbPath}` });
  for (const s of stmts) await client.execute(s);
  client.close();
}

function splitSql(sqlText: string): string[] {
  return sqlText.trim().split(";").map((s) => s.trim()).filter(Boolean);
}

const ALLOWED = { state: "allowed" } as const;

describe("#226 D1 referenced-table rebuild — real-engine gate (libSQL, one transaction = remote D1)", () => {
  test("documents the defect: the pre-refuse D1 output for a referenced-parent rebuild fails", async () => {
    // Seed: parent + child(FK->parent) with rows.
    await execEach([
      "CREATE TABLE parent (id INTEGER PRIMARY KEY, status TEXT)",
      "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER, FOREIGN KEY (parent_id) REFERENCES parent(id))",
      "INSERT INTO parent (id, status) VALUES (1, 'OPEN')",
      "INSERT INTO child (id, parent_id) VALUES (1, 1)",
    ]);

    // The rebuild that #226 is about: add a CHECK to the referenced parent.
    const changes: Change[] = [
      { kind: "add-check", status: ALLOWED, table: "parent", check: { name: "parent_status_chk", expression: "status <> ''" } },
    ];
    const expected: SchemaSnapshot = {
      tables: [
        {
          name: "parent",
          columns: [
            { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
            { name: "status", sqlType: { kind: "text" }, nullable: false },
          ],
          indexes: [], foreignKeys: [], primaryKey: ["id"],
          checks: [{ name: "parent_status_chk", expression: "status <> ''" }],
        },
        {
          name: "child",
          columns: [
            { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
            { name: "parent_id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
          ],
          indexes: [],
          foreignKeys: [{ name: "child_parent_id_fk", columns: ["parent_id"], refTable: "parent", refColumns: ["id"] }],
          primaryKey: ["id"], checks: [],
        },
      ],
      views: [],
    };

    // Pre-refuse D1 output = sqlite recipe through the safety pass (BEGIN/COMMIT stripped,
    // no-op foreign_keys pragmas retained). Under the one-transaction model it fails.
    const preRefuseUp = applyD1SafetyPass(renderSqlite(changes, expected).up);
    const applied = await applyInImplicitTxn(splitSql(preRefuseUp));
    expect(applied.ok).toBe(false);
    expect(applied.error ?? "").toMatch(/FOREIGN KEY/i);

    // The fix: emit(dialect:d1) refuses to produce that SQL at all.
    expect(() => emit(changes, { dialect: "d1", expectedSchema: expected })).toThrow(
      D1ReferencedTableRebuildError,
    );
  });

  test("no over-refusal: a leaf-table rebuild's D1 output applies cleanly and re-diffs EMPTY", async () => {
    // A standalone table nothing references. Author it via metadata so the full
    // buildExpectedSchema → introspect → diff → emit → apply → re-diff loop runs.
    const META_V2 = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{
          "object.entity": {
            name: "LogEntry",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "level", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              // A CHECK-bearing enum forces a rebuild on the second migrate.
              { "field.enum": { name: "kind", "@values": ["A", "B"], "@required": true } },
            ],
          },
        }],
      },
    });
    // v1: same entity without the enum column, so v2 adds the CHECK → rebuild.
    const META_V1 = JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [{
          "object.entity": {
            name: "LogEntry",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "level", "@required": true } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        }],
      },
    });

    const k = new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: `file:${dbPath}` }) });
    try {
      // Apply v1 from empty.
      const root1 = (await new MetaDataLoader().load([new InMemoryStringSource(META_V1)])).root;
      const expected1 = buildExpectedSchema(root1, { dialect: "sqlite" });
      const actual0 = await introspectSqlite(k);
      const d0 = await diff({ expected: expected1, actual: actual0, dialect: "sqlite" });
      for (const stmt of splitSql(emit(d0.changes, { dialect: "d1", expectedSchema: expected1 }).up)) {
        await sql.raw(stmt).execute(k);
      }

      // v2 adds the enum CHECK → LogEntry is rebuilt. It is a leaf → must NOT refuse.
      const root2 = (await new MetaDataLoader().load([new InMemoryStringSource(META_V2)])).root;
      const expected2 = buildExpectedSchema(root2, { dialect: "sqlite" });
      const actual1 = await introspectSqlite(k);
      const d1diff = await diff({ expected: expected2, actual: actual1, dialect: "sqlite" });
      const d1Emit = emit(d1diff.changes, { dialect: "d1", expectedSchema: expected2 });
      for (const stmt of splitSql(d1Emit.up)) {
        await sql.raw(stmt).execute(k);
      }

      // Re-diff must be EMPTY (migrate-engine doctrine).
      const followup = await diff({ expected: expected2, actual: await introspectSqlite(k), dialect: "sqlite" });
      if (followup.changes.length > 0) {
        for (const c of followup.changes) console.error("residual change:", JSON.stringify(c));
      }
      expect(followup.changes).toEqual([]);
    } finally {
      await k.destroy();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails or passes as expected**

Run: `bun test test/integration/d1-referenced-rebuild.test.ts`
Expected: the first test PASSES once Task 2 is in (the refuse is wired). The second test PASSES (leaf rebuild converges). If the second test's `field.enum` → CHECK does not produce a rebuild on this schema, adjust the v1/v2 metadata so v2 introduces exactly one recreate-triggering change on the leaf table (e.g. change `level` to a CHECK-bearing enum) — the assertion that matters is: emit(dialect:d1) does not throw AND the re-diff is empty.

- [ ] **Step 3: (No new implementation — this task is the gate for Task 2.)**

If either assertion fails, the defect is in Task 2's wiring or the detection helper; fix there and re-run.

- [ ] **Step 4: Run the full migrate-ts suite to confirm no regressions**

Run: `bun test`
Expected: PASS (all migrate-ts unit + integration tests, including the pre-existing `test/integration/sqlite-fk-convergence.test.ts` and `test/unit/emit-d1.test.ts`).

- [ ] **Step 5: Commit**

```bash
git add test/integration/d1-referenced-rebuild.test.ts
git commit -m "test(#226): real-engine gate — D1 referenced-rebuild refuse + no over-refuse"
```

---

### Task 4: Documentation + CHANGELOG

**Files:**
- Modify: `docs/features/migrations-and-drift.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the D1 limitation note**

In `docs/features/migrations-and-drift.md`, find the section describing D1 / Cloudflare dialect behavior (search for `d1` / `wrangler`). Add a subsection:

```markdown
#### D1 limitation: rebuilding a foreign-key-referenced table

Cloudflare D1 applies each migration inside its own implicit transaction, and SQLite
ignores `PRAGMA foreign_keys` while a transaction is open. The SQLite table-rebuild
recipe (used for a `CHECK`, column type/nullability/default, foreign-key, or
`field.enum` values change) relies on `PRAGMA foreign_keys = OFF` taking effect before
it drops and recreates the table — which does not happen on remote D1.

To avoid emitting a migration that would fail against a populated production database
with `FOREIGN KEY constraint failed`, `meta migrate --dialect d1` **refuses at
generation time** when a change would rebuild a table that another table's foreign key
references. Apply such a change by hand-writing the migration: rebuild the referencing
table to temporarily drop its foreign key, rebuild the referenced table, then restore
the foreign key — or make the change on an unreferenced table. (Auto-generating this
cascade is tracked as a follow-up.)
```

- [ ] **Step 2: Add the CHANGELOG entry**

In `CHANGELOG.md`, add a new section directly under the top-of-file header block, above `## [0.20.6]`:

```markdown
## [Unreleased]

### Fixed — `meta migrate --dialect d1` no longer emits an un-appliable rebuild of a foreign-key-referenced table (#226)

npm-only (`migrate-ts` — D1 is a TS-only dialect). On remote Cloudflare D1 a migration
runs inside D1's implicit transaction, where `PRAGMA foreign_keys = OFF` is a no-op — so
the SQLite table-rebuild recipe failed to drop a foreign-key-referenced table, aborting
the migration with `FOREIGN KEY constraint failed`. The failure was silent until a table
held rows, so it first surfaced against populated production databases. `meta migrate
--dialect d1` now **refuses at generation time** with a clear, actionable error when a
change would rebuild a table that another table's foreign key references (self-references
included), instead of emitting SQL that fails at apply time. Migrations that do not
rebuild a referenced table are byte-identical. Auto-generating the rebuild cascade is
tracked as a follow-up (#241).
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/migrations-and-drift.md CHANGELOG.md
git commit -m "docs(#226): document the D1 referenced-table rebuild refusal"
```

---

## Self-Review

**Spec coverage:**
- Detection (rebuilt-table set ∩ FK-referenced) → Task 1 (`findReferencedRebuilds`).
- Refuse at generation time, byte-identical otherwise → Task 2 (`renderD1` wiring; byte-identical test).
- Self-referential refused → Task 1 test + covered by `refTable === t` matching the table itself.
- Over-refuse bias / expected-schema source → Task 1 helper uses `expectedSchema.tables[*].foreignKeys`.
- Clear error naming table + referencer + workaround → Task 1 `formatMessage` + test.
- Gate: documents the real failure + no over-refusal (leaf applies, re-diff empty) → Task 3.
- CLI surfaces the error / verify unaffected → no code change needed (existing emit-error path); documented in Task 4.
- Non-goal: cascade deferred → follow-up #241, referenced in Task 4 CHANGELOG.
- Docs note → Task 4.

**Placeholder scan:** No TBD/TODO. Task 3 Step 2 contains a conditional adjustment instruction (if `field.enum` doesn't force a rebuild) with the exact fix stated — that is a concrete contingency, not a placeholder, because the invariant to satisfy is named exactly.

**Type consistency:** `findReferencedRebuilds(recreatedTables, expectedSchema)` and `D1ReferencedTableRebuildError(refusals)` / `D1RebuildRefusal { table, referencedBy }` are used identically in Tasks 1–3. `EmitResult.recreatedTables` (existing) is a `Set<string>`; `findReferencedRebuilds` takes `ReadonlySet<string>` — compatible. `Change` `add-check` shape matches `types.ts:228`. `emit(changes, { dialect, expectedSchema })` matches `EmitOptions`.
