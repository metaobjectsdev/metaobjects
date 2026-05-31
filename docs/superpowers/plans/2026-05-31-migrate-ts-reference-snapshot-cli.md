# migrate-ts Reference-Snapshot CLI Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the offline reference-snapshot foundation through the `meta migrate` CLI: a `baseline` subcommand and a default DB-free `gen` that diffs metadata against the committed snapshot, with `--from-db` retained as the legacy live-introspection escape hatch.

**Architecture:** Add a **separate DB-free code path** (`runOfflineGenerate`) used as the default, plus a `runBaseline` seeder, both dispatched early in the migrate command. The existing introspect+apply flow is left untouched and runs only for `--from-db` or `--apply`. This avoids refactoring the kysely coupling woven through the current generate/apply/output path.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/migrate-ts` (the Plan 1 foundation: `planOffline`, `baselineFromMetadata`, `readSnapshot`, `writeSnapshot`, `snapshotPath`, `emit`, `writeMigration`).

**Prerequisite:** Plan 1 (reference-snapshot foundation) merged — `@metaobjectsdev/migrate-ts` exports `planOffline`, `baselineFromMetadata`, `snapshotPath`, `readSnapshot`, `writeSnapshot`.

**Scope:** Table/column/index/FK changes through the offline path. **Out of scope (own follow-up):** projection-**view** migrations in offline mode (the CLI handles those via the separate `projection-migrations` pipeline against introspected view bodies; offline-view parity reuses that and is a later task), and `--apply` in offline mode (`--apply` routes to the existing DB path, which needs a connection anyway).

**Working directory for all commands:** `server/typescript/packages/cli`.

---

### Task 1: `--from-db` flag + `baseline` subcommand in args + config

**Files:**
- Modify: `src/lib/args.ts` (`MigrateFlags` + `parseMigrateArgs`)
- Modify: `src/lib/config.ts` (`MigrateConfig` + `resolveMigrateConfig`)
- Test: `test/migrate-args.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate-args.test.ts
import { describe, test, expect } from "bun:test";
import { parseMigrateArgs } from "../src/lib/args.js";

describe("parseMigrateArgs — snapshot mode", () => {
  test("defaults: not from-db, not baseline", () => {
    const f = parseMigrateArgs([]);
    expect(f.fromDb).toBe(false);
    expect(f.baseline).toBe(false);
  });

  test("--from-db sets fromDb", () => {
    expect(parseMigrateArgs(["--from-db"]).fromDb).toBe(true);
  });

  test("'baseline' positional sets baseline", () => {
    const f = parseMigrateArgs(["baseline"]);
    expect(f.baseline).toBe(true);
    expect(f.fromDb).toBe(false);
  });

  test("'baseline --from-db' sets both", () => {
    const f = parseMigrateArgs(["baseline", "--from-db"]);
    expect(f.baseline).toBe(true);
    expect(f.fromDb).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/migrate-args.test.ts`
Expected: FAIL — `f.fromDb` is `undefined` (property doesn't exist yet).

- [ ] **Step 3: Implement — args.ts**

In `src/lib/args.ts`, add two fields to `interface MigrateFlags` (after `yes: boolean;`):

```ts
  /** Use live-DB introspection instead of the committed snapshot (legacy/adoption). */
  fromDb: boolean;
  /** `migrate baseline` subcommand: seed the snapshot, emit no migration. */
  baseline: boolean;
```

In `parseMigrateArgs`, add `"from-db"` to the `options` map and flip `allowPositionals` on:

```ts
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "db": { type: "string" },
      "dialect": { type: "string" },
      "out-dir": { type: "string" },
      "slug": { type: "string" },
      "allow": { type: "string" },
      "on-ambiguous": { type: "string" },
      "dry-run": { type: "boolean", default: false },
      "from-db": { type: "boolean", default: false },
      "d1": { type: "string" },
      "remote": { type: "boolean", default: false },
      "apply": { type: "boolean", default: false },
      "rollback": { type: "string" },
      "yes": { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  const baseline = positionals[0] === "baseline";
  if (positionals.length > 0 && !baseline) {
    throw new Error(`unknown migrate subcommand '${positionals[0]}'; expected 'baseline' or no subcommand`);
  }
```

Add the two fields to the returned object (after `yes: !!values.yes,`):

```ts
    fromDb: !!values["from-db"],
    baseline,
```

- [ ] **Step 4: Implement — config.ts**

In `src/lib/config.ts`, add to `interface ResolvedMigrateConfig` (the type `resolveMigrateConfig` returns; after `apply: boolean;`):

```ts
  /** Use live-DB introspection instead of the committed snapshot. */
  fromDb: boolean;
  /** Seed the snapshot and exit (no migration). */
  baseline: boolean;
```

In `resolveMigrateConfig`'s returned object (alongside `apply: flags.apply,`):

```ts
    fromDb: flags.fromDb,
    baseline: flags.baseline,
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test test/migrate-args.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/args.ts src/lib/config.ts test/migrate-args.test.ts
git commit -m "feat(cli): --from-db flag + baseline subcommand for migrate"
```

---

### Task 2: `runBaseline` + dispatch

**Files:**
- Modify: `src/commands/migrate.ts` (add `runBaseline`, dispatch, imports)
- Test: `test/migrate-baseline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate-baseline.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSnapshot, snapshotPath } from "@metaobjectsdev/migrate-ts";
import { runBaseline } from "../src/commands/migrate.js";

const dirs: string[] = [];
async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-cli-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(
    join(root, "metaobjects", "meta.orders.json"),
    JSON.stringify({
      "metadata.root": {
        children: [{
          "object.entity": {
            name: "Order",
            children: [
              { "field.long": { name: "id" } },
              { "field.string": { name: "ref" } },
              { "source.rdb": { name: "src", "@table": "orders" } },
              { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            ],
          },
        }],
      },
    }),
    "utf8",
  );
  return root;
}

afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

describe("runBaseline --from-metadata", () => {
  test("writes a per-dialect snapshot from metadata, no DB", async () => {
    const root = await project();
    const code = await runBaseline(
      { dialect: "postgres", outDir: "./.metaobjects/migrations", fromDb: false } as any,
      root,
    );
    expect(code).toBe(0);
    const snap = await readSnapshot(snapshotPath(join(root, ".metaobjects/migrations"), "postgres"));
    expect(snap?.tables.map((t) => t.name)).toEqual(["orders"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/migrate-baseline.test.ts`
Expected: FAIL — `runBaseline` is not exported.

- [ ] **Step 3: Implement**

In `src/commands/migrate.ts`, extend the `@metaobjectsdev/migrate-ts` import to add the snapshot helpers, e.g.:

```ts
import {
  buildExpectedSchema,
  introspect,
  diff,
  emit,
  writeMigration,
  // added:
  baselineFromMetadata,
  planOffline,
  snapshotPath,
  readSnapshot,
  writeSnapshot,
} from "@metaobjectsdev/migrate-ts";
```

Add the function (exported, so it's unit-testable) near the other `run*` helpers:

```ts
/**
 * `meta migrate baseline [--from-db]` — seed the committed reference snapshot.
 * `--from-metadata` (default) derives it from metadata; `--from-db` introspects
 * an existing database once. Emits no migration.
 */
export async function runBaseline(
  config: ResolvedMigrateConfig,
  metaRoot: string,
): Promise<number> {
  if (config.dialect === undefined) {
    log.error(`migrate baseline: --dialect required (or set migrate.dialect in .metaobjects/config.json)`);
    return 2;
  }
  let metadata;
  try {
    metadata = await loadMemory(metaRoot);
  } catch (err) {
    log.error(`migrate baseline: failed to load metadata: ${(err as Error).message}`);
    return 2;
  }
  const outDir = resolvePath(metaRoot, config.outDir);
  const path = snapshotPath(outDir, config.dialect);

  let snapshot;
  if (config.fromDb) {
    if (config.databaseUrl === undefined) {
      log.error(`migrate baseline --from-db: --db <url> required`);
      return 2;
    }
    let kysely;
    try {
      kysely = await buildKyselyFromUrl(config.databaseUrl, config.dialect);
    } catch (err) {
      log.error(`migrate baseline: ${(err as Error).message}`);
      return 2;
    }
    try {
      snapshot = await introspect(kysely.db, kysely.dialect);
    } finally {
      await kysely.close();
    }
  } else {
    snapshot = baselineFromMetadata(metadata, config.dialect);
  }

  await writeSnapshot(path, snapshot);
  log.info(`migrate: wrote schema snapshot ${path}`);
  return 0;
}
```

Dispatch it: in the main migrate command, immediately after `const config = await resolveMigrateConfig(flags, metaRoot);` and the d1 short-circuit, add:

```ts
  if (config.baseline) {
    return await runBaseline(config, metaRoot);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/migrate-baseline.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/migrate.ts test/migrate-baseline.test.ts
git commit -m "feat(cli): migrate baseline (--from-metadata default, --from-db introspect)"
```

---

### Task 3: `runOfflineGenerate` (default DB-free generate) + dispatch

**Files:**
- Modify: `src/commands/migrate.ts` (add `runOfflineGenerate`, dispatch)
- Test: `test/migrate-offline-gen.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/migrate-offline-gen.test.ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBaseline, runOfflineGenerate } from "../src/commands/migrate.js";

const dirs: string[] = [];
const ENTITY = (fields: string) => ({
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

async function project(fields: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-gen-"));
  dirs.push(root);
  await mkdir(join(root, "metaobjects"), { recursive: true });
  await writeFile(join(root, "metaobjects", "meta.orders.json"), JSON.stringify(ENTITY(fields)), "utf8");
  return root;
}
async function rewrite(root: string, fields: string): Promise<void> {
  await writeFile(join(root, "metaobjects", "meta.orders.json"), JSON.stringify(ENTITY(fields)), "utf8");
}

afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

const cfg = (root: string) =>
  ({ dialect: "sqlite", outDir: "./.metaobjects/migrations", onAmbiguous: "abort", allow: [], slug: "auto", dryRun: false } as any);

describe("runOfflineGenerate", () => {
  test("errors when no baseline snapshot exists", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    expect(await runOfflineGenerate(cfg(root), root)).toBe(2);
  });

  test("no changes right after baseline", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    await runBaseline(cfg(root), root);
    expect(await runOfflineGenerate(cfg(root), root)).toBe(0);
    // baseline writes only the snapshot, no migration dir
    const entries = await readdir(join(root, ".metaobjects/migrations"));
    expect(entries.filter((e) => !e.startsWith("."))).toHaveLength(0);
  });

  test("emits a migration when a field is added — offline, no DB", async () => {
    const root = await project('[{"field.string":{"name":"ref"}}]');
    await runBaseline(cfg(root), root);
    await rewrite(root, '[{"field.string":{"name":"ref"}},{"field.string":{"name":"note"}}]');
    expect(await runOfflineGenerate(cfg(root), root)).toBe(0);
    const entries = (await readdir(join(root, ".metaobjects/migrations"))).filter((e) => !e.startsWith("."));
    expect(entries).toHaveLength(1);
    // snapshot advanced: a second generate sees no changes
    expect(await runOfflineGenerate(cfg(root), root)).toBe(0);
    const after = (await readdir(join(root, ".metaobjects/migrations"))).filter((e) => !e.startsWith("."));
    expect(after).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/migrate-offline-gen.test.ts`
Expected: FAIL — `runOfflineGenerate` is not exported.

- [ ] **Step 3: Implement**

Add to `src/commands/migrate.ts` (exported). It reuses the existing helpers `loadMemory`, `resolvePath`, `mapOnAmbiguous`, `tokensToAllowOptions`, `log`, and the migrate-ts imports added in Task 2:

```ts
/**
 * Default `meta migrate` generate path — fully offline. Diffs metadata against
 * the committed snapshot (no DB), writes up/down.sql, and advances the snapshot.
 * The live-introspection path is used only with --from-db or --apply.
 *
 * Scope: table/column/index/FK changes. Projection-view migrations stay on the
 * introspection path (offline-view parity is a follow-up).
 */
export async function runOfflineGenerate(
  config: ResolvedMigrateConfig,
  metaRoot: string,
): Promise<number> {
  if (config.dialect === undefined) {
    log.error(`migrate: --dialect required for offline generation (or use --from-db)`);
    return 2;
  }
  let metadata;
  try {
    metadata = await loadMemory(metaRoot);
  } catch (err) {
    log.error(`migrate: failed to load metadata: ${(err as Error).message}`);
    return 2;
  }

  const outDir = resolvePath(metaRoot, config.outDir);
  const path = snapshotPath(outDir, config.dialect);
  const snapshot = await readSnapshot(path);
  if (snapshot === null) {
    log.error(`migrate: no schema snapshot at ${path}; run 'meta migrate baseline' first`);
    return 2;
  }

  const collectedAmbiguous: { tableOrColumn: string }[] = [];
  const onAmbiguousResolution = mapOnAmbiguous(config.onAmbiguous);

  let plan;
  try {
    plan = await planOffline({
      metadata,
      dialect: config.dialect,
      snapshot,
      allow: tokensToAllowOptions(config.allow),
      onAmbiguous: async (a) => {
        collectedAmbiguous.push(a as unknown as { tableOrColumn: string });
        return onAmbiguousResolution;
      },
    });
  } catch (err) {
    if ((err as Error).message.includes("aborted by onAmbiguous")) {
      log.error(`migrate: ambiguous rename/drop detected; re-run with --on-ambiguous rename|drop-add`);
      return 1;
    }
    throw err;
  }

  const { diff: diffResult, nextSnapshot } = plan;

  if (diffResult.blocked.length > 0) {
    log.error(`migrate: ${diffResult.blocked.length} destructive change(s) blocked; re-run with --allow <tokens>`);
    return 1;
  }
  if (diffResult.changes.length === 0) {
    log.info(`migrate: no changes`);
    return 0;
  }

  const emitResult = emit(diffResult.changes, {
    dialect: config.dialect,
    expectedSchema: nextSnapshot,
    ...(snapshot.meta ? { actualMeta: snapshot.meta } : {}),
  });

  if (config.dryRun) {
    log.info(`-- UP --\n${emitResult.up}\n\n-- DOWN --\n${emitResult.down}`);
    return 0;
  }

  await mkdir(outDir, { recursive: true });
  const res = await writeMigration(
    { up: emitResult.up, down: emitResult.down },
    { dir: outDir, slug: config.slug ?? "migration" },
  );
  await writeSnapshot(path, nextSnapshot);
  log.info(`migrate: wrote ${res.upPath}`);
  return 0;
}
```

Dispatch: in the main migrate command, after the `if (config.baseline)` dispatch from Task 2 and before the existing `if (config.databaseUrl === undefined)` guard, add:

```ts
  // Default = offline snapshot generation. The live-introspection path runs only
  // when explicitly requested via --from-db, or when --apply needs a connection.
  if (!config.fromDb && !config.apply) {
    return await runOfflineGenerate(config, metaRoot);
  }
```

Confirm `mkdir` is imported from `node:fs/promises` at the top of the file (the existing flow uses it at line 338; reuse that import).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/migrate-offline-gen.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the whole CLI suite + typecheck**

Run: `bun test` then `bun run build`
Expected: all CLI tests pass (existing `--from-db`/`--apply` behavior unchanged because the new path only triggers when `!fromDb && !apply`); `tsc` exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/commands/migrate.ts test/migrate-offline-gen.test.ts
git commit -m "feat(cli): default offline snapshot generation for migrate"
```

---

## Self-review notes (for the executor)

- **Spec coverage:** implements spec §6 commands (`baseline --from-db|--from-metadata`, default snapshot `gen`, `--from-db` escape hatch) and the §5 write-snapshot-on-accept. Verify-classification (§6 verify), down-from-snapshot (§5), and integrity (§8) remain their own plans.
- **Low-risk design:** the existing DB-coupled generate/apply/output flow is unmodified; the offline path is a separate early-return branch (`!fromDb && !apply`). `--from-db` and `--apply` behave exactly as before.
- **Type anchors:** `ResolvedMigrateConfig` is the config type used by the existing `run*` helpers (`src/commands/migrate.ts`); `loadMemory`, `resolvePath`, `buildKyselyFromUrl`, `mapOnAmbiguous`, `tokensToAllowOptions`, `log` are already imported in that file; the snapshot/plan API is from `@metaobjectsdev/migrate-ts` (Plan 1).
- **Known follow-ups (own tasks):** offline projection-view migrations; `--apply` combined with offline generate; the `collectedAmbiguous` typing is intentionally loose (`{ tableOrColumn }`) — tighten to the migrate-ts `AmbiguousChange` type if it's exported.
