# Migration apply+tracking runner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Postgres apply+tracking runner for the shared TS migrate engine — apply generated `up.sql`/`down.sql` against Postgres, track history in a **pluggable, multi-tenant `HistoryStore`**, with advisory locking and rollback.

**Architecture:** A small, DB-agnostic apply/rollback orchestration (lock → ensure → compute pending → per-migration transactional apply → record) tested with fakes, plus Postgres implementations (`PgHistoryStore`, `PgExecutor`) tested with `pg-mem` (and a real PG when `MIGRATE_TS_PG_URL` is set). Realizes [ADR-0016](../../../spec/decisions/ADR-0016-build-migration-apply-runner.md) + the runner design (`docs/superpowers/specs/2026-05-30-migration-runner-design.md`). Postgres-first; checksum-validate / baseline / drift / info-states / output-adapters are a follow-on plan.

**Tech Stack:** TypeScript (Bun test runner), `@metaobjectsdev/migrate-ts`, `pg` (node-postgres), `pg-mem` (in-process Postgres for tests), Node `crypto`.

---

## File structure

All under `server/typescript/packages/migrate-ts/`:

- `src/runner/checksum.ts` — `contentChecksum(sql)`: content-normalized SHA-256 (less brittle than path/whitespace-sensitive hashing).
- `src/runner/migration-source.ts` — `Migration` type + `loadMigrations(dir)`: read timestamped append-only migration dirs from disk.
- `src/runner/history-store.ts` — `AppliedRow`, `HistoryStore` interface, `InMemoryHistoryStore` (for testing the loop).
- `src/runner/apply.ts` — `SqlExecutor` interface, `applyMigrations`, `rollbackTo`, `pendingVersions`.
- `src/runner/pg-history-store.ts` — `PgHistoryStore` (configurable `{schema, table, lockName}`; PG advisory lock).
- `src/runner/pg-executor.ts` — `PgExecutor` (per-migration `BEGIN/COMMIT/ROLLBACK`).
- `src/runner/index.ts` — re-exports.
- Tests: `test/runner/*.test.ts` (pure, no DB) and `test/integration/runner-pg.test.ts` (`pg-mem` + real-PG-gated).

---

### Task 1: content-normalized checksum

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/runner/checksum.ts`
- Test: `server/typescript/packages/migrate-ts/test/runner/checksum.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/runner/checksum.test.ts
import { test, expect, describe } from "bun:test";
import { contentChecksum } from "../../src/runner/checksum.js";

describe("contentChecksum", () => {
  test("is stable for identical content", () => {
    expect(contentChecksum("CREATE TABLE a();")).toBe(contentChecksum("CREATE TABLE a();"));
  });
  test("ignores trailing whitespace, CRLF, and leading/trailing blank lines", () => {
    const a = "CREATE TABLE a();\nCREATE TABLE b();";
    const b = "\r\n  \nCREATE TABLE a();   \r\nCREATE TABLE b();\t\n\n";
    expect(contentChecksum(b)).toBe(contentChecksum(a));
  });
  test("differs when meaningful content differs", () => {
    expect(contentChecksum("CREATE TABLE a();")).not.toBe(contentChecksum("CREATE TABLE b();"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/checksum.test.ts`
Expected: FAIL — cannot find module `../../src/runner/checksum.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runner/checksum.ts
import { createHash } from "node:crypto";

/**
 * Content-normalized checksum of a migration's SQL. Normalizes CRLF→LF, strips
 * per-line trailing whitespace, and trims leading/trailing blank lines — so a
 * reformat does not invalidate an applied migration (deliberately less brittle
 * than Flyway's path/whitespace-sensitive hash).
 */
export function contentChecksum(sql: string): string {
  const normalized = sql
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/checksum.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/runner/checksum.ts server/typescript/packages/migrate-ts/test/runner/checksum.test.ts
git commit -m "feat(migrate-ts): runner — content-normalized migration checksum"
```

---

### Task 2: migration-source loader

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/runner/migration-source.ts`
- Test: `server/typescript/packages/migrate-ts/test/runner/migration-source.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/runner/migration-source.test.ts
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMigrations } from "../../src/runner/migration-source.js";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mig-"));
  await mkdir(join(dir, "20260101120000-create-a"));
  await writeFile(join(dir, "20260101120000-create-a", "up.sql"), "CREATE TABLE a();");
  await writeFile(join(dir, "20260101120000-create-a", "down.sql"), "DROP TABLE a;");
  await mkdir(join(dir, "20260102120000-create-b"));
  await writeFile(join(dir, "20260102120000-create-b", "up.sql"), "CREATE TABLE b();");
  // no down.sql for b
  await writeFile(join(dir, "README.md"), "not a migration");
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("loadMigrations", () => {
  test("loads timestamped dirs sorted by version; non-migration entries ignored", async () => {
    const migs = await loadMigrations(dir);
    expect(migs.map((m) => m.version)).toEqual(["20260101120000", "20260102120000"]);
    expect(migs[0].name).toBe("create-a");
    expect(migs[0].upSql).toBe("CREATE TABLE a();");
    expect(migs[0].downSql).toBe("DROP TABLE a;");
    expect(migs[1].downSql).toBe(""); // missing down.sql → empty
  });
  test("returns [] for a missing directory", async () => {
    expect(await loadMigrations(join(dir, "nope"))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/migration-source.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runner/migration-source.ts
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface Migration {
  /** Leading 14-digit timestamp from the dir name; the sortable version. */
  version: string;
  /** Slug after the timestamp. */
  name: string;
  /** Absolute path to the migration directory. */
  dir: string;
  upSql: string;
  /** Empty string when no down.sql exists. */
  downSql: string;
}

/** Load timestamped append-only migration dirs (`<14-digits>-<slug>/up.sql`). */
export async function loadMigrations(dir: string): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const migs: Migration[] = [];
  for (const entry of entries) {
    const m = /^(\d{14})-(.+)$/.exec(entry);
    if (!m) continue;
    const migDir = join(dir, entry);
    const upSql = await readFile(join(migDir, "up.sql"), "utf8");
    let downSql = "";
    try {
      downSql = await readFile(join(migDir, "down.sql"), "utf8");
    } catch {
      /* down.sql optional */
    }
    migs.push({ version: m[1], name: m[2], dir: migDir, upSql, downSql });
  }
  return migs.sort((a, b) => a.version.localeCompare(b.version));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/migration-source.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/runner/migration-source.ts server/typescript/packages/migrate-ts/test/runner/migration-source.test.ts
git commit -m "feat(migrate-ts): runner — load timestamped append-only migrations from disk"
```

---

### Task 3: HistoryStore interface + InMemoryHistoryStore

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/runner/history-store.ts`
- Test: `server/typescript/packages/migrate-ts/test/runner/in-memory-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/runner/in-memory-store.test.ts
import { test, expect, describe } from "bun:test";
import { InMemoryHistoryStore } from "../../src/runner/history-store.js";

function row(version: string, success = true) {
  return { version, name: "x", checksum: "c", appliedAt: "2026-01-01T00:00:00.000Z", executionMs: 1, success };
}

describe("InMemoryHistoryStore", () => {
  test("records, lists sorted, and unrecords", async () => {
    const s = new InMemoryHistoryStore();
    await s.ensure();
    await s.record(row("20260102000000"));
    await s.record(row("20260101000000"));
    expect((await s.applied()).map((r) => r.version)).toEqual(["20260101000000", "20260102000000"]);
    await s.unrecord("20260101000000");
    expect((await s.applied()).map((r) => r.version)).toEqual(["20260102000000"]);
  });
  test("record replaces an existing version", async () => {
    const s = new InMemoryHistoryStore();
    await s.record(row("20260101000000", false));
    await s.record(row("20260101000000", true));
    const rows = await s.applied();
    expect(rows).toHaveLength(1);
    expect(rows[0].success).toBe(true);
  });
  test("lock is exclusive within the instance", async () => {
    const s = new InMemoryHistoryStore();
    await s.acquireLock();
    await expect(s.acquireLock()).rejects.toThrow();
    await s.releaseLock();
    await s.acquireLock(); // ok again
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/in-memory-store.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runner/history-store.ts

/** One row of applied-migration history. */
export interface AppliedRow {
  version: string;
  name: string;
  checksum: string;
  appliedAt: string;   // ISO 8601
  executionMs: number;
  success: boolean;    // false = a failed (dirty) apply
}

/**
 * Pluggable migration-history tracking. The override point that makes multi-app /
 * multi-tenant possible: a per-tenant store instance (its own schema/table/lock)
 * gives each app an independent lineage in one physical database.
 */
export interface HistoryStore {
  ensure(): Promise<void>;
  applied(): Promise<AppliedRow[]>;            // ordered by version ASC
  record(row: AppliedRow): Promise<void>;      // upsert by version
  unrecord(version: string): Promise<void>;
  acquireLock(): Promise<void>;
  releaseLock(): Promise<void>;
}

/** In-memory store for unit-testing the apply/rollback loop without a database. */
export class InMemoryHistoryStore implements HistoryStore {
  private rows: AppliedRow[] = [];
  private locked = false;
  async ensure(): Promise<void> {}
  async applied(): Promise<AppliedRow[]> {
    return [...this.rows].sort((a, b) => a.version.localeCompare(b.version));
  }
  async record(row: AppliedRow): Promise<void> {
    this.rows = this.rows.filter((r) => r.version !== row.version);
    this.rows.push(row);
  }
  async unrecord(version: string): Promise<void> {
    this.rows = this.rows.filter((r) => r.version !== version);
  }
  async acquireLock(): Promise<void> {
    if (this.locked) throw new Error("InMemoryHistoryStore: already locked");
    this.locked = true;
  }
  async releaseLock(): Promise<void> {
    this.locked = false;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/in-memory-store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/runner/history-store.ts server/typescript/packages/migrate-ts/test/runner/in-memory-store.test.ts
git commit -m "feat(migrate-ts): runner — HistoryStore interface + in-memory store"
```

---

### Task 4: apply loop (SqlExecutor + applyMigrations)

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/runner/apply.ts`
- Test: `server/typescript/packages/migrate-ts/test/runner/apply.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/runner/apply.test.ts
import { test, expect, describe } from "bun:test";
import { applyMigrations, type SqlExecutor } from "../../src/runner/apply.js";
import { InMemoryHistoryStore } from "../../src/runner/history-store.js";
import type { Migration } from "../../src/runner/migration-source.js";

function mig(version: string, up: string, down = ""): Migration {
  return { version, name: `m${version}`, dir: `/tmp/${version}`, upSql: up, downSql: down };
}

class RecordingExecutor implements SqlExecutor {
  ran: string[] = [];
  constructor(private failOn?: string) {}
  async runInTransaction(sql: string): Promise<void> {
    if (this.failOn && sql.includes(this.failOn)) throw new Error("boom");
    this.ran.push(sql);
  }
}

describe("applyMigrations", () => {
  test("applies pending in order, records success, skips already-applied", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [mig("20260101000000", "CREATE A"), mig("20260102000000", "CREATE B")];
    const r1 = await applyMigrations(migs, store, exec);
    expect(r1.applied).toEqual(["20260101000000", "20260102000000"]);
    expect(exec.ran).toEqual(["CREATE A", "CREATE B"]);
    // second run: nothing pending
    const r2 = await applyMigrations(migs, store, exec);
    expect(r2.applied).toEqual([]);
    expect(exec.ran).toEqual(["CREATE A", "CREATE B"]);
  });

  test("dry-run reports pending without executing", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [mig("20260101000000", "CREATE A")];
    const r = await applyMigrations(migs, store, exec, { dryRun: true });
    expect(r.applied).toEqual(["20260101000000"]);
    expect(exec.ran).toEqual([]);
    expect(await store.applied()).toEqual([]); // nothing recorded
  });

  test("on failure: records success=false, stops, does not apply later migrations", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor("CREATE B");
    const migs = [mig("20260101000000", "CREATE A"), mig("20260102000000", "CREATE B"), mig("20260103000000", "CREATE C")];
    await expect(applyMigrations(migs, store, exec)).rejects.toThrow("boom");
    expect(exec.ran).toEqual(["CREATE A"]); // C never attempted
    const rows = await store.applied();
    expect(rows.find((r) => r.version === "20260101000000")?.success).toBe(true);
    expect(rows.find((r) => r.version === "20260102000000")?.success).toBe(false);
    expect(rows.find((r) => r.version === "20260103000000")).toBeUndefined();
  });

  test("releases the lock even on failure", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor("CREATE A");
    await expect(applyMigrations([mig("20260101000000", "CREATE A")], store, exec)).rejects.toThrow();
    // lock must be free now
    await store.acquireLock();
    await store.releaseLock();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/apply.test.ts`
Expected: FAIL — cannot find module `../../src/runner/apply.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runner/apply.ts
import { contentChecksum } from "./checksum.js";
import type { HistoryStore } from "./history-store.js";
import type { Migration } from "./migration-source.js";

/** Executes one migration's SQL in its own transaction; throws on error. */
export interface SqlExecutor {
  runInTransaction(sql: string): Promise<void>;
}

export interface ApplyResult {
  applied: string[];   // versions applied this run (or would-apply, for dryRun)
  skipped: string[];   // versions already applied
}

/** Versions already applied successfully. */
function appliedVersionSet(rows: { version: string; success: boolean }[]): Set<string> {
  return new Set(rows.filter((r) => r.success).map((r) => r.version));
}

export async function applyMigrations(
  migrations: Migration[],
  store: HistoryStore,
  executor: SqlExecutor,
  opts: { dryRun?: boolean } = {},
): Promise<ApplyResult> {
  await store.acquireLock();
  try {
    await store.ensure();
    const done = appliedVersionSet(await store.applied());
    const pending = migrations.filter((m) => !done.has(m.version));
    const result: ApplyResult = { applied: [], skipped: [...done] };
    for (const m of pending) {
      if (opts.dryRun) {
        result.applied.push(m.version);
        continue;
      }
      const start = Date.now();
      try {
        await executor.runInTransaction(m.upSql);
      } catch (e) {
        await store.record(failRow(m, start));
        throw e;
      }
      await store.record(successRow(m, start));
      result.applied.push(m.version);
    }
    return result;
  } finally {
    await store.releaseLock();
  }
}

function successRow(m: Migration, start: number) {
  return { version: m.version, name: m.name, checksum: contentChecksum(m.upSql), appliedAt: new Date().toISOString(), executionMs: Date.now() - start, success: true };
}
function failRow(m: Migration, start: number) {
  return { ...successRow(m, start), success: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/apply.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/runner/apply.ts server/typescript/packages/migrate-ts/test/runner/apply.test.ts
git commit -m "feat(migrate-ts): runner — transactional apply loop with failure recording + dry-run"
```

---

### Task 5: rollback (rollbackTo)

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/runner/apply.ts` (add `rollbackTo`)
- Test: `server/typescript/packages/migrate-ts/test/runner/rollback.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/runner/rollback.test.ts
import { test, expect, describe } from "bun:test";
import { applyMigrations, rollbackTo, type SqlExecutor } from "../../src/runner/apply.js";
import { InMemoryHistoryStore } from "../../src/runner/history-store.js";
import type { Migration } from "../../src/runner/migration-source.js";

function mig(version: string, up: string, down: string): Migration {
  return { version, name: `m${version}`, dir: `/tmp/${version}`, upSql: up, downSql: down };
}
class RecordingExecutor implements SqlExecutor {
  ran: string[] = [];
  async runInTransaction(sql: string): Promise<void> { this.ran.push(sql); }
}

describe("rollbackTo", () => {
  test("rolls back newer-than-target in reverse order and unrecords", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [
      mig("20260101000000", "CREATE A", "DROP A"),
      mig("20260102000000", "CREATE B", "DROP B"),
      mig("20260103000000", "CREATE C", "DROP C"),
    ];
    await applyMigrations(migs, store, exec);
    exec.ran = [];
    const r = await rollbackTo("20260101000000", migs, store, exec);
    expect(r.rolledBack).toEqual(["20260103000000", "20260102000000"]); // reverse
    expect(exec.ran).toEqual(["DROP C", "DROP B"]);
    expect((await store.applied()).map((x) => x.version)).toEqual(["20260101000000"]);
  });

  test("target null rolls everything back", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [mig("20260101000000", "CREATE A", "DROP A")];
    await applyMigrations(migs, store, exec);
    const r = await rollbackTo(null, migs, store, exec);
    expect(r.rolledBack).toEqual(["20260101000000"]);
    expect(await store.applied()).toEqual([]);
  });

  test("throws when down.sql is empty", async () => {
    const store = new InMemoryHistoryStore();
    const exec = new RecordingExecutor();
    const migs = [mig("20260101000000", "CREATE A", "")];
    await applyMigrations(migs, store, exec);
    await expect(rollbackTo(null, migs, store, exec)).rejects.toThrow(/down\.sql is empty/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/rollback.test.ts`
Expected: FAIL — `rollbackTo` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/runner/apply.ts`:

```ts
export interface RollbackResult {
  rolledBack: string[];   // versions rolled back, in the order applied (reverse-chronological)
}

/**
 * Roll back every applied migration newer than `targetVersion` (or all, when
 * `targetVersion` is null), in reverse order, running each `down.sql` then
 * unrecording it. A migration's schema `down` is generated; a data migration's
 * `down` must be hand-authored — an empty `down.sql` throws rather than silently
 * skipping.
 */
export async function rollbackTo(
  targetVersion: string | null,
  migrations: Migration[],
  store: HistoryStore,
  executor: SqlExecutor,
): Promise<RollbackResult> {
  await store.acquireLock();
  try {
    const applied = (await store.applied()).filter((r) => r.success);
    const toRollback = applied
      .filter((r) => targetVersion === null || r.version > targetVersion)
      .sort((a, b) => b.version.localeCompare(a.version));
    const byVersion = new Map(migrations.map((m) => [m.version, m]));
    const rolledBack: string[] = [];
    for (const r of toRollback) {
      const m = byVersion.get(r.version);
      if (!m) throw new Error(`rollback ${r.version}: migration files missing`);
      if (!m.downSql.trim()) throw new Error(`rollback ${r.version}: down.sql is empty (data migrations need a hand-authored down)`);
      await executor.runInTransaction(m.downSql);
      await store.unrecord(r.version);
      rolledBack.push(r.version);
    }
    return { rolledBack };
  } finally {
    await store.releaseLock();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/rollback.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/runner/apply.ts server/typescript/packages/migrate-ts/test/runner/rollback.test.ts
git commit -m "feat(migrate-ts): runner — rollbackTo (reverse-order down + unrecord)"
```

---

### Task 6: PgExecutor (transactional SQL execution)

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/runner/pg-executor.ts`
- Test: `server/typescript/packages/migrate-ts/test/integration/runner-pg.test.ts` (new; uses `pg-mem`)

- [ ] **Step 1: Write the failing test**

```ts
// test/integration/runner-pg.test.ts
import { test, expect, describe } from "bun:test";
import { newDb } from "pg-mem";
import { PgExecutor } from "../../src/runner/pg-executor.js";

/** A pg-mem-backed Pool-compatible object. */
function memPool() {
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return new Pool();
}

describe("PgExecutor (pg-mem)", () => {
  test("runs SQL and commits", async () => {
    const pool = memPool();
    const exec = new PgExecutor(pool);
    await exec.runInTransaction("CREATE TABLE widgets (id int primary key);");
    await exec.runInTransaction("INSERT INTO widgets (id) VALUES (1);");
    const r = await pool.query("SELECT count(*)::int AS n FROM widgets;");
    expect(r.rows[0].n).toBe(1);
    await pool.end();
  });

  test("rolls back on error (no partial apply)", async () => {
    const pool = memPool();
    const exec = new PgExecutor(pool);
    await exec.runInTransaction("CREATE TABLE t (id int primary key);");
    await expect(
      exec.runInTransaction("INSERT INTO t (id) VALUES (1); INSERT INTO t (id) VALUES (1);"),
    ).rejects.toThrow();
    const r = await pool.query("SELECT count(*)::int AS n FROM t;");
    expect(r.rows[0].n).toBe(0); // both inserts rolled back
    await pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/integration/runner-pg.test.ts`
Expected: FAIL — cannot find module `../../src/runner/pg-executor.js`. (If `pg-mem` is missing, add it: `bun add -d pg-mem` in `server/typescript/packages/migrate-ts` — it is already used by `test/integration/postgres-introspect.test.ts`, so it should resolve.)

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runner/pg-executor.ts
import type { Pool } from "pg";
import type { SqlExecutor } from "./apply.js";

/** Executes a migration's SQL in a single BEGIN/COMMIT transaction (ROLLBACK on error). */
export class PgExecutor implements SqlExecutor {
  constructor(private readonly pool: Pool) {}
  async runInTransaction(sql: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch { /* connection may be dead */ }
      throw e;
    } finally {
      client.release();
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/migrate-ts && bun test test/integration/runner-pg.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/runner/pg-executor.ts server/typescript/packages/migrate-ts/test/integration/runner-pg.test.ts
git commit -m "feat(migrate-ts): runner — PgExecutor (transactional migration execution)"
```

---

### Task 7: PgHistoryStore — table tracking (configurable schema/table)

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/runner/pg-history-store.ts`
- Test: append to `server/typescript/packages/migrate-ts/test/integration/runner-pg.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/integration/runner-pg.test.ts`:

```ts
import { PgHistoryStore } from "../../src/runner/pg-history-store.js";

describe("PgHistoryStore tracking (pg-mem)", () => {
  function memPool2() {
    const db = newDb();
    const { Pool } = db.adapters.createPg();
    return new Pool();
  }
  const sample = (v: string, success = true) => ({
    version: v, name: "m", checksum: "c", appliedAt: "2026-01-01T00:00:00.000Z", executionMs: 5, success,
  });

  test("ensure creates the table; record/applied/unrecord round-trip", async () => {
    const pool = memPool2();
    const store = new PgHistoryStore(pool, { schema: "public", table: "mo_migrations" });
    await store.ensure();
    await store.record(sample("20260102000000"));
    await store.record(sample("20260101000000"));
    expect((await store.applied()).map((r) => r.version)).toEqual(["20260101000000", "20260102000000"]);
    await store.unrecord("20260101000000");
    expect((await store.applied()).map((r) => r.version)).toEqual(["20260102000000"]);
    await pool.end();
  });

  test("two stores with different table names are independent (multi-tenant)", async () => {
    const pool = memPool2();
    const a = new PgHistoryStore(pool, { schema: "public", table: "tenant_a_migrations" });
    const b = new PgHistoryStore(pool, { schema: "public", table: "tenant_b_migrations" });
    await a.ensure();
    await b.ensure();
    await a.record(sample("20260101000000"));
    expect((await a.applied()).map((r) => r.version)).toEqual(["20260101000000"]);
    expect(await b.applied()).toEqual([]); // independent lineage
    await pool.end();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/integration/runner-pg.test.ts`
Expected: FAIL — cannot find module `../../src/runner/pg-history-store.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/runner/pg-history-store.ts
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AppliedRow, HistoryStore } from "./history-store.js";

export interface PgHistoryStoreOptions {
  /** Schema holding the history table + (by default) the lock scope. Default "public". */
  schema?: string;
  /** History table name. Default "metaobjects_migrations". */
  table?: string;
  /** Advisory-lock name. Default `${schema}.${table}`. Override to share/separate lock scope. */
  lockName?: string;
}

/**
 * Postgres history store. Per-tenant isolation = a per-tenant instance with its own
 * {schema, table, lockName} — independent lineage + lock scope in one physical DB.
 */
export class PgHistoryStore implements HistoryStore {
  private readonly schema: string;
  private readonly table: string;
  private readonly lockKey: string; // 64-bit signed, as a decimal string for $1::bigint
  private lockClient: PoolClient | null = null;

  constructor(private readonly pool: Pool, opts: PgHistoryStoreOptions = {}) {
    this.schema = opts.schema ?? "public";
    this.table = opts.table ?? "metaobjects_migrations";
    this.lockKey = advisoryKey(opts.lockName ?? `${this.schema}.${this.table}`);
  }

  private q(): string {
    return `"${this.schema}"."${this.table}"`;
  }

  async ensure(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS ${this.q()} (
         version TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         checksum TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL,
         execution_ms INTEGER NOT NULL,
         success BOOLEAN NOT NULL
       )`,
    );
  }

  async applied(): Promise<AppliedRow[]> {
    const r = await this.pool.query(
      `SELECT version, name, checksum, applied_at, execution_ms, success
         FROM ${this.q()} ORDER BY version ASC`,
    );
    return r.rows.map((row: Record<string, unknown>) => ({
      version: String(row.version),
      name: String(row.name),
      checksum: String(row.checksum),
      appliedAt: new Date(row.applied_at as string).toISOString(),
      executionMs: Number(row.execution_ms),
      success: Boolean(row.success),
    }));
  }

  async record(row: AppliedRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.q()} (version, name, checksum, applied_at, execution_ms, success)
         VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (version) DO UPDATE SET
         name = EXCLUDED.name, checksum = EXCLUDED.checksum,
         applied_at = EXCLUDED.applied_at, execution_ms = EXCLUDED.execution_ms,
         success = EXCLUDED.success`,
      [row.version, row.name, row.checksum, row.appliedAt, row.executionMs, row.success],
    );
  }

  async unrecord(version: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${this.q()} WHERE version = $1`, [version]);
  }

  async acquireLock(): Promise<void> {
    this.lockClient = await this.pool.connect();
    // Session-level advisory lock (not transaction-level) so CREATE INDEX
    // CONCURRENTLY in a migration does not deadlock against the lock.
    await this.lockClient.query("SELECT pg_advisory_lock($1::bigint)", [this.lockKey]);
  }

  async releaseLock(): Promise<void> {
    if (!this.lockClient) return;
    try {
      await this.lockClient.query("SELECT pg_advisory_unlock($1::bigint)", [this.lockKey]);
    } finally {
      this.lockClient.release();
      this.lockClient = null;
    }
  }
}

/** Stable 64-bit signed advisory-lock key (decimal string) from a lock name. */
function advisoryKey(name: string): string {
  const hash = createHash("sha256").update(name).digest();
  return hash.readBigInt64BE(0).toString();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/migrate-ts && bun test test/integration/runner-pg.test.ts`
Expected: PASS (the two new tracking tests; `pg-mem` runs `ensure`/`record`/`applied`/`unrecord`. The advisory-lock methods are exercised in Task 8 against a real PG.)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/runner/pg-history-store.ts server/typescript/packages/migrate-ts/test/integration/runner-pg.test.ts
git commit -m "feat(migrate-ts): runner — PgHistoryStore (configurable schema/table; multi-tenant)"
```

---

### Task 8: end-to-end apply + rollback + advisory lock against real Postgres

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/runner/index.ts`
- Test: append a real-PG-gated block to `server/typescript/packages/migrate-ts/test/integration/runner-pg.test.ts`

This block runs only when `MIGRATE_TS_PG_URL` is set (a real Postgres, e.g. from `scripts/integration-test.sh`), because `pg-mem` does not implement `pg_advisory_lock`.

- [ ] **Step 1: Write the failing test**

Append to `test/integration/runner-pg.test.ts`:

```ts
import { Pool } from "pg";
import { applyMigrations, rollbackTo } from "../../src/runner/apply.js";
import { PgExecutor } from "../../src/runner/pg-executor.js";
import type { Migration } from "../../src/runner/migration-source.js";

const REAL_PG = process.env.MIGRATE_TS_PG_URL;
const realDescribe = REAL_PG ? describe : describe.skip;

realDescribe("runner end-to-end (real Postgres)", () => {
  const migs: Migration[] = [
    { version: "20260101000000", name: "create-widgets", dir: "/t/1",
      upSql: 'CREATE TABLE "widgets" ("id" int primary key);', downSql: 'DROP TABLE "widgets";' },
    { version: "20260102000000", name: "add-label", dir: "/t/2",
      upSql: 'ALTER TABLE "widgets" ADD COLUMN "label" text;', downSql: 'ALTER TABLE "widgets" DROP COLUMN "label";' },
  ];

  test("apply creates tables + history rows; rollback reverts; advisory lock round-trips", async () => {
    const pool = new Pool({ connectionString: REAL_PG });
    try {
      // clean slate
      await pool.query('DROP TABLE IF EXISTS "widgets"');
      await pool.query("DROP TABLE IF EXISTS metaobjects_migrations");

      const store = new PgHistoryStore(pool);
      const exec = new PgExecutor(pool);

      const applied = await applyMigrations(migs, store, exec);
      expect(applied.applied).toEqual(["20260101000000", "20260102000000"]);

      const cols = await pool.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'widgets' ORDER BY column_name`,
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(["id", "label"]);
      expect((await store.applied()).map((r) => r.version)).toEqual(["20260101000000", "20260102000000"]);

      // rollback the second migration only
      const rb = await rollbackTo("20260101000000", migs, store, exec);
      expect(rb.rolledBack).toEqual(["20260102000000"]);
      const cols2 = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = 'widgets'`,
      );
      expect(cols2.rows.map((r) => r.column_name)).toEqual(["id"]); // label dropped
    } finally {
      await pool.end();
    }
  });

  test("a second store with a different schema tracks independently (multi-tenant)", async () => {
    const pool = new Pool({ connectionString: REAL_PG });
    try {
      await pool.query('CREATE SCHEMA IF NOT EXISTS tenant_x');
      await pool.query('DROP TABLE IF EXISTS tenant_x."metaobjects_migrations"');
      const storeX = new PgHistoryStore(pool, { schema: "tenant_x" });
      const storeDefault = new PgHistoryStore(pool);
      await storeDefault.ensure();
      await storeX.ensure();
      await storeX.record({ version: "20260101000000", name: "x", checksum: "c", appliedAt: new Date().toISOString(), executionMs: 1, success: true });
      expect((await storeX.applied()).length).toBe(1);
      // default store unaffected (clean it first so the assertion is meaningful)
      await pool.query('DELETE FROM "public"."metaobjects_migrations"');
      expect((await storeDefault.applied()).length).toBe(0);
    } finally {
      await pool.end();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or skips without a DB)**

Run (no DB): `cd server/typescript/packages/migrate-ts && bun test test/integration/runner-pg.test.ts`
Expected: the real-PG block is **skipped** (no `MIGRATE_TS_PG_URL`); earlier tasks' tests still pass. The block fails to compile only if `src/runner/index.ts` imports are wrong — so create it in Step 3.

Run (with DB): start a throwaway PG and set the env var, e.g.
```bash
docker run -d --rm --name mo-runner-pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
sleep 3
MIGRATE_TS_PG_URL=postgres://postgres:test@localhost:55432/postgres bun test test/integration/runner-pg.test.ts
```
Expected: FAIL initially if `index.ts` is missing or imports are wrong.

- [ ] **Step 3: Write the runner barrel**

```ts
// src/runner/index.ts
export { contentChecksum } from "./checksum.js";
export { loadMigrations, type Migration } from "./migration-source.js";
export { type AppliedRow, type HistoryStore, InMemoryHistoryStore } from "./history-store.js";
export { applyMigrations, rollbackTo, type SqlExecutor, type ApplyResult, type RollbackResult } from "./apply.js";
export { PgExecutor } from "./pg-executor.js";
export { PgHistoryStore, type PgHistoryStoreOptions } from "./pg-history-store.js";
```

- [ ] **Step 4: Run with a real DB to verify it passes**

```bash
cd server/typescript/packages/migrate-ts
MIGRATE_TS_PG_URL=postgres://postgres:test@localhost:55432/postgres bun test test/integration/runner-pg.test.ts
docker rm -f mo-runner-pg
```
Expected: PASS — apply creates `widgets`(id,label) + 2 history rows, advisory lock acquired/released cleanly, rollback drops `label`, multi-tenant `tenant_x` is independent.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/runner/index.ts server/typescript/packages/migrate-ts/test/integration/runner-pg.test.ts
git commit -m "feat(migrate-ts): runner — end-to-end apply/rollback + advisory lock + multi-tenant (real PG)"
```

---

### Task 9: export the runner from the package entry

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/index.ts` (add the runner re-export)
- Test: `server/typescript/packages/migrate-ts/test/runner/public-api.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/runner/public-api.test.ts
import { test, expect } from "bun:test";
import * as mt from "../../src/index.js";

test("runner is exported from the package entry", () => {
  expect(typeof mt.applyMigrations).toBe("function");
  expect(typeof mt.rollbackTo).toBe("function");
  expect(typeof mt.PgHistoryStore).toBe("function");
  expect(typeof mt.PgExecutor).toBe("function");
  expect(typeof mt.loadMigrations).toBe("function");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/public-api.test.ts`
Expected: FAIL — `applyMigrations` undefined on the package entry.

- [ ] **Step 3: Add the re-export**

Add to `server/typescript/packages/migrate-ts/src/index.ts` (after the existing exports):

```ts
// Migration apply+tracking runner (ADR-0016).
export * from "./runner/index.js";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript/packages/migrate-ts && bun test test/runner/public-api.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole package test suite + typecheck**

Run:
```bash
cd server/typescript/packages/migrate-ts && bun test
cd /home/doug/Development/metaobjects && bun run --filter '@metaobjectsdev/migrate-ts' typecheck
```
Expected: all green (no regressions).

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/index.ts server/typescript/packages/migrate-ts/test/runner/public-api.test.ts
git commit -m "feat(migrate-ts): export the migration runner from the package entry"
```

---

## Follow-on (separate plan — NOT in this plan)

These build on the runner above and are scoped to their own plan once this lands:

- **`info` / state model** (pending / applied / failed / drift) + a `migrate status` surface.
- **`validate` / `repair`** using the stored `checksum` (edited-applied-file detection; realign + clear `success=false`).
- **`baseline`** (stamp an existing non-empty DB without executing).
- **Drift detection** = `diff(buildExpectedSchema(metadata), introspect(live))` surfaced as a command (the engine already has both halves).
- **CLI wiring** — `meta migrate --apply` / `--rollback <version>` / `--dry-run` over `loadMigrations` + `PgHistoryStore` + `PgExecutor` (and the multi-tenant `--schema`/`--lock-name` flags).
- **Output-format adapters** (Flyway-prefix / two-file / single-file-divider) for external runners (ADR-0015 §3).
- **Migrate-conformance suite** wiring (the single shared suite per ADR-0015) once the engine consolidation proceeds.

## Self-review notes

- **Spec coverage (runner design §1–§4, §10–§11):** HistoryStore (Task 3/7), pluggable + multi-tenant (Task 7/8), advisory lock overridable name (Task 7, `lockName`), apply algorithm + transactional + failure recording (Task 4/6), rollback/free-undo (Task 5/8), dry-run (Task 4), SQL-file execution (Task 6), built-on-existing-pg/Kysely-stack not umzug/Migrator (uses `pg` directly). Checksums stored (Task 1/4/7); *validate/baseline/drift/info* deferred to the follow-on (design §5/§6/§8/§9) — explicitly out of this plan's scope.
- **No placeholders:** every code step is complete and runnable.
- **Type consistency:** `Migration`, `AppliedRow`, `HistoryStore`, `SqlExecutor`, `ApplyResult`, `RollbackResult`, `PgHistoryStoreOptions` are defined once and reused with identical shapes across tasks.
