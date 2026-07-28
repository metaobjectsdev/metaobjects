# `meta migrate apply-pending` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `meta migrate apply-pending` subcommand that replays the committed migration files against a DB (ledger-tracked, transactional), so a fresh/CI database can be provisioned without a bespoke script.

**Architecture:** A thin CLI wrapper over the already-public `applyPending(db, dir, opts)` from `@metaobjectsdev/migrate-ts`. It performs no diff and loads no metadata (unlike the diff-first `--apply`), so it works on an empty DB. It reuses the CLI's existing connection builder (`buildKyselyFromUrl`), migrations-dir resolution (`resolvePath(metaRoot, config.outDir)`), and error/report helpers.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `bun:test`, libSQL (via the CLI's own `buildKyselyFromUrl`) for the integration test.

**Design spec:** `docs/superpowers/specs/2026-07-27-migrate-apply-pending-cli-design.md`

## Global Constraints

- All changes in `server/typescript/packages/cli` (+ `CHANGELOG.md`, `docs/`). TS-only; no `@metaobjectsdev/migrate-ts` semantics change.
- No `any` in shipped source (existing tests may use `as any` for config fixtures — match the file's local convention). ESM only; every relative import ends in `.js`.
- Subcommand name is exactly `apply-pending`. postgres/sqlite only; `d1` is rejected with a pointer to `wrangler d1 migrations apply`.
- Exit codes: `0` success (including the "already up to date" no-op), `2` usage error (missing `--db`, d1, bad args), `1` apply failure (an `applyPending` throw).
- Run tests scoped from the cli package: `cd server/typescript/packages/cli && bun test <file>`. Never a bare repo-root `bun test`.
- An unrelated untracked `.serena/` directory exists in the repo — never stage it. Stage only the files each task changes; never `git add -A`.
- Commit directly to the current branch (`main`).

---

### Task 1: Parse `apply-pending` + thread it through config

**Files:**
- Modify: `src/lib/args.ts` (the `MigrateFlags` interface + `parseMigrateArgs`)
- Modify: `src/lib/config.ts` (the resolved-config type + `resolveMigrateConfig`)
- Test: `test/migrate-args.test.ts` (add cases; create the file if the existing arg tests live elsewhere — see Step 1)

**Interfaces:**
- Produces: `MigrateFlags.applyPending: boolean`; `parseMigrateArgs` accepts a leading `apply-pending` positional; the resolved config carries `applyPending: boolean` (same field name).

- [ ] **Step 1: Write the failing test**

Add to `test/migrate-args.test.ts` (it already imports `parseMigrateArgs` — confirm the import path; if the file does not exist, create it with `import { parseMigrateArgs } from "../src/lib/args.js";` and `import { describe, test, expect } from "bun:test";`):

```ts
describe("parseMigrateArgs — apply-pending subcommand", () => {
  test("recognizes the apply-pending positional", () => {
    const f = parseMigrateArgs(["apply-pending", "--db", "file:t.db", "--dialect", "sqlite"]);
    expect(f.applyPending).toBe(true);
    expect(f.baseline).toBe(false);
    expect(f.db).toBe("file:t.db");
    expect(f.dialect).toBe("sqlite");
  });

  test("no subcommand → applyPending false", () => {
    expect(parseMigrateArgs([]).applyPending).toBe(false);
  });

  test("baseline positional still parses and does not set applyPending", () => {
    const f = parseMigrateArgs(["baseline"]);
    expect(f.baseline).toBe(true);
    expect(f.applyPending).toBe(false);
  });

  test("an unknown subcommand still throws, now listing apply-pending", () => {
    expect(() => parseMigrateArgs(["bogus"])).toThrow(/unknown migrate subcommand/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/migrate-args.test.ts`
Expected: FAIL — `f.applyPending` is `undefined` (property does not exist yet).

- [ ] **Step 3: Implement the parse + config plumbing**

In `src/lib/args.ts`, add to the `MigrateFlags` interface (next to `baseline: boolean;`):

```ts
  /** `migrate apply-pending` subcommand: replay committed migration files, no diff. */
  applyPending: boolean;
```

In `parseMigrateArgs`, replace the existing positional handling:

```ts
  const baseline = positionals[0] === "baseline";
  if (positionals.length > 0 && !baseline) {
    throw new Error(`unknown migrate subcommand '${positionals[0]}'; expected 'baseline' or no subcommand`);
  }
```

with:

```ts
  const baseline = positionals[0] === "baseline";
  const applyPending = positionals[0] === "apply-pending";
  if (positionals.length > 0 && !baseline && !applyPending) {
    throw new Error(`unknown migrate subcommand '${positionals[0]}'; expected 'baseline', 'apply-pending', or no subcommand`);
  }
```

and add `applyPending,` to the returned object (next to `baseline: flags.baseline` — here the local is named `applyPending`, so `applyPending,`).

In `src/lib/config.ts`, add `applyPending: boolean;` to the resolved-config interface next to `baseline: boolean;`, and in `resolveMigrateConfig`'s returned object add `applyPending: flags.applyPending,` next to `baseline: flags.baseline,`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/migrate-args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/args.ts src/lib/config.ts test/migrate-args.test.ts
git commit -m "feat(#242): parse the migrate apply-pending subcommand"
```

---

### Task 2: `runApplyPending` handler + dispatch + d1 rejection + help + tests

**Files:**
- Modify: `src/commands/migrate.ts` (help text, d1 rejection, dispatch, new `runApplyPending`)
- Test: `test/migrate-apply-pending.test.ts` (new)

**Interfaces:**
- Consumes: `applyPending`, `resolvePath`, `buildKyselyFromUrl`, `emitStructuredError`, `toonEncode`, `log`, `OutputFormat`, the resolved-config type — all already imported in `migrate.ts`. Task 1's `config.applyPending`.
- Produces: `export async function runApplyPending(config, metaRoot, fmt): Promise<number>`.

- [ ] **Step 1: Write the failing tests**

Create `test/migrate-apply-pending.test.ts`:

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { migrateCommand } from "../src/commands/migrate.js";
import { buildKyselyFromUrl } from "../src/lib/kysely.js";

const dirs: string[] = [];
afterAll(async () => { for (const d of dirs) await rm(d, { recursive: true, force: true }); });

// A project root with two committed migration files under the default migrations dir.
async function projectWithMigrations(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mts-applypending-"));
  dirs.push(root);
  const migDir = join(root, ".metaobjects", "migrations");
  await mkdir(join(migDir, "0001-init"), { recursive: true });
  await writeFile(join(migDir, "0001-init", "up.sql"),
    `CREATE TABLE "widgets" ("id" integer primary key, "name" text not null);`, "utf8");
  await mkdir(join(migDir, "0002-view"), { recursive: true });
  await writeFile(join(migDir, "0002-view", "up.sql"),
    `CREATE VIEW "widget_names" AS SELECT "name" FROM "widgets";`, "utf8");
  return root;
}

async function relationNames(dbFile: string): Promise<string[]> {
  const k = await buildKyselyFromUrl(`file:${dbFile}`, "sqlite");
  try {
    const rows = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type IN ('table','view') ORDER BY name`.execute(k.db);
    return rows.rows.map((r) => r.name);
  } finally {
    await k.close();
  }
}

describe("meta migrate apply-pending", () => {
  test("provisions a fresh DB from committed migrations, ledger-tracked", async () => {
    const root = await projectWithMigrations();
    const db = join(root, "t.db");
    const code = await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root);
    expect(code).toBe(0);
    const names = await relationNames(db);
    expect(names).toContain("widgets");
    expect(names).toContain("widget_names");
    expect(names).toContain("_metaobjects_migrations");
  });

  test("is idempotent — a second run applies nothing", async () => {
    const root = await projectWithMigrations();
    const db = join(root, "t.db");
    expect(await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root)).toBe(0);
    // Second run: still exit 0, ledger unchanged (2 rows).
    expect(await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root)).toBe(0);
    const k = await buildKyselyFromUrl(`file:${db}`, "sqlite");
    try {
      const r = await sql<{ n: number }>`SELECT count(*) AS n FROM _metaobjects_migrations`.execute(k.db);
      expect(Number(r.rows[0]!.n)).toBe(2);
    } finally { await k.close(); }
  });

  test("--dry-run lists pending without applying", async () => {
    const root = await projectWithMigrations();
    const db = join(root, "t.db");
    const code = await migrateCommand(
      ["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite", "--dry-run"], root);
    expect(code).toBe(0);
    // Nothing applied → the widgets table must NOT exist.
    const names = await relationNames(db);
    expect(names).not.toContain("widgets");
  });

  test("missing --db → exit 2", async () => {
    const root = await projectWithMigrations();
    expect(await migrateCommand(["apply-pending", "--dialect", "sqlite"], root)).toBe(2);
  });

  test("d1 is rejected → exit 2", async () => {
    const root = await projectWithMigrations();
    expect(await migrateCommand(["apply-pending", "--dialect", "d1"], root)).toBe(2);
  });

  test("tamper guard surfaces as exit 1", async () => {
    const root = await projectWithMigrations();
    const db = join(root, "t.db");
    expect(await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root)).toBe(0);
    // Edit an already-applied up.sql → checksum guard throws → exit 1.
    await writeFile(join(root, ".metaobjects", "migrations", "0001-init", "up.sql"),
      `CREATE TABLE "widgets" ("id" integer primary key, "name" text);`, "utf8");
    expect(await migrateCommand(["apply-pending", "--db", `file:${db}`, "--dialect", "sqlite"], root)).toBe(1);
  });
});
```

Note: if `sql` from `kysely` or `buildKyselyFromUrl` does not resolve in the cli test environment, assert relations via `@metaobjectsdev/migrate-ts`'s `introspectSqlite(k.db)` (already a cli dependency) instead — the invariant to assert is "widgets + widget_names + the ledger table exist after a real run, and don't after dry-run."

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/migrate-apply-pending.test.ts`
Expected: FAIL — `migrateCommand(["apply-pending", …])` does not dispatch yet (it currently falls through to the offline/diff path, so the assertions fail).

- [ ] **Step 3: Implement the handler + wiring**

In `src/commands/migrate.ts`:

**(a) Help text.** In `MIGRATE_HELP_TEXT`, add the subcommand under the existing `baseline` line and one example under the existing examples:

```
  apply-pending        Replay committed migration files against --db (no diff);
                       provisions a fresh/CI database. postgres/sqlite only.
```
example line:
```
  meta migrate apply-pending --db postgresql://localhost/mydb
```

**(b) d1 rejection.** In the `if (config.dialect === "d1") { … }` block, immediately after the existing `if (config.baseline) { … return 2; }` rejection, add:

```ts
    if (config.applyPending) {
      log.error(`migrate apply-pending is not supported for dialect 'd1' — use 'wrangler d1 migrations apply' to replay committed migrations`);
      emitStructuredError(
        `migrate apply-pending is not supported for dialect 'd1'`,
        "use 'wrangler d1 migrations apply' to replay committed migrations for d1",
        fmt,
      );
      return 2;
    }
```

**(c) Dispatch.** Immediately after the existing `if (config.baseline) { return await runBaseline(config, metaRoot, fmt); }`, add:

```ts
  // `migrate apply-pending` — replay committed migration files; no diff, no metadata load.
  if (config.applyPending) {
    return await runApplyPending(config, metaRoot, fmt);
  }
```

**(d) The handler.** Add this exported function (place it next to `runBaseline`):

```ts
/**
 * `meta migrate apply-pending` — replay the committed migration files against the
 * target DB, ledger-tracked and transactional (no diff, no metadata load). This is the
 * fresh-DB / CI provisioning path the diff-first `--apply` cannot serve. postgres/sqlite
 * only (d1 replays via `wrangler d1 migrations apply`). See #242.
 */
export async function runApplyPending(
  config: ResolvedMigrateConfig,
  metaRoot: string,
  fmt: OutputFormat = "text",
): Promise<number> {
  if (config.databaseUrl === undefined) {
    log.error(`migrate apply-pending: --db <url> required (or set DATABASE_URL, or add migrate.databaseUrl to .metaobjects/config.json)`);
    emitStructuredError(
      `migrate apply-pending: --db <url> required`,
      "pass --db <url>, set DATABASE_URL, or add migrate.databaseUrl to .metaobjects/config.json",
      fmt,
    );
    return 2;
  }

  let kysely;
  try {
    kysely = await buildKyselyFromUrl(config.databaseUrl, config.dialect);
  } catch (err) {
    log.error(`migrate apply-pending: ${(err as Error).message}`);
    return 2;
  }

  const outDir = resolvePath(metaRoot, config.outDir);
  let exitCode = 0;
  let pendingNames: string[] = [];
  let appliedNames: string[] = [];
  try {
    const result = await applyPending(kysely.db, outDir, {
      dryRun: config.dryRun,
      dialect: kysely.dialect as "sqlite" | "postgres",
    });
    pendingNames = [...result.pending];
    appliedNames = [...result.applied];
  } catch (err) {
    log.error(`migrate apply-pending: apply failed: ${(err as Error).message}`);
    exitCode = 1;
  } finally {
    try {
      await kysely.close();
    } catch (err) {
      log.warn(`migrate apply-pending: failed to close DB cleanly: ${(err as Error).message}`);
    }
  }
  if (exitCode !== 0) return exitCode;

  const payload = {
    command: "apply-pending",
    dialect: kysely.dialect,
    displayUrl: kysely.displayUrl,
    dryRun: config.dryRun,
    pending: pendingNames,
    applied: appliedNames,
  };
  if (fmt === "json") {
    log.info(JSON.stringify(payload, null, 2));
  } else if (fmt === "toon") {
    log.info(toonEncode(payload));
  } else if (config.dryRun) {
    log.info(
      pendingNames.length > 0
        ? `migrate apply-pending (dry-run): ${pendingNames.length} pending: ${pendingNames.join(", ")}`
        : `migrate apply-pending (dry-run): already up to date`,
    );
  } else {
    log.info(
      appliedNames.length > 0
        ? `migrate apply-pending: applied ${appliedNames.length} migration(s): ${appliedNames.join(", ")}`
        : `migrate apply-pending: already up to date`,
    );
  }
  return 0;
}
```

Confirm `ResolvedMigrateConfig`, `toonEncode`, `resolvePath`, `applyPending`, `buildKyselyFromUrl`, `emitStructuredError`, `log`, `OutputFormat` are already imported in `migrate.ts` (they are — used by the existing `--apply` path and `emitStructuredError`). If any is not, add the import from the same module the existing code uses.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/migrate-apply-pending.test.ts test/migrate-args.test.ts`
Expected: PASS (all apply-pending cases + Task 1's arg tests).

- [ ] **Step 5: Run the cli package suite once to confirm no regression**

Run: `bun test`
Expected: PASS (existing migrate/baseline/ux tests unaffected — apply-pending is a new positional; the `unknown migrate subcommand` message changed to also list `apply-pending`, so update any test asserting that exact string).

- [ ] **Step 6: Commit**

```bash
git add src/commands/migrate.ts test/migrate-apply-pending.test.ts
git commit -m "feat(#242): meta migrate apply-pending — replay committed migrations"
```

---

### Task 3: Docs + CHANGELOG

**Files:**
- Modify: `docs/features/migrations-and-drift.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Document the subcommand**

In `docs/features/migrations-and-drift.md`, near the existing `meta migrate` subcommand descriptions (search for `baseline` / `--apply`), add a short paragraph:

```markdown
**`meta migrate apply-pending`** replays the committed migration files against `--db`
in order, ledger-tracked (`_metaobjects_migrations`) and transactional — with **no
diff and no metadata load**. It is the way to provision a fresh or CI database from the
committed migrations: `meta migrate --apply` is diff-first and cannot bootstrap an empty
DB, whereas `apply-pending` just runs the pending files (idempotent; `--dry-run` lists
what would run). postgres/sqlite only — on D1 use `wrangler d1 migrations apply`.
```

- [ ] **Step 2: CHANGELOG entry**

In `CHANGELOG.md`, under the existing `## [Unreleased]` section (add the section above `## [0.20.6]` if it is not present), add:

```markdown
### Added — `meta migrate apply-pending` (#242)

npm-only (`@metaobjectsdev/cli`). A first-class subcommand that replays the committed
migration files against `--db` (ledger-tracked, transactional) with no diff and no
metadata load — the fresh-DB / CI provisioning path the diff-first `meta migrate
--apply` cannot serve (on an empty DB `--apply` exits before `applyPending` runs, or
authors a redundant migration). A thin wrapper over the already-public `applyPending`;
idempotent, `--dry-run` lists pending. postgres/sqlite only (D1 uses `wrangler d1
migrations apply`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/features/migrations-and-drift.md CHANGELOG.md
git commit -m "docs(#242): document meta migrate apply-pending"
```

---

## Self-Review

**Spec coverage:**
- Subcommand parsed like `baseline` → Task 1 (`parseMigrateArgs` + config).
- Standalone handler, no diff/metadata → Task 2 (`runApplyPending`, dispatched before the diff path).
- Reuse `buildKyselyFromUrl` / `resolvePath` / `applyPending` → Task 2 handler.
- d1 rejected with wrangler pointer → Task 2 (b) + test.
- Require `--db` → Task 2 handler + test.
- Exit codes 0/2/1 → Task 2 handler + tests (provision=0, missing-db=2, d1=2, tamper=1).
- `--dry-run` lists pending without applying → Task 2 handler + test.
- "already up to date" no-op → Task 2 handler (idempotent test asserts second run = 0, ledger unchanged).
- Help text → Task 2 (a).
- Docs + CHANGELOG → Task 3.

**Placeholder scan:** No TBD/TODO. Task 1 Step 1 and Task 2 Step 1 name a concrete fallback (the arg-test file location; the `introspectSqlite` assertion path) with the exact invariant to satisfy — a contingency, not a gap.

**Type consistency:** `applyPending` is the field name in `MigrateFlags`, the resolved config, and every `config.applyPending` read. `runApplyPending(config: ResolvedMigrateConfig, metaRoot: string, fmt: OutputFormat)` matches `runBaseline`'s signature. `applyPending(db, dir, { dryRun, dialect })` matches `ApplyPendingOptions`; the result's `.pending`/`.applied` are `string[]` per `ApplyPendingResult`. `kysely.db` / `kysely.dialect` / `kysely.displayUrl` / `kysely.close()` match the `--apply` path's usage of the same `KyselyHandle`.
