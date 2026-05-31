# migrate-ts Reference-Snapshot Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the offline, deterministic reference-snapshot core to `@metaobjectsdev/migrate-ts` so a migration can be planned by diffing metadata against a stored `SchemaSnapshot` instead of a live database.

**Architecture:** Three small, pure-ish library modules under `src/snapshot/`: a deterministic serializer (`serialize.ts`), file I/O (`store.ts`), and an offline planner (`plan.ts`) that wires `buildExpectedSchema` + the existing symmetric `diff()` against a stored snapshot. No new diff/emit logic — this reuses the existing engine. CLI wiring, verify-classification, down-from-snapshot, integrity, and the DDL gaps are **separate plans** (see "Scope" below).

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Bun test runner (`bun:test`), `@metaobjectsdev/metadata` (`MetaDataLoader`, `buildExpectedSchema`), Node `fs/promises`.

**Scope (this plan only):** the `src/snapshot/` library + its exports + unit tests. **Out of scope (own plans):** CLI wiring (`baseline` command, snapshot-default `gen`, `--from-db` escape hatch), `verify --db` drift/unmanaged classification, down-from-snapshot emit, ledger checksum + replay-verify, and the §7 gap features (CHECK constraints first). This library foundation is independently testable and is the prerequisite every later plan builds on.

**Working directory for all commands:** `server/typescript/packages/migrate-ts`.

---

### Task 1: Deterministic snapshot serializer + format version

**Files:**
- Create: `src/snapshot/serialize.ts`
- Test: `test/snapshot/serialize.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/snapshot/serialize.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import type { SchemaSnapshot } from "../../src/types.js";
import {
  serializeSnapshot,
  parseSnapshot,
  SNAPSHOT_FORMAT_VERSION,
} from "../../src/snapshot/serialize.js";

const META = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "ref" } },
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Customer",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "email" } },
            { "source.rdb": { name: "src", "@table": "customers" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadJson(json: string): Promise<MetaData> {
  const result = await new MetaDataLoader().load([new InMemoryStringSource(json)]);
  return result.root;
}

describe("serializeSnapshot / parseSnapshot", () => {
  let snap: SchemaSnapshot;

  beforeAll(async () => {
    snap = buildExpectedSchema(await loadJson(META), { dialect: "postgres" });
  });

  test("output carries the format version and ends with a newline", () => {
    const text = serializeSnapshot(snap);
    expect(text).toContain(`"formatVersion": ${SNAPSHOT_FORMAT_VERSION}`);
    expect(text.endsWith("\n")).toBe(true);
  });

  test("round-trips: parse(serialize(s)) re-serializes byte-identically", () => {
    const text = serializeSnapshot(snap);
    expect(serializeSnapshot(parseSnapshot(text))).toBe(text);
  });

  test("is order-stable: shuffled tables/columns serialize identically", () => {
    const shuffled: SchemaSnapshot = {
      ...snap,
      tables: [...snap.tables].reverse().map((t) => ({
        ...t,
        columns: [...t.columns].reverse(),
        indexes: [...t.indexes].reverse(),
        foreignKeys: [...t.foreignKeys].reverse(),
      })),
      views: [...snap.views].reverse(),
    };
    expect(serializeSnapshot(shuffled)).toBe(serializeSnapshot(snap));
  });

  test("rejects a snapshot whose formatVersion is newer than supported", () => {
    const bumped = serializeSnapshot(snap).replace(
      `"formatVersion": ${SNAPSHOT_FORMAT_VERSION}`,
      `"formatVersion": ${SNAPSHOT_FORMAT_VERSION + 1}`,
    );
    expect(() => parseSnapshot(bumped)).toThrow(/newer than supported/);
  });

  test("rejects a file with no formatVersion", () => {
    expect(() => parseSnapshot(JSON.stringify({ snapshot: snap }))).toThrow(/formatVersion/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/snapshot/serialize.test.ts`
Expected: FAIL — `Cannot find module '../../src/snapshot/serialize.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/snapshot/serialize.ts
import type { SchemaSnapshot } from "../types.js";

/**
 * On-disk format version for the committed schema snapshot. Bump when the
 * SchemaSnapshot descriptor gains a field (a DDL-coverage feature); add the
 * matching upgrade branch in parseSnapshot at the same time.
 */
export const SNAPSHOT_FORMAT_VERSION = 1;

interface SnapshotFile {
  formatVersion: number;
  snapshot: SchemaSnapshot;
}

function sortByName<T extends { name: string }>(arr: readonly T[]): T[] {
  return [...arr].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Sort arrays by name so serialization is order-independent. */
function canonicalize(s: SchemaSnapshot): SchemaSnapshot {
  return {
    tables: sortByName(s.tables).map((t) => ({
      ...t,
      columns: sortByName(t.columns),
      indexes: sortByName(t.indexes),
      foreignKeys: sortByName(t.foreignKeys),
    })),
    views: sortByName(s.views),
    ...(s.meta ? { meta: s.meta } : {}),
  };
}

/** JSON.stringify with object keys sorted recursively (arrays left as-is). */
function stableStringify(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, v) => {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const obj = v as Record<string, unknown>;
        return Object.fromEntries(Object.keys(obj).sort().map((k) => [k, obj[k]]));
      }
      return v;
    },
    2,
  );
}

export function serializeSnapshot(snapshot: SchemaSnapshot): string {
  const file: SnapshotFile = {
    formatVersion: SNAPSHOT_FORMAT_VERSION,
    snapshot: canonicalize(snapshot),
  };
  return stableStringify(file) + "\n";
}

export function parseSnapshot(text: string): SchemaSnapshot {
  const file = JSON.parse(text) as SnapshotFile;
  if (typeof file.formatVersion !== "number") {
    throw new Error("snapshot file is missing a numeric 'formatVersion'");
  }
  if (file.formatVersion > SNAPSHOT_FORMAT_VERSION) {
    throw new Error(
      `snapshot formatVersion ${file.formatVersion} is newer than supported ` +
        `${SNAPSHOT_FORMAT_VERSION}; upgrade @metaobjectsdev/migrate-ts`,
    );
  }
  // v1 is the only version today. Future versions add upgrade branches here
  // (read older shape, lift it forward) before returning.
  return file.snapshot;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/snapshot/serialize.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/serialize.ts test/snapshot/serialize.test.ts
git commit -m "feat(migrate-ts): deterministic schema-snapshot serializer + format version"
```

---

### Task 2: Snapshot file store (per-dialect path + read/write)

**Files:**
- Create: `src/snapshot/store.ts`
- Test: `test/snapshot/store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/snapshot/store.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { serializeSnapshot, parseSnapshot } from "../../src/snapshot/serialize.js";
import { snapshotPath, readSnapshot, writeSnapshot } from "../../src/snapshot/store.js";

const META = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadJson(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

const tmpDirs: string[] = [];
async function makeDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "mts-snap-"));
  tmpDirs.push(d);
  return d;
}

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true });
});

describe("snapshot store", () => {
  test("snapshotPath names the file per dialect, with d1 sharing sqlite", () => {
    expect(snapshotPath("/m", "postgres").endsWith(".schema.postgres.json")).toBe(true);
    expect(snapshotPath("/m", "sqlite").endsWith(".schema.sqlite.json")).toBe(true);
    expect(snapshotPath("/m", "d1").endsWith(".schema.sqlite.json")).toBe(true);
  });

  test("readSnapshot returns null when the file does not exist", async () => {
    const dir = await makeDir();
    expect(await readSnapshot(snapshotPath(dir, "postgres"))).toBeNull();
  });

  test("write then read round-trips the snapshot", async () => {
    const dir = await makeDir();
    const path = snapshotPath(dir, "postgres");
    const snap = buildExpectedSchema(await loadJson(META), { dialect: "postgres" });
    await writeSnapshot(path, snap);
    expect(await readSnapshot(path)).toEqual(parseSnapshot(serializeSnapshot(snap)));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/snapshot/store.test.ts`
Expected: FAIL — `Cannot find module '../../src/snapshot/store.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/snapshot/store.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Dialect, SchemaSnapshot } from "../types.js";
import { parseSnapshot, serializeSnapshot } from "./serialize.js";

/**
 * Committed reference-snapshot path for a dialect, e.g.
 * `<migrationsDir>/.schema.postgres.json`. d1 shares sqlite's schema, so both
 * map to `.schema.sqlite.json`.
 */
export function snapshotPath(migrationsDir: string, dialect: Dialect): string {
  const d = dialect === "d1" ? "sqlite" : dialect;
  return join(migrationsDir, `.schema.${d}.json`);
}

/** Read + parse the snapshot, or null if the file is absent. */
export async function readSnapshot(path: string): Promise<SchemaSnapshot | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseSnapshot(text);
}

/** Serialize + write the snapshot, creating the parent directory if needed. */
export async function writeSnapshot(path: string, snapshot: SchemaSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serializeSnapshot(snapshot), "utf8");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/snapshot/store.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/store.ts test/snapshot/store.test.ts
git commit -m "feat(migrate-ts): per-dialect schema-snapshot file store"
```

---

### Task 3: Offline planner + metadata baseline

**Files:**
- Create: `src/snapshot/plan.ts`
- Test: `test/snapshot/plan.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/snapshot/plan.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import type { SchemaSnapshot } from "../../src/types.js";
import { planOffline, baselineFromMetadata } from "../../src/snapshot/plan.js";

const META = JSON.stringify({
  "metadata.root": {
    children: [
      {
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            { "field.string": { name: "ref" } },
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
});

async function loadJson(json: string): Promise<MetaData> {
  return (await new MetaDataLoader().load([new InMemoryStringSource(json)])).root;
}

const EMPTY: SchemaSnapshot = { tables: [], views: [] };

describe("planOffline", () => {
  test("against an empty snapshot emits create-table and returns the new snapshot", async () => {
    const metadata = await loadJson(META);
    const { diff, nextSnapshot } = await planOffline({ metadata, dialect: "postgres", snapshot: EMPTY });
    expect(diff.changes.some((c) => c.kind === "create-table")).toBe(true);
    expect(nextSnapshot.tables).toHaveLength(1);
    expect(nextSnapshot.tables[0]?.name).toBe("orders");
  });

  test("against the current baseline emits no changes (reflexive)", async () => {
    const metadata = await loadJson(META);
    const snapshot = baselineFromMetadata(metadata, "postgres");
    const { diff } = await planOffline({ metadata, dialect: "postgres", snapshot });
    expect(diff.changes).toHaveLength(0);
  });
});

describe("baselineFromMetadata", () => {
  test("equals buildExpectedSchema for the dialect", async () => {
    const metadata = await loadJson(META);
    const snap = baselineFromMetadata(metadata, "postgres");
    expect(snap.tables.map((t) => t.name)).toEqual(["orders"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/snapshot/plan.test.ts`
Expected: FAIL — `Cannot find module '../../src/snapshot/plan.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/snapshot/plan.ts
import type { ColumnNamingStrategy, MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../expected-schema.js";
import { diff, type DiffArgs } from "../diff/index.js";
import type { Dialect, DiffResult, SchemaSnapshot } from "../types.js";

export interface PlanOfflineArgs extends Pick<DiffArgs, "allow" | "onAmbiguous" | "ignoreTables"> {
  metadata: MetaData;
  dialect: Dialect;
  /** The stored reference snapshot (the "from" side). Use `{ tables: [], views: [] }` for a fresh project. */
  snapshot: SchemaSnapshot;
  columnNamingStrategy?: ColumnNamingStrategy;
}

export interface PlanOfflineResult {
  /** The change set to emit, from diffing metadata-expected against the snapshot. */
  diff: DiffResult;
  /** The schema the migration brings us to — write this back as the new snapshot on accept. */
  nextSnapshot: SchemaSnapshot;
}

/**
 * Plan a migration offline: build the expected schema from metadata and diff it
 * against the stored snapshot. No database. The caller emits `diff` and, on
 * accept, persists `nextSnapshot` via writeSnapshot.
 */
export async function planOffline(args: PlanOfflineArgs): Promise<PlanOfflineResult> {
  const nextSnapshot = buildExpectedSchema(args.metadata, {
    dialect: args.dialect,
    ...(args.columnNamingStrategy ? { columnNamingStrategy: args.columnNamingStrategy } : {}),
  });
  const result = await diff({
    expected: nextSnapshot,
    actual: args.snapshot,
    ...(args.allow ? { allow: args.allow } : {}),
    ...(args.onAmbiguous ? { onAmbiguous: args.onAmbiguous } : {}),
    ...(args.ignoreTables ? { ignoreTables: args.ignoreTables } : {}),
  });
  return { diff: result, nextSnapshot };
}

/** Seed an initial reference snapshot from metadata (greenfield baseline). */
export function baselineFromMetadata(
  metadata: MetaData,
  dialect: Dialect,
  columnNamingStrategy?: ColumnNamingStrategy,
): SchemaSnapshot {
  return buildExpectedSchema(metadata, {
    dialect,
    ...(columnNamingStrategy ? { columnNamingStrategy } : {}),
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/snapshot/plan.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/plan.ts test/snapshot/plan.test.ts
git commit -m "feat(migrate-ts): offline snapshot planner + metadata baseline"
```

---

### Task 4: Public exports + full-suite verification

**Files:**
- Modify: `src/index.ts` (add exports near the other `migrate-ts` exports, around line 16)

- [ ] **Step 1: Add the exports**

Add to `src/index.ts` (after the existing `export { writeMigration } from "./write-migration.js";` line):

```ts
// Reference-snapshot generation (offline, deterministic).
export {
  serializeSnapshot,
  parseSnapshot,
  SNAPSHOT_FORMAT_VERSION,
} from "./snapshot/serialize.js";
export { snapshotPath, readSnapshot, writeSnapshot } from "./snapshot/store.js";
export { planOffline, baselineFromMetadata } from "./snapshot/plan.js";
export type { PlanOfflineArgs, PlanOfflineResult } from "./snapshot/plan.js";
```

- [ ] **Step 2: Verify the package type-checks**

Run: `bun run build`
Expected: `tsc -p .` exits 0 (no type errors).

- [ ] **Step 3: Run the whole migrate-ts test suite**

Run: `bun test`
Expected: PASS — all pre-existing tests plus the 11 new `test/snapshot/*` tests; 0 failures.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(migrate-ts): export reference-snapshot API"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** this plan covers spec §4 (format + storage: Task 1–2), §5 generate inputs (the offline planner: Task 3), and §6 `baseline --from-metadata` (Task 3). Deliberately deferred to later plans: §5 snapshot-write-on-accept + §6 CLI commands (CLI plan), §6 `verify` classification, §5 down-from-snapshot, §8 integrity, §7 gaps.
- **No DB in this plan:** every test is pure or temp-file based; `baseline --from-db` (which calls the existing `introspect`) is wired in the CLI plan with an integration test.
- **Type anchors:** `SchemaSnapshot`, `Dialect`, `DiffResult` live in `src/types.ts`; `DiffArgs` + `diff` in `src/diff/index.ts`; `buildExpectedSchema` in `src/expected-schema.ts`; `MetaData`, `ColumnNamingStrategy`, `MetaDataLoader`, `InMemoryStringSource` in `@metaobjectsdev/metadata`.
