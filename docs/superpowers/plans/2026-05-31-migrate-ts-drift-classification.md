# migrate-ts Drift Classification (drift vs unmanaged) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the library capability behind `verify --db` from spec §6: compare a live DB to the committed snapshot and classify each difference as **drift** (a modeled object the DB is missing or has differently — actionable) vs **unmanaged** (an object present in the DB but absent from the snapshot — informational, never proposed for drop).

**Architecture:** A pure `classifyDrift(changes)` partition plus a `driftAgainstSnapshot(snapshot, actual)` convenience that diffs the snapshot against an introspected DB and classifies the result. The diff direction (`expected = snapshot`, `actual = introspected DB`) makes "extra in DB" surface as `drop-*` changes — those are exactly the unmanaged objects.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/migrate-ts` (`diff`, `buildExpectedSchema`, `SchemaSnapshot`, `Change`).

**Prerequisite:** Plan 1 (reference-snapshot foundation) merged. (Independent of Plan 2.)

**Scope:** the library classifier + its export + tests. **Out of scope (rides with the verify command):** the `meta verify --db` CLI wiring that reads the snapshot, introspects, calls `driftAgainstSnapshot`, fails on `drift`, and logs `unmanaged` as informational.

**Working directory for all commands:** `server/typescript/packages/migrate-ts`.

---

### Task 1: `classifyDrift` — partition changes into drift vs unmanaged

**Files:**
- Create: `src/drift/classify.ts`
- Test: `test/drift/classify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/drift/classify.test.ts
import { describe, test, expect } from "bun:test";
import type { Change } from "../../src/types.js";
import { classifyDrift } from "../../src/drift/classify.js";

// Classification reads only `kind`; a minimal cast is enough for this unit.
const mk = (kind: string): Change => ({ kind, status: { state: "ok" } } as unknown as Change);

describe("classifyDrift", () => {
  test("drop-* changes are unmanaged; everything else is drift", () => {
    const { drift, unmanaged } = classifyDrift([
      mk("create-table"),
      mk("drop-table"),
      mk("add-column"),
      mk("drop-column"),
      mk("change-column-type"),
      mk("add-index"),
      mk("drop-index"),
      mk("add-fk"),
      mk("drop-fk"),
      mk("create-view"),
      mk("drop-view"),
      mk("replace-view"),
    ]);
    expect(unmanaged.map((c) => c.kind)).toEqual([
      "drop-table", "drop-column", "drop-index", "drop-fk", "drop-view",
    ]);
    expect(drift.map((c) => c.kind)).toEqual([
      "create-table", "add-column", "change-column-type",
      "add-index", "add-fk", "create-view", "replace-view",
    ]);
  });

  test("empty input yields empty partitions", () => {
    const { drift, unmanaged } = classifyDrift([]);
    expect(drift).toEqual([]);
    expect(unmanaged).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/drift/classify.test.ts`
Expected: FAIL — `Cannot find module '../../src/drift/classify.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/drift/classify.ts
import { diff } from "../diff/index.js";
import type { Change, DiffResult, SchemaSnapshot } from "../types.js";

/**
 * Change kinds that represent an object present in the live DB but absent from
 * the snapshot. When the snapshot is the `expected` side of a diff, these are
 * the DB's *unmanaged* objects — hand-authored, not modeled — and must never be
 * treated as actionable drift or auto-dropped.
 */
const UNMANAGED_KINDS = new Set<string>([
  "drop-table",
  "drop-column",
  "drop-index",
  "drop-fk",
  "drop-view",
]);

export interface DriftClassification {
  /** Modeled objects the DB is missing or has differently — actionable; fails the gate. */
  drift: Change[];
  /** Objects present in the DB but not the snapshot — informational; never dropped. */
  unmanaged: Change[];
}

export function classifyDrift(changes: Change[]): DriftClassification {
  const drift: Change[] = [];
  const unmanaged: Change[] = [];
  for (const c of changes) {
    if (UNMANAGED_KINDS.has(c.kind)) unmanaged.push(c);
    else drift.push(c);
  }
  return { drift, unmanaged };
}

/**
 * Drift of a live DB (introspected into `actual`) against the committed snapshot.
 * Diffs with `expected = snapshot` so that objects only in the DB surface as
 * `drop-*` → classified `unmanaged`; objects the snapshot has but the DB lacks or
 * differs surface as create/add/change → classified `drift`.
 */
export async function driftAgainstSnapshot(
  snapshot: SchemaSnapshot,
  actual: SchemaSnapshot,
): Promise<DriftClassification> {
  const result: DiffResult = await diff({ expected: snapshot, actual });
  return classifyDrift(result.changes);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/drift/classify.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/drift/classify.ts test/drift/classify.test.ts
git commit -m "feat(migrate-ts): classify schema drift as drift vs unmanaged"
```

---

### Task 2: `driftAgainstSnapshot` end-to-end + exports

**Files:**
- Modify: `src/index.ts` (export the new API)
- Test: `test/drift/drift-against-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/drift/drift-against-snapshot.test.ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import type { MetaData } from "@metaobjectsdev/metadata";
import { buildExpectedSchema } from "../../src/expected-schema.js";
import { driftAgainstSnapshot } from "../../src/drift/classify.js";

// Snapshot models {id, ref}; the live DB has {id, note} — i.e. it dropped `ref`
// (real drift) and gained an unmanaged `note`.
const ENTITY = (fields: string) =>
  JSON.stringify({
    "metadata.root": {
      children: [{
        "object.entity": {
          name: "Order",
          children: [
            { "field.long": { name: "id" } },
            ...JSON.parse(fields),
            { "source.rdb": { name: "src", "@table": "orders" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      }],
    },
  });

async function snapshotOf(fields: string) {
  const root: MetaData = (await new MetaDataLoader().load([new InMemoryStringSource(ENTITY(fields))])).root;
  return buildExpectedSchema(root, { dialect: "postgres" });
}

describe("driftAgainstSnapshot", () => {
  test("missing modeled column = drift; extra DB column = unmanaged", async () => {
    const snapshot = await snapshotOf('[{"field.string":{"name":"ref"}}]');
    const liveDb = await snapshotOf('[{"field.string":{"name":"note"}}]');
    const { drift, unmanaged } = await driftAgainstSnapshot(snapshot, liveDb);

    // snapshot has `ref` the DB lacks → add-column drift
    expect(drift.some((c) => c.kind === "add-column")).toBe(true);
    // DB has `note` the snapshot lacks → drop-column unmanaged
    expect(unmanaged.some((c) => c.kind === "drop-column")).toBe(true);
    expect(drift.some((c) => c.kind === "drop-column")).toBe(false);
  });

  test("identical schemas → no drift, no unmanaged", async () => {
    const snap = await snapshotOf('[{"field.string":{"name":"ref"}}]');
    const { drift, unmanaged } = await driftAgainstSnapshot(snap, snap);
    expect(drift).toEqual([]);
    expect(unmanaged).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/drift/drift-against-snapshot.test.ts`
Expected: FAIL — `driftAgainstSnapshot` not exported from the package entry (the test imports it from the source module, so this step's failure is actually the missing export in Step 3; run it to confirm the test itself is green against the source module first).

Note: this test imports `driftAgainstSnapshot` from `../../src/drift/classify.js` (already created in Task 1), so it should PASS once written. The export step below makes it available from the package root for the CLI.

- [ ] **Step 3: Add the exports**

Add to `src/index.ts` (after the existing `export { computeDrift, type ComputeDriftOptions } from "./drift/drift.js";` line):

```ts
export { classifyDrift, driftAgainstSnapshot } from "./drift/classify.js";
export type { DriftClassification } from "./drift/classify.js";
```

- [ ] **Step 4: Run the new test + typecheck + full suite**

Run: `bun test test/drift/drift-against-snapshot.test.ts`
Expected: PASS (2 tests).

Run: `bun run build`
Expected: `tsc` exits 0.

Run: `bun test`
Expected: all pre-existing tests plus the new `test/drift/*` tests pass; 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts test/drift/drift-against-snapshot.test.ts
git commit -m "feat(migrate-ts): export driftAgainstSnapshot + DriftClassification"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** implements the spec §6 `verify` classification (drift vs unmanaged) at the library level, resolving the §1.3 / §3.3 drift-pressure concern — DB-only objects classify as `unmanaged` and are never proposed for drop. The CLI `verify --db` wiring (read snapshot → introspect → `driftAgainstSnapshot` → fail on `drift`, log `unmanaged`) rides with the verify command in the CLI plan.
- **Diff direction matters:** `diff({ expected: snapshot, actual: introspectedDb })`. "Extra in DB" → `drop-*` → `unmanaged`; "missing/changed vs snapshot" → create/add/change → `drift`. Reversing the arguments inverts the classification, so keep `expected = snapshot`.
- **Type anchors:** `Change`, `DiffResult`, `SchemaSnapshot` in `src/types.ts`; `diff` in `src/diff/index.ts`; `buildExpectedSchema` + `MetaDataLoader`/`InMemoryStringSource` from `@metaobjectsdev/metadata`.
