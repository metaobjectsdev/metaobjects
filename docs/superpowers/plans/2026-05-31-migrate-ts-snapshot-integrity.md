# migrate-ts Snapshot Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the integrity layer for the reference-snapshot engine — a deterministic snapshot checksum, a `verifyReplay` primitive (replay migrations into a throwaway DB and assert the result equals the committed snapshot), and a ledger baseline marker — so snapshot/migration divergence and out-of-band edits are detectable.

**Architecture:** All three are thin compositions of existing primitives — no new dependencies. `snapshotChecksum` hashes the already byte-stable `serializeSnapshot` output. `verifyReplay` runs `applyPending` (replay) → `introspect` → `driftAgainstSnapshot` (Plan 3) against a caller-provided fresh Kysely DB. The baseline marker is a sentinel row in the existing ledger. The CLI `verify --replay` command + throwaway-DB provisioning + PGlite-local convenience are an explicit integration follow-on (the library function is dep-free; CI drives it with real-PG / a libsql temp file).

**Tech Stack:** TypeScript (ESM, `.js` specifiers), Bun test runner, `@metaobjectsdev/migrate-ts` (`serializeSnapshot`, `applyPending`, `introspect`, `driftAgainstSnapshot`, the ledger module), `@libsql/kysely-libsql` (devDep, for the replay test).

**Prerequisite:** Plans 1–4 + 6 on origin/main.

**Scope:** the dep-free library integrity primitives (`snapshotChecksum`, `verifyReplay`, ledger baseline marker) + tests. **Out of scope (integration follow-on):** the CLI `verify --replay` command + throwaway-DB provisioning (temp libsql file for sqlite, ephemeral schema / real-PG for postgres), PGlite-local convenience, and wiring `runBaseline` to record the marker.

**Working directory for all commands:** `server/typescript/packages/migrate-ts`.

---

### Task 1: `snapshotChecksum` — deterministic snapshot hash

**Files:**
- Create: `src/snapshot/checksum.ts`
- Test: `test/integrity/checksum.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/integrity/checksum.test.ts
import { describe, test, expect } from "bun:test";
import type { SchemaSnapshot } from "../../src/types.js";
import { snapshotChecksum } from "../../src/snapshot/checksum.js";

const base = (): SchemaSnapshot => ({
  tables: [{
    name: "orders",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      { name: "ref", sqlType: { kind: "text" }, nullable: false },
    ],
    indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
  }],
  views: [],
});

describe("snapshotChecksum", () => {
  test("is a 64-char hex sha256", () => {
    expect(snapshotChecksum(base())).toMatch(/^[0-9a-f]{64}$/);
  });
  test("is stable for the same snapshot", () => {
    expect(snapshotChecksum(base())).toBe(snapshotChecksum(base()));
  });
  test("is order-independent (shuffled columns → same hash)", () => {
    const shuffled: SchemaSnapshot = {
      ...base(),
      tables: base().tables.map((t) => ({ ...t, columns: [...t.columns].reverse() })),
    };
    expect(snapshotChecksum(shuffled)).toBe(snapshotChecksum(base()));
  });
  test("changes when the schema changes", () => {
    const changed = base();
    changed.tables[0]!.columns.push({ name: "extra", sqlType: { kind: "text" }, nullable: true });
    expect(snapshotChecksum(changed)).not.toBe(snapshotChecksum(base()));
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/integrity/checksum.test.ts` (module missing).

- [ ] **Step 3: Implement**

```ts
// src/snapshot/checksum.ts
import { createHash } from "node:crypto";
import type { SchemaSnapshot } from "../types.js";
import { serializeSnapshot } from "./serialize.js";

/**
 * Deterministic sha256 of a schema snapshot. Reuses the canonical
 * (order-stable, byte-identical) serializer, so the hash is independent of
 * table/column ordering and depends only on the schema's content. Used to make
 * the committed snapshot tamper-evident (record the hash; a later hand-edit
 * changes it) and as the baseline marker's payload.
 */
export function snapshotChecksum(snapshot: SchemaSnapshot): string {
  return createHash("sha256").update(serializeSnapshot(snapshot), "utf8").digest("hex");
}
```

- [ ] **Step 4: Run → PASS** — `bun test test/integrity/checksum.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/checksum.ts test/integrity/checksum.test.ts
git commit -m "feat(migrate-ts): deterministic snapshotChecksum (sha256 of canonical snapshot)"
```

---

### Task 2: `verifyReplay` — replay migrations and compare to snapshot

**Files:**
- Create: `src/verify/replay.ts`
- Test: `test/integrity/replay.test.ts`

- [ ] **Step 1: Write the failing test** (libsql temp-FILE, not `:memory:` — `:memory:` loses state across connections)

```ts
// test/integrity/replay.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import type { SchemaSnapshot } from "../../src/types.js";
import { verifyReplay } from "../../src/verify/replay.js";

const tmps: string[] = [];
async function tmpRoot(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "replay-"));
  tmps.push(d);
  return d;
}
async function writeMigration(root: string, name: string, up: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "up.sql"), up, "utf8");
  await writeFile(join(dir, "down.sql"), "-- n/a", "utf8");
}
function db(file: string): Kysely<Record<string, unknown>> {
  return new Kysely({ dialect: new LibsqlDialect({ url: `file:${file}` }) });
}

afterAll(async () => { for (const d of tmps) await rm(d, { recursive: true, force: true }); });

// The snapshot the migrations are SUPPOSED to produce.
const ordersSnapshot = (withRef: boolean): SchemaSnapshot => ({
  tables: [{
    name: "orders",
    columns: [
      { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false },
      ...(withRef ? [{ name: "ref", sqlType: { kind: "text" as const }, nullable: false }] : []),
    ],
    indexes: [], foreignKeys: [], checks: [], primaryKey: ["id"],
  }],
  views: [],
});

describe("verifyReplay", () => {
  test("replayed schema matching the snapshot → no drift", async () => {
    const root = await tmpRoot();
    await writeMigration(root, "20260101000000-init",
      `CREATE TABLE orders ( id INTEGER NOT NULL PRIMARY KEY, ref TEXT NOT NULL );`);
    const k = db(join(root, "rep1.db"));
    try {
      const r = await verifyReplay({ db: k, dialect: "sqlite", migrationsDir: root, snapshot: ordersSnapshot(true) });
      expect(r.ok).toBe(true);
      expect(r.drift).toEqual([]);
    } finally { await k.destroy(); }
  });

  test("snapshot missing a column the migrations create → drift detected", async () => {
    const root = await tmpRoot();
    await writeMigration(root, "20260101000000-init",
      `CREATE TABLE orders ( id INTEGER NOT NULL PRIMARY KEY, ref TEXT NOT NULL );`);
    const k = db(join(root, "rep2.db"));
    try {
      // snapshot lacks `ref` → the replayed DB has it → diff sees an unmanaged column,
      // but the SNAPSHOT-as-expected is missing nothing the DB lacks; the divergence is
      // a column in the DB the snapshot doesn't model → classified as drift-or-unmanaged.
      const r = await verifyReplay({ db: k, dialect: "sqlite", migrationsDir: root, snapshot: ordersSnapshot(false) });
      expect(r.ok).toBe(false);
    } finally { await k.destroy(); }
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/integrity/replay.test.ts` (module missing).

- [ ] **Step 3: Implement** — compose `applyPending` + `introspect` + `driftAgainstSnapshot`, filtering the ledger sidecar table out of the introspected result so it isn't reported as drift/unmanaged:

```ts
// src/verify/replay.ts
import type { Kysely } from "kysely";
import { applyPending } from "../apply/apply.js";
import { MIGRATIONS_TABLE } from "../apply/ledger.js";
import { introspect } from "../introspect/index.js";
import { driftAgainstSnapshot, type DriftClassification } from "../drift/classify.js";
import type { Dialect, SchemaSnapshot } from "../types.js";

export interface VerifyReplayArgs {
  /** A FRESH, throwaway database. Replay applies every migration into it from empty. */
  db: Kysely<Record<string, unknown>>;
  dialect: Extract<Dialect, "postgres" | "sqlite">;
  /** Directory holding the committed `<timestamp>-<slug>/up.sql` migrations. */
  migrationsDir: string;
  /** The committed snapshot the migrations are expected to reproduce. */
  snapshot: SchemaSnapshot;
}

export interface VerifyReplayResult extends DriftClassification {
  /** True when the replayed schema matches the snapshot (no drift, no unmanaged). */
  ok: boolean;
}

/**
 * Replay all committed migrations into a fresh database, introspect the result,
 * and compare it to the committed snapshot. A non-empty `drift`/`unmanaged` means
 * the migrations-as-applied diverge from the snapshot — e.g. a hand-edited up.sql
 * that changed structure the metadata-derived snapshot doesn't know about. The
 * ledger sidecar table is excluded from the comparison.
 */
export async function verifyReplay(args: VerifyReplayArgs): Promise<VerifyReplayResult> {
  await applyPending(args.db, args.migrationsDir, { dialect: args.dialect });
  const introspected = await introspect(args.db, args.dialect);
  const actual: SchemaSnapshot = {
    ...introspected,
    tables: introspected.tables.filter((t) => t.name !== MIGRATIONS_TABLE),
  };
  const classification = await driftAgainstSnapshot(args.snapshot, actual);
  return {
    ...classification,
    ok: classification.drift.length === 0 && classification.unmanaged.length === 0,
  };
}
```

(Confirm `applyPending(db, migrationsDir, opts)` and `introspect(db, dialect)` signatures against the real exports and match them; `MIGRATIONS_TABLE` is exported from `src/apply/ledger.js`. If `introspect` needs the wider `Dialect`, widen the arg accordingly.)

- [ ] **Step 4: Run → PASS** — `bun test test/integrity/replay.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/verify/replay.ts test/integrity/replay.test.ts
git commit -m "feat(migrate-ts): verifyReplay — replay migrations and assert == snapshot"
```

---

### Task 3: ledger baseline marker

**Files:**
- Modify: `src/apply/ledger.ts`
- Test: `test/integrity/baseline-marker.test.ts`

- [ ] **Step 1: Write the failing test** (libsql temp file)

```ts
// test/integrity/baseline-marker.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kysely } from "kysely";
import { LibsqlDialect } from "@libsql/kysely-libsql";
import { ensureLedger, recordBaseline, baselineRecord } from "../../src/apply/ledger.js";

const tmps: string[] = [];
function db(file: string) { return new Kysely<Record<string, unknown>>({ dialect: new LibsqlDialect({ url: `file:${file}` }) }); }
async function root() { const d = await mkdtemp(join(tmpdir(), "baseline-")); tmps.push(d); return d; }
afterAll(async () => { for (const d of tmps) await rm(d, { recursive: true, force: true }); });

describe("ledger baseline marker", () => {
  test("recordBaseline stores the checksum; baselineRecord reads it back", async () => {
    const k = db(join(await root(), "b.db"));
    try {
      await ensureLedger(k, "sqlite");
      expect(await baselineRecord(k, "sqlite")).toBeNull();
      await recordBaseline(k, "sqlite", "abc123checksum");
      const rec = await baselineRecord(k, "sqlite");
      expect(rec?.checksum).toBe("abc123checksum");
    } finally { await k.destroy(); }
  });
});
```

- [ ] **Step 2: Run → FAIL** — `bun test test/integrity/baseline-marker.test.ts` (`recordBaseline`/`baselineRecord` not exported).

- [ ] **Step 3: Implement** — in `src/apply/ledger.ts`, add a sentinel-row baseline marker reusing the existing ledger table (the baseline is a reserved name so it sorts before any real `<timestamp>-...` migration and never collides). Match the file's existing `LedgerOptions`/`ledgerRef`/`recordApplied` style (qualified table name on pg, bare on sqlite):

```ts
/** Reserved ledger name for the baseline marker (sorts before any timestamped migration). */
export const BASELINE_NAME = "0000-baseline";

/**
 * Record (or overwrite) the baseline marker — the snapshot checksum captured when
 * `migrate baseline` seeded the reference snapshot. Lets a later check detect a
 * snapshot that was hand-edited out of sync with the migration chain.
 */
export async function recordBaseline(
  db: Kysely<Record<string, unknown>>,
  dialect: LedgerDialect,
  checksum: string,
  opts?: LedgerOptions,
): Promise<void> {
  const ledger = ledgerRef(dialect, opts);
  await ensureLedger(db, dialect, opts);
  const appliedAt = new Date().toISOString();
  // Upsert: delete any prior baseline, then insert (portable across sqlite/pg).
  await sql`DELETE FROM ${ledger.ref} WHERE name = ${BASELINE_NAME}`.execute(db);
  await sql`INSERT INTO ${ledger.ref} (name, applied_at, checksum) VALUES (${BASELINE_NAME}, ${appliedAt}, ${checksum})`.execute(db);
}

/** Read the baseline marker, or null if none recorded. */
export async function baselineRecord(
  db: Kysely<Record<string, unknown>>,
  dialect: LedgerDialect,
  opts?: LedgerOptions,
): Promise<{ name: string; checksum: string } | null> {
  const ledger = ledgerRef(dialect, opts);
  const result = await sql<{ name: string; checksum: string }>`
    SELECT name, checksum FROM ${ledger.ref} WHERE name = ${BASELINE_NAME}
  `.execute(db);
  const row = result.rows[0];
  return row ? { name: row.name, checksum: row.checksum } : null;
}
```

(Match the real helper names in `ledger.ts` — the survey shows `ensureLedger(db, dialect, opts)`, `recordApplied(db, name, checksum, opts)`, `appliedRecords`, a `ledger.ref` qualified-name object, `LedgerOptions`, and a `LedgerDialect` type + the `sql` import from kysely. If the file builds the qualified ref via a helper other than `ledgerRef`, use that helper's real name. Reuse the existing `sql` tagged-template + `.execute(db)` form used by `recordApplied`/`appliedRecords`.)

- [ ] **Step 4: Run → PASS** — `bun test test/integrity/baseline-marker.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/apply/ledger.ts test/integrity/baseline-marker.test.ts
git commit -m "feat(migrate-ts): ledger baseline marker (recordBaseline / baselineRecord)"
```

---

### Task 4: exports + full-suite verification

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Add exports** — after the existing snapshot/drift exports in `src/index.ts`:

```ts
export { snapshotChecksum } from "./snapshot/checksum.js";
export { verifyReplay } from "./verify/replay.js";
export type { VerifyReplayArgs, VerifyReplayResult } from "./verify/replay.js";
export { recordBaseline, baselineRecord, BASELINE_NAME } from "./apply/ledger.js";
```

(If `recordBaseline`/`baselineRecord`/`BASELINE_NAME` are already re-exported via an `export * from "./apply/ledger.js"` or a grouped ledger export, add them to that group instead of duplicating.)

- [ ] **Step 2: Typecheck** — `bun run build` (tsc exit 0) and `bun run typecheck` (exit 0).

- [ ] **Step 3: Full suite** — `bun test` (all pre-existing + the new `test/integrity/*` tests, 0 failures). If `bun run build` reports missing `@metaobjectsdev/metadata` declarations, build `../metadata` first (gitignored, don't commit).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(migrate-ts): export snapshot-integrity API (checksum, verifyReplay, baseline marker)"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** implements spec §8 integrity — `verify --replay` *mechanism* (the `verifyReplay` library primitive), the snapshot checksum, and the §6 baseline marker. The CLI `verify --replay` command + throwaway-DB provisioning (temp libsql file / ephemeral PG schema) + PGlite-local convenience + wiring `runBaseline` to call `recordBaseline` are the explicit integration follow-on — this plan delivers the dep-free library core that CI (real-PG / libsql temp file) can already drive.
- **No new deps:** everything composes `serializeSnapshot`, `applyPending`, `introspect`, `driftAgainstSnapshot`, and the ledger — all already in the package. The replay test uses the existing `@libsql/kysely-libsql` devDep with a temp FILE (not `:memory:`).
- **Ledger-table filtering:** `verifyReplay` excludes `MIGRATIONS_TABLE` from the introspected result so the sidecar ledger isn't reported as unmanaged drift.
- **Why baseline reuses the ledger table:** a reserved `BASELINE_NAME` ("0000-baseline") sorts before any `<timestamp>-...` migration and stores the snapshot checksum in the existing `checksum` column — no schema change to the ledger.
- **Determinism:** `snapshotChecksum` reuses the byte-stable `serializeSnapshot`, so it's order-independent and matches across machines/CI.
- **Type anchors:** `SchemaSnapshot`/`Dialect` in `src/types.ts`; `applyPending` in `src/apply/apply.ts`; `introspect` in `src/introspect/index.ts`; `driftAgainstSnapshot`/`DriftClassification` in `src/drift/classify.ts`; `MIGRATIONS_TABLE`/`ensureLedger`/`LedgerOptions`/`LedgerDialect`/`ledgerRef` in `src/apply/ledger.ts`.
