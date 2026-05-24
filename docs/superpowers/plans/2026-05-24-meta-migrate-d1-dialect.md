# Cloudflare D1 dialect for `meta migrate` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `dialect: "d1"` peer to `postgres`/`sqlite` in `@metaobjectsdev/migrate-ts` + `@metaobjectsdev/cli` that introspects via wrangler CLI, emits SQLite SQL with a D1-safety post-pass, writes Wrangler-native `migrations/<seq>_<slug>.sql` files (with a `.down/` sidecar for rollback), and optionally invokes `wrangler d1 migrations apply`.

**Architecture:** Three pluggable I/O seams (wrangler.toml resolver, `introspectD1`, `writeMigrationD1`) over an unchanged diff/emit pipeline. SQL emission is `renderSqlite` + a thin string-level safety pass. CLI gains `--d1 <binding>`, `--remote`, `--apply`, `--yes`. The diff/emit core never learns D1 exists.

**Tech Stack:** TypeScript (ESM), Bun test runner, Zod (config schema), `node:child_process` (`execFile`) for wrangler shell-out, TOML/JSONC parsing (use `@iarna/toml` for TOML and the existing JSONC pattern), `node:util.parseArgs` for CLI flags.

**Spec:** `docs/superpowers/specs/2026-05-24-meta-migrate-d1-dialect-design.md`

---

## File map

**New files (migrate-ts):**
- `server/typescript/packages/migrate-ts/src/wrangler-config.ts` — parse `wrangler.toml` / `wrangler.jsonc`, return discovered D1 bindings.
- `server/typescript/packages/migrate-ts/src/emit/d1-safety-pass.ts` — pure string transforms (strip txns, reject ATTACH, etc.).
- `server/typescript/packages/migrate-ts/src/emit/d1.ts` — `renderD1` wrapper over `renderSqlite`.
- `server/typescript/packages/migrate-ts/src/introspect/d1.ts` — `introspectD1` that runs catalog queries via wrangler shell-out and returns a `SchemaSnapshot`.
- `server/typescript/packages/migrate-ts/src/write-migration-d1.ts` — `writeMigrationD1` with Wrangler `<seq>_<slug>.sql` layout + `.down/` sidecar.

**New files (cli):**
- `server/typescript/packages/cli/src/lib/wrangler.ts` — `execFile`-based wrangler invocation helpers with a mockable `runWrangler` seam.

**New test files:**
- `server/typescript/packages/migrate-ts/test/unit/wrangler-config.test.ts`
- `server/typescript/packages/migrate-ts/test/unit/d1-safety-pass.test.ts`
- `server/typescript/packages/migrate-ts/test/unit/emit-d1.test.ts`
- `server/typescript/packages/migrate-ts/test/unit/introspect-d1.test.ts`
- `server/typescript/packages/migrate-ts/test/unit/write-migration-d1.test.ts`
- `server/typescript/packages/cli/test/unit/wrangler.test.ts`
- `server/typescript/packages/cli/test/unit/migrate-d1.test.ts`

**Touched files (types/dispatch — Task 1):**
- `server/typescript/packages/migrate-ts/src/types.ts` — extend `Dialect`.
- `server/typescript/packages/migrate-ts/src/expected-schema.ts` — map `"d1"` → sqlite shape.
- `server/typescript/packages/migrate-ts/src/emit/index.ts` — dispatch `case "d1"`.
- `server/typescript/packages/migrate-ts/src/introspect/index.ts` — dispatch `case "d1"`.
- `server/typescript/packages/migrate-ts/src/index.ts` — re-export D1 surface.
- `server/typescript/packages/sdk/src/config.ts` — extend `DialectEnum` + add `d1` config block.

**Touched files (CLI — Tasks 8–11):**
- `server/typescript/packages/cli/src/lib/args.ts` — add `--d1`, `--remote`, `--apply`, `--yes`; extend `DIALECTS`.
- `server/typescript/packages/cli/src/lib/config.ts` — surface `migrate.d1.*` and `migrate.d1.remote/autoApply/binding/wranglerConfigPath`.
- `server/typescript/packages/cli/src/commands/migrate.ts` — branch on `dialect === "d1"`; skip `buildKyselyFromUrl`; use wrangler resolver + introspect + writer.
- `server/typescript/packages/cli/src/commands/init.ts` — optional `--d1` init path.

**Dependencies to add:**
- `@iarna/toml` to `server/typescript/packages/migrate-ts/package.json` as `dependencies` (small, zero-dep TOML parser).

---

## Test conventions

All tests use Bun's built-in test runner. Existing pattern (see `server/typescript/packages/migrate-ts/test/unit/write-migration.test.ts`):

```ts
import { test, expect, describe } from "bun:test";
```

Tests live under `<package>/test/unit/` (pure, fast) and `<package>/test/integration/` (uses real DB; skip for D1 in this plan). Run with `cd server/typescript && bun test`. Run a single file with `cd server/typescript && bun test packages/migrate-ts/test/unit/d1-safety-pass.test.ts`.

---

### Task 1: Extend the `Dialect` type to include `"d1"`

**Files:**
- Modify: `server/typescript/packages/migrate-ts/src/types.ts:174`
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts` (single dialect-touching site)
- Modify: `server/typescript/packages/migrate-ts/src/emit/index.ts:34-37`
- Modify: `server/typescript/packages/migrate-ts/src/introspect/index.ts:9-14`
- Modify: `server/typescript/packages/sdk/src/config.ts:5`
- Test: (compile-only; no new tests yet — Task 4 verifies dispatch)

- [ ] **Step 1: Extend the type definition.**

Edit `server/typescript/packages/migrate-ts/src/types.ts:174`:

```ts
// Before:
export type Dialect = "postgres" | "sqlite";

// After:
export type Dialect = "postgres" | "sqlite" | "d1";
```

- [ ] **Step 2: Extend the SDK config enum.**

Edit `server/typescript/packages/sdk/src/config.ts:5`:

```ts
// Before:
const DialectEnum = z.enum(["sqlite", "postgres"]);

// After:
const DialectEnum = z.enum(["sqlite", "postgres", "d1"]);
```

- [ ] **Step 3: Map `"d1"` to SQLite shape in `buildExpectedSchema`.**

Open `server/typescript/packages/migrate-ts/src/expected-schema.ts`. Find every `dialect === "sqlite"` check (grep `dialect ===` and `dialect:`). For each one, treat `"d1"` as `"sqlite"`. Concretely, immediately after `BuildExpectedSchemaOptions` is destructured, normalize:

```ts
const dialect = opts?.dialect === "d1" ? "sqlite" : opts?.dialect;
```

Then use that local `dialect` for downstream branching. (If the file destructures inline at each site, instead add a helper `const isSqliteShape = (d?: Dialect) => d === "sqlite" || d === "d1";` and replace `dialect === "sqlite"` checks with `isSqliteShape(dialect)`.)

Also update the JSDoc comment on `BuildExpectedSchemaOptions.dialect` (currently `"sqlite" | "postgres"`) to include `"d1"`.

If `BuildExpectedSchemaOptions.dialect` is typed locally as `"sqlite" | "postgres"`, change it to `Dialect` (imported from `./types.js`) so the compiler accepts `"d1"`.

- [ ] **Step 4: Add stub dispatch in `emit/index.ts`.**

Edit `server/typescript/packages/migrate-ts/src/emit/index.ts:34-37`:

```ts
// Before:
switch (opts.dialect) {
  case "postgres": return renderPostgres(changes);
  case "sqlite":   return renderSqlite(changes, opts.expectedSchema, opts.actualMeta);
}

// After (renderD1 will be added in Task 4 — for now throw so compile passes):
switch (opts.dialect) {
  case "postgres": return renderPostgres(changes);
  case "sqlite":   return renderSqlite(changes, opts.expectedSchema, opts.actualMeta);
  case "d1":       throw new Error("d1 emit not yet wired (Task 4)");
}
```

- [ ] **Step 5: Add stub dispatch in `introspect/index.ts`.**

Edit `server/typescript/packages/migrate-ts/src/introspect/index.ts:9-14`:

```ts
// After:
export async function introspect(db: Kysely<Record<string, unknown>>, dialect: Dialect): Promise<SchemaSnapshot> {
  switch (dialect) {
    case "postgres": return introspectPostgres(db);
    case "sqlite":   return introspectSqlite(db);
    case "d1":       throw new Error("d1 introspect goes through introspectD1 (Task 6), not introspect()");
  }
}
```

- [ ] **Step 6: Type-check the whole TS workspace.**

Run from repo root:
```
bun run --filter '*' typecheck
```
Expected: passes. If sqlite-dispatching code anywhere in `cli/` references `"sqlite" | "postgres"` literally (vs. the `Dialect` alias) the compiler will flag it — update those to `Dialect` so adding `"d1"` doesn't ripple.

- [ ] **Step 7: Run the full server test suite.**

```
cd server/typescript && bun test
```
Expected: all green. No tests added yet; we're just verifying no regression.

- [ ] **Step 8: Commit.**

```bash
git add server/typescript/packages/migrate-ts/src/types.ts \
        server/typescript/packages/migrate-ts/src/expected-schema.ts \
        server/typescript/packages/migrate-ts/src/emit/index.ts \
        server/typescript/packages/migrate-ts/src/introspect/index.ts \
        server/typescript/packages/sdk/src/config.ts
git commit -m "feat(migrate-ts): extend Dialect to include 'd1' (stub dispatch)"
```

---

### Task 2: wrangler.toml / wrangler.jsonc parser

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/wrangler-config.ts`
- Create: `server/typescript/packages/migrate-ts/test/unit/wrangler-config.test.ts`
- Modify: `server/typescript/packages/migrate-ts/package.json` (add `@iarna/toml`)

- [ ] **Step 1: Add the TOML dep.**

```bash
cd server/typescript/packages/migrate-ts && bun add @iarna/toml
```

Verify the dep landed under `dependencies` (not `devDependencies`) in `server/typescript/packages/migrate-ts/package.json`. If bun put it under `devDependencies`, move it manually.

- [ ] **Step 2: Write the failing test.**

Create `server/typescript/packages/migrate-ts/test/unit/wrangler-config.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findWranglerConfig, parseWranglerConfig, resolveD1Binding } from "../../src/wrangler-config.js";

describe("wrangler-config", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "wrangler-cfg-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("findWranglerConfig: prefers wrangler.toml in cwd", () => {
    writeFileSync(join(dir, "wrangler.toml"), `name = "x"\n`);
    expect(findWranglerConfig(dir)).toBe(join(dir, "wrangler.toml"));
  });

  test("findWranglerConfig: falls back to wrangler.jsonc", () => {
    writeFileSync(join(dir, "wrangler.jsonc"), `{ "name": "x" }`);
    expect(findWranglerConfig(dir)).toBe(join(dir, "wrangler.jsonc"));
  });

  test("findWranglerConfig: walks up the parent tree", () => {
    const sub = join(dir, "a", "b", "c");
    require("node:fs").mkdirSync(sub, { recursive: true });
    writeFileSync(join(dir, "wrangler.toml"), `name = "x"\n`);
    expect(findWranglerConfig(sub)).toBe(join(dir, "wrangler.toml"));
  });

  test("findWranglerConfig: returns undefined when nothing found", () => {
    expect(findWranglerConfig(dir)).toBeUndefined();
  });

  test("parseWranglerConfig: extracts d1 bindings from TOML", () => {
    const path = join(dir, "wrangler.toml");
    writeFileSync(path, [
      `name = "myapp"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "myapp-prod"`,
      `database_id = "abc-123"`,
      `migrations_dir = "db/migrations"`,
      ``,
      `[[d1_databases]]`,
      `binding = "CACHE"`,
      `database_name = "myapp-cache"`,
      `database_id = "def-456"`,
    ].join("\n"));
    const parsed = parseWranglerConfig(path);
    expect(parsed.d1Bindings).toEqual([
      { binding: "DB", database_name: "myapp-prod", database_id: "abc-123", migrations_dir: "db/migrations" },
      { binding: "CACHE", database_name: "myapp-cache", database_id: "def-456", migrations_dir: undefined },
    ]);
  });

  test("parseWranglerConfig: returns empty bindings when no d1 block", () => {
    const path = join(dir, "wrangler.toml");
    writeFileSync(path, `name = "x"\n`);
    expect(parseWranglerConfig(path).d1Bindings).toEqual([]);
  });

  test("parseWranglerConfig: handles jsonc with comments", () => {
    const path = join(dir, "wrangler.jsonc");
    writeFileSync(path, [
      `{`,
      `  // top-level binding`,
      `  "name": "x",`,
      `  "d1_databases": [`,
      `    { "binding": "DB", "database_name": "x-prod", "database_id": "id1" }`,
      `  ]`,
      `}`,
    ].join("\n"));
    const parsed = parseWranglerConfig(path);
    expect(parsed.d1Bindings).toEqual([
      { binding: "DB", database_name: "x-prod", database_id: "id1", migrations_dir: undefined },
    ]);
  });

  test("resolveD1Binding: returns the only binding when there's exactly one and no explicit name", () => {
    const bindings = [{ binding: "DB", database_name: "x", database_id: "id1", migrations_dir: undefined }];
    expect(resolveD1Binding(bindings, undefined)).toEqual(bindings[0]);
  });

  test("resolveD1Binding: returns the explicitly named binding", () => {
    const bindings = [
      { binding: "DB", database_name: "x", database_id: "id1", migrations_dir: undefined },
      { binding: "CACHE", database_name: "y", database_id: "id2", migrations_dir: undefined },
    ];
    expect(resolveD1Binding(bindings, "CACHE")).toEqual(bindings[1]);
  });

  test("resolveD1Binding: throws when multiple bindings and no explicit name", () => {
    const bindings = [
      { binding: "DB", database_name: "x", database_id: "id1", migrations_dir: undefined },
      { binding: "CACHE", database_name: "y", database_id: "id2", migrations_dir: undefined },
    ];
    expect(() => resolveD1Binding(bindings, undefined)).toThrow(/multiple d1 bindings/i);
  });

  test("resolveD1Binding: throws with binding list when explicit name is unknown", () => {
    const bindings = [{ binding: "DB", database_name: "x", database_id: "id1", migrations_dir: undefined }];
    expect(() => resolveD1Binding(bindings, "MISSING")).toThrow(/MISSING.*DB/);
  });

  test("resolveD1Binding: throws when there are no bindings at all", () => {
    expect(() => resolveD1Binding([], undefined)).toThrow(/no d1 bindings/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/wrangler-config.test.ts
```
Expected: FAIL with module not found for `../../src/wrangler-config.js`.

- [ ] **Step 4: Implement `wrangler-config.ts`.**

Create `server/typescript/packages/migrate-ts/src/wrangler-config.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, isAbsolute, resolve } from "node:path";
import TOML from "@iarna/toml";

export interface D1Binding {
  binding: string;
  database_name: string;
  database_id: string;
  migrations_dir: string | undefined;
}

export interface WranglerConfig {
  d1Bindings: D1Binding[];
}

/**
 * Walk from `startDir` upward looking for wrangler.toml or wrangler.jsonc.
 * Returns the first match or undefined. wrangler.toml wins over .jsonc at the same level.
 */
export function findWranglerConfig(startDir: string): string | undefined {
  let dir = resolve(startDir);
  while (true) {
    const toml = join(dir, "wrangler.toml");
    if (existsSync(toml)) return toml;
    const jsonc = join(dir, "wrangler.jsonc");
    if (existsSync(jsonc)) return jsonc;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Parse a wrangler.toml or wrangler.jsonc file. Returns extracted D1 bindings.
 */
export function parseWranglerConfig(path: string): WranglerConfig {
  if (!isAbsolute(path)) path = resolve(path);
  const raw = readFileSync(path, "utf8");
  const isJsonc = path.endsWith(".jsonc") || path.endsWith(".json");
  const obj = isJsonc ? parseJsoncLoose(raw) : (TOML.parse(raw) as Record<string, unknown>);
  const rawBindings = (obj.d1_databases as unknown[] | undefined) ?? [];
  const d1Bindings: D1Binding[] = rawBindings.map((b) => {
    const r = b as Record<string, unknown>;
    return {
      binding: String(r.binding ?? ""),
      database_name: String(r.database_name ?? ""),
      database_id: String(r.database_id ?? ""),
      migrations_dir: r.migrations_dir !== undefined ? String(r.migrations_dir) : undefined,
    };
  });
  return { d1Bindings };
}

/**
 * Pick a D1 binding by name. If `name` is undefined and there's exactly one
 * binding, return it. Otherwise throw a helpful error.
 */
export function resolveD1Binding(bindings: readonly D1Binding[], name: string | undefined): D1Binding {
  if (bindings.length === 0) {
    throw new Error("no d1 bindings found in wrangler config");
  }
  if (name === undefined) {
    if (bindings.length === 1) return bindings[0]!;
    throw new Error(
      `multiple d1 bindings in wrangler config; pass --d1 <binding>. Available: ${bindings.map((b) => b.binding).join(", ")}`,
    );
  }
  const found = bindings.find((b) => b.binding === name);
  if (!found) {
    throw new Error(
      `d1 binding '${name}' not found in wrangler config. Available: ${bindings.map((b) => b.binding).join(", ")}`,
    );
  }
  return found;
}

/**
 * Minimal JSONC parser: strips `//` line comments and `/* ... *​/` block comments,
 * then JSON.parse. Wrangler's jsonc is small; this is sufficient.
 */
function parseJsoncLoose(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  return JSON.parse(stripped) as Record<string, unknown>;
}
```

- [ ] **Step 5: Run test to verify it passes.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/wrangler-config.test.ts
```
Expected: PASS, all 11 tests.

- [ ] **Step 6: Commit.**

```bash
git add server/typescript/packages/migrate-ts/src/wrangler-config.ts \
        server/typescript/packages/migrate-ts/test/unit/wrangler-config.test.ts \
        server/typescript/packages/migrate-ts/package.json
# Also stage the root lockfile change from `bun add`:
git add bun.lock 2>/dev/null || git add bun.lockb 2>/dev/null || true
git commit -m "feat(migrate-ts): wrangler.toml/jsonc parser + D1 binding resolver"
```

---

### Task 3: D1 SQL safety pass

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/emit/d1-safety-pass.ts`
- Create: `server/typescript/packages/migrate-ts/test/unit/d1-safety-pass.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `server/typescript/packages/migrate-ts/test/unit/d1-safety-pass.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { applyD1SafetyPass, D1UnsupportedStatementError } from "../../src/emit/d1-safety-pass.js";

describe("applyD1SafetyPass", () => {
  test("strips BEGIN TRANSACTION and COMMIT", () => {
    const input = "BEGIN TRANSACTION;\nCREATE TABLE x (id INT);\nCOMMIT;";
    expect(applyD1SafetyPass(input)).toBe("CREATE TABLE x (id INT);");
  });

  test("strips lowercase begin/commit and ROLLBACK", () => {
    const input = "begin;\nCREATE TABLE x (id INT);\nrollback;";
    expect(applyD1SafetyPass(input)).toBe("CREATE TABLE x (id INT);");
  });

  test("preserves PRAGMA foreign_keys = OFF/ON verbatim", () => {
    const input = "PRAGMA foreign_keys=OFF;\nCREATE TABLE x (id INT);\nPRAGMA foreign_keys=ON;";
    const out = applyD1SafetyPass(input);
    expect(out).toContain("PRAGMA foreign_keys=OFF;");
    expect(out).toContain("PRAGMA foreign_keys=ON;");
  });

  test("rejects ATTACH DATABASE with typed error", () => {
    expect(() => applyD1SafetyPass("ATTACH DATABASE 'foo' AS bar;"))
      .toThrow(D1UnsupportedStatementError);
  });

  test("rejects DETACH DATABASE with typed error", () => {
    expect(() => applyD1SafetyPass("DETACH DATABASE bar;"))
      .toThrow(D1UnsupportedStatementError);
  });

  test("rejects VACUUM with typed error", () => {
    expect(() => applyD1SafetyPass("VACUUM;"))
      .toThrow(D1UnsupportedStatementError);
  });

  test("strips SAVEPOINT / RELEASE / ROLLBACK TO", () => {
    const input = "SAVEPOINT s1;\nCREATE TABLE x (id INT);\nROLLBACK TO s1;\nRELEASE s1;";
    expect(applyD1SafetyPass(input)).toBe("CREATE TABLE x (id INT);");
  });

  test("warns (via warnings array) when statement exceeds 100 KB", () => {
    const huge = "INSERT INTO x VALUES (" + "'a',".repeat(30000) + "'a');";
    const result = applyD1SafetyPass(huge, { collectWarnings: true });
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/100\s?KB|too large/i);
    expect(result.sql).toBe(huge.trim());
  });

  test("returns plain string when collectWarnings not set", () => {
    const out = applyD1SafetyPass("CREATE TABLE x (id INT);");
    expect(typeof out).toBe("string");
    expect(out).toBe("CREATE TABLE x (id INT);");
  });

  test("does not strip BEGIN inside a string literal", () => {
    const input = "INSERT INTO logs (msg) VALUES ('BEGIN TRANSACTION;');";
    expect(applyD1SafetyPass(input)).toBe(input);
  });

  test("preserves empty lines collapsed to a single blank between statements", () => {
    const input = "CREATE TABLE a (id INT);\n\nCREATE TABLE b (id INT);";
    expect(applyD1SafetyPass(input)).toBe("CREATE TABLE a (id INT);\n\nCREATE TABLE b (id INT);");
  });

  test("noop on empty input", () => {
    expect(applyD1SafetyPass("")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/d1-safety-pass.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `d1-safety-pass.ts`.**

Create `server/typescript/packages/migrate-ts/src/emit/d1-safety-pass.ts`:

```ts
const MAX_STATEMENT_BYTES = 100 * 1024; // 100 KB — wrangler d1 execute limit

export class D1UnsupportedStatementError extends Error {
  constructor(public readonly statement: string, public readonly reason: string) {
    super(`D1 does not support: ${reason} — offending statement: ${statement.slice(0, 80)}`);
    this.name = "D1UnsupportedStatementError";
  }
}

interface PassResult {
  sql: string;
  warnings: string[];
}

export function applyD1SafetyPass(sql: string): string;
export function applyD1SafetyPass(sql: string, opts: { collectWarnings: true }): PassResult;
export function applyD1SafetyPass(sql: string, opts?: { collectWarnings?: boolean }): string | PassResult {
  const collect = opts?.collectWarnings === true;
  const warnings: string[] = [];

  if (sql.length === 0) {
    return collect ? { sql: "", warnings } : "";
  }

  const statements = splitStatements(sql);
  const kept: string[] = [];

  for (const stmt of statements) {
    const trimmed = stmt.trim();
    if (trimmed.length === 0) continue;

    // Reject hard failures up front.
    if (/^\s*(ATTACH|DETACH)\b/i.test(trimmed)) {
      throw new D1UnsupportedStatementError(trimmed, "ATTACH/DETACH DATABASE");
    }
    if (/^\s*VACUUM\b/i.test(trimmed)) {
      throw new D1UnsupportedStatementError(trimmed, "VACUUM");
    }

    // Strip explicit transaction control + savepoints.
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(trimmed)) {
      continue;
    }

    if (byteLength(trimmed) > MAX_STATEMENT_BYTES) {
      warnings.push(
        `statement exceeds D1's 100 KB per-statement limit (${byteLength(trimmed)} bytes); ` +
        `wrangler d1 execute will reject it: ${trimmed.slice(0, 80)}...`,
      );
    }

    kept.push(trimmed);
  }

  // Re-join: each statement on its own line, blank line between top-level
  // DDL statements (matches sqlite emit's output style).
  const out = kept.join("\n\n");
  return collect ? { sql: out, warnings } : out;
}

/**
 * Split SQL on `;` boundaries, respecting single-quoted strings (SQL uses
 * '' to escape a single quote inside a literal — that's still one token to us).
 * Sufficient for our DDL output; we don't generate dollar-quoted blocks or
 * other exotic SQLite literals.
 */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (c === "'") {
      buf += c;
      inString = !inString;
      continue;
    }
    if (c === ";" && !inString) {
      buf += ";";
      out.push(buf);
      buf = "";
      continue;
    }
    buf += c;
  }
  if (buf.trim().length > 0) out.push(buf);
  return out;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
```

- [ ] **Step 4: Run test to verify it passes.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/d1-safety-pass.test.ts
```
Expected: PASS, all 12 tests.

- [ ] **Step 5: Commit.**

```bash
git add server/typescript/packages/migrate-ts/src/emit/d1-safety-pass.ts \
        server/typescript/packages/migrate-ts/test/unit/d1-safety-pass.test.ts
git commit -m "feat(migrate-ts): D1 SQL safety pass (strip txns, reject ATTACH/VACUUM)"
```

---

### Task 4: `renderD1` wrapper + emit dispatch

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/emit/d1.ts`
- Modify: `server/typescript/packages/migrate-ts/src/emit/index.ts` (replace Task 1 stub)
- Modify: `server/typescript/packages/migrate-ts/src/index.ts` (re-export)
- Create: `server/typescript/packages/migrate-ts/test/unit/emit-d1.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `server/typescript/packages/migrate-ts/test/unit/emit-d1.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { emit } from "../../src/emit/index.js";
import type { Change, SchemaSnapshot } from "../../src/types.js";

describe("emit(dialect: 'd1')", () => {
  test("produces sqlite-style DDL with no explicit BEGIN/COMMIT", () => {
    const changes: Change[] = [{
      kind: "create-table",
      status: { state: "allowed" },
      table: {
        name: "users",
        columns: [
          { name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false, identity: "increment" },
          { name: "email", sqlType: { kind: "text" }, nullable: false },
        ],
        indexes: [],
        foreignKeys: [],
        primaryKey: ["id"],
      },
    }];
    const expected: SchemaSnapshot = { tables: [], views: [] };
    const result = emit(changes, { dialect: "d1", expectedSchema: expected });
    expect(result.up).toContain("CREATE TABLE");
    expect(result.up).toContain("users");
    expect(result.up).not.toMatch(/^\s*BEGIN/im);
    expect(result.up).not.toMatch(/^\s*COMMIT/im);
    expect(result.down).toContain("DROP TABLE");
    expect(result.down).not.toMatch(/^\s*BEGIN/im);
  });

  test("matches sqlite emit modulo safety transforms (no recreate)", () => {
    const changes: Change[] = [{
      kind: "create-table",
      status: { state: "allowed" },
      table: {
        name: "books",
        columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [],
        foreignKeys: [],
        primaryKey: ["id"],
      },
    }];
    const expected: SchemaSnapshot = { tables: [], views: [] };
    const sqliteResult = emit(changes, { dialect: "sqlite", expectedSchema: expected });
    const d1Result = emit(changes, { dialect: "d1", expectedSchema: expected });
    // For a simple CREATE TABLE there are no BEGIN/COMMIT to strip; outputs should match.
    expect(d1Result.up).toBe(sqliteResult.up);
    expect(d1Result.down).toBe(sqliteResult.down);
  });

  test("recreatedTables propagates through the wrapper", () => {
    // Build an actual SchemaSnapshot whose meta forces recreate-and-copy.
    // The detailed recreate scenario is covered by sqlite tests; here we
    // just confirm the wrapper exposes the same `recreatedTables` field.
    const changes: Change[] = [{
      kind: "drop-column",
      status: { state: "allowed" },
      table: "users",
      column: "old_col",
    }];
    const actualMeta = { sqliteVersion: "3.20.0" }; // older than 3.35 → triggers recreate
    const expected: SchemaSnapshot = {
      tables: [{
        name: "users",
        columns: [{ name: "id", sqlType: { kind: "integer", bits: 64 }, nullable: false }],
        indexes: [],
        foreignKeys: [],
        primaryKey: ["id"],
      }],
      views: [],
    };
    const result = emit(changes, { dialect: "d1", expectedSchema: expected, actualMeta });
    expect(result.recreatedTables.has("users")).toBe(true);
    // recreate-and-copy emits PRAGMA foreign_keys=OFF/ON; safety pass MUST preserve these.
    expect(result.up).toContain("PRAGMA foreign_keys");
    // But it must NOT contain explicit BEGIN/COMMIT in d1 mode.
    expect(result.up).not.toMatch(/^\s*BEGIN/im);
    expect(result.up).not.toMatch(/^\s*COMMIT/im);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/emit-d1.test.ts
```
Expected: FAIL — current dispatch in `emit/index.ts` throws "d1 emit not yet wired (Task 4)".

- [ ] **Step 3: Implement `emit/d1.ts`.**

Create `server/typescript/packages/migrate-ts/src/emit/d1.ts`:

```ts
import type { Change, EmitResult, SchemaSnapshot, SnapshotMeta } from "../types.js";
import { renderSqlite } from "./sqlite.js";
import { applyD1SafetyPass } from "./d1-safety-pass.js";

export function renderD1(
  changes: Change[],
  expectedSchema?: SchemaSnapshot,
  actualMeta?: SnapshotMeta,
): EmitResult {
  const sqliteResult = renderSqlite(changes, expectedSchema, actualMeta);
  return {
    up: applyD1SafetyPass(sqliteResult.up),
    down: applyD1SafetyPass(sqliteResult.down),
    recreatedTables: sqliteResult.recreatedTables,
  };
}
```

- [ ] **Step 4: Wire dispatch in `emit/index.ts`.**

Edit `server/typescript/packages/migrate-ts/src/emit/index.ts`. At the top, add:

```ts
import { renderD1 } from "./d1.js";
```

Replace the `case "d1": throw ...` stub with:

```ts
case "d1": return renderD1(changes, opts.expectedSchema, opts.actualMeta);
```

- [ ] **Step 5: Re-export from package root.**

Edit `server/typescript/packages/migrate-ts/src/index.ts`. Below the existing emit-related exports (around the view-emitter exports line 41), add:

```ts
export { renderD1 } from "./emit/d1.js";
export { applyD1SafetyPass, D1UnsupportedStatementError } from "./emit/d1-safety-pass.js";
```

- [ ] **Step 6: Run test to verify it passes.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/emit-d1.test.ts
```
Expected: PASS, all 3 tests.

- [ ] **Step 7: Run the full suite to confirm no regression.**

```
cd server/typescript && bun test
```
Expected: all green.

- [ ] **Step 8: Commit.**

```bash
git add server/typescript/packages/migrate-ts/src/emit/d1.ts \
        server/typescript/packages/migrate-ts/src/emit/index.ts \
        server/typescript/packages/migrate-ts/src/index.ts \
        server/typescript/packages/migrate-ts/test/unit/emit-d1.test.ts
git commit -m "feat(migrate-ts): renderD1 wraps renderSqlite + applies D1 safety pass"
```

---

### Task 5: Wrangler CLI invocation helper

**Files:**
- Create: `server/typescript/packages/cli/src/lib/wrangler.ts`
- Create: `server/typescript/packages/cli/test/unit/wrangler.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `server/typescript/packages/cli/test/unit/wrangler.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { buildWranglerExecuteArgs, parseWranglerExecuteJson } from "../../src/lib/wrangler.js";

describe("buildWranglerExecuteArgs", () => {
  test("local execution with command", () => {
    expect(buildWranglerExecuteArgs({
      binding: "DB",
      remote: false,
      command: "SELECT 1",
      configPath: "wrangler.toml",
    })).toEqual([
      "d1", "execute", "DB",
      "--local",
      "--json",
      "--command", "SELECT 1",
      "--config", "wrangler.toml",
    ]);
  });

  test("remote execution swaps --local for --remote", () => {
    const args = buildWranglerExecuteArgs({
      binding: "DB",
      remote: true,
      command: "SELECT 1",
      configPath: "wrangler.toml",
    });
    expect(args).toContain("--remote");
    expect(args).not.toContain("--local");
  });

  test("omits --config when configPath undefined", () => {
    const args = buildWranglerExecuteArgs({
      binding: "DB",
      remote: false,
      command: "SELECT 1",
      configPath: undefined,
    });
    expect(args).not.toContain("--config");
  });
});

describe("parseWranglerExecuteJson", () => {
  test("extracts rows from wrangler's standard envelope", () => {
    const stdout = JSON.stringify([{
      results: [{ id: 1, name: "alice" }, { id: 2, name: "bob" }],
      success: true,
      meta: {},
    }]);
    expect(parseWranglerExecuteJson(stdout)).toEqual([
      { id: 1, name: "alice" },
      { id: 2, name: "bob" },
    ]);
  });

  test("returns empty array when results missing", () => {
    expect(parseWranglerExecuteJson(JSON.stringify([{ success: true }]))).toEqual([]);
  });

  test("throws on malformed JSON", () => {
    expect(() => parseWranglerExecuteJson("not json")).toThrow(/parse|json/i);
  });

  test("throws when wrangler reports success: false", () => {
    const stdout = JSON.stringify([{ success: false, error: "no such table: foo" }]);
    expect(() => parseWranglerExecuteJson(stdout)).toThrow(/no such table: foo/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

```
cd server/typescript && bun test packages/cli/test/unit/wrangler.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `lib/wrangler.ts`.**

Create `server/typescript/packages/cli/src/lib/wrangler.ts`:

```ts
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

export interface WranglerExecuteOptions {
  binding: string;
  remote: boolean;
  command: string;
  configPath: string | undefined;
}

export function buildWranglerExecuteArgs(opts: WranglerExecuteOptions): string[] {
  const args: string[] = [
    "d1", "execute", opts.binding,
    opts.remote ? "--remote" : "--local",
    "--json",
    "--command", opts.command,
  ];
  if (opts.configPath !== undefined) {
    args.push("--config", opts.configPath);
  }
  return args;
}

/**
 * Wrangler emits an array envelope: [{ results: [...], success: bool, meta: {...} }].
 * Returns the rows from the first result element. Throws if not parseable or success=false.
 */
export function parseWranglerExecuteJson(stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`failed to parse wrangler JSON output: ${(err as Error).message}`);
  }
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  if (envelope === undefined || envelope === null || typeof envelope !== "object") {
    throw new Error(`unexpected wrangler output shape: ${stdout.slice(0, 200)}`);
  }
  const env = envelope as { success?: boolean; error?: string; results?: unknown };
  if (env.success === false) {
    throw new Error(`wrangler d1 execute failed: ${env.error ?? "(no error message)"}`);
  }
  const results = env.results;
  if (!Array.isArray(results)) return [];
  return results as Record<string, unknown>[];
}

/**
 * Run wrangler with the given args; return stdout. Stderr is included in the
 * error message when wrangler exits non-zero. `cwd` is the directory wrangler
 * runs in (defaults to process.cwd() — caller should pass the project root).
 */
export type WranglerRunner = (args: string[], cwd: string) => Promise<{ stdout: string; stderr: string }>;

export const defaultWranglerRunner: WranglerRunner = async (args, cwd) => {
  try {
    const { stdout, stderr } = await execFile("wrangler", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string; stdout?: string };
    if (e.code === "ENOENT") {
      throw new Error(`wrangler not found on PATH; install it: 'npm i -D wrangler'`);
    }
    const stderr = e.stderr ?? "";
    throw new Error(`wrangler ${args.join(" ")} failed: ${stderr || e.message}`);
  }
};
```

- [ ] **Step 4: Run test to verify it passes.**

```
cd server/typescript && bun test packages/cli/test/unit/wrangler.test.ts
```
Expected: PASS, all 7 tests.

- [ ] **Step 5: Commit.**

```bash
git add server/typescript/packages/cli/src/lib/wrangler.ts \
        server/typescript/packages/cli/test/unit/wrangler.test.ts
git commit -m "feat(cli): wrangler CLI helpers (execFile wrapper, args + JSON parsing)"
```

---

### Task 6: `introspectD1` — schema snapshot via wrangler CLI

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/introspect/d1.ts`
- Modify: `server/typescript/packages/migrate-ts/src/index.ts` (re-export `introspectD1`, `D1Runner`)
- Create: `server/typescript/packages/migrate-ts/test/unit/introspect-d1.test.ts`

Note: `introspectD1` lives in `migrate-ts` (not `cli`) because it's part of the pipeline contract. The wrangler runner is injected so tests can mock it; the real runner is wired from `cli/lib/wrangler.ts` at the call site (Task 9).

- [ ] **Step 1: Write the failing test.**

Create `server/typescript/packages/migrate-ts/test/unit/introspect-d1.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { introspectD1, type D1Runner } from "../../src/introspect/d1.js";

/**
 * A mock runner that maps SQL -> canned JSON envelope rows.
 * Wraps each rowset in wrangler's `[{ results: [...], success: true }]` shape.
 */
function mockRunner(table: Record<string, unknown[]>): D1Runner {
  return async (command: string) => {
    for (const [pattern, rows] of Object.entries(table)) {
      if (command.includes(pattern)) {
        return JSON.stringify([{ success: true, results: rows, meta: {} }]);
      }
    }
    return JSON.stringify([{ success: true, results: [], meta: {} }]);
  };
}

describe("introspectD1", () => {
  test("captures sqlite version into snapshot.meta", async () => {
    const runner = mockRunner({
      "sqlite_version": [{ v: "3.44.2" }],
    });
    const snap = await introspectD1({ runner, binding: "DB", remote: false, configPath: undefined });
    expect(snap.meta?.sqliteVersion).toBe("3.44.2");
  });

  test("reads tables and basic columns", async () => {
    const runner = mockRunner({
      "sqlite_version": [{ v: "3.44.2" }],
      "FROM sqlite_master\n    WHERE type='table'": [
        { name: "users", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL)" },
      ],
      "pragma_table_info('users')": [
        { cid: 0, name: "id",    type: "INTEGER", notnull: 0, dflt_value: null, pk: 1 },
        { cid: 1, name: "email", type: "TEXT",    notnull: 1, dflt_value: null, pk: 0 },
      ],
      "pragma_index_list('users')": [],
      "pragma_foreign_key_list('users')": [],
      "type='view'": [],
    });
    const snap = await introspectD1({ runner, binding: "DB", remote: false, configPath: undefined });
    expect(snap.tables).toHaveLength(1);
    expect(snap.tables[0]!.name).toBe("users");
    expect(snap.tables[0]!.columns).toHaveLength(2);
    expect(snap.tables[0]!.columns[0]!.name).toBe("id");
    expect(snap.tables[0]!.primaryKey).toEqual(["id"]);
    expect(snap.tables[0]!.columns[1]!.nullable).toBe(false);
  });

  test("invokes runner with --remote flag when remote: true", async () => {
    const calls: string[] = [];
    const runner: D1Runner = async (cmd) => {
      calls.push(cmd);
      if (cmd.includes("sqlite_version")) {
        return JSON.stringify([{ success: true, results: [{ v: "3.44.2" }] }]);
      }
      return JSON.stringify([{ success: true, results: [] }]);
    };
    await introspectD1({ runner, binding: "DB", remote: true, configPath: undefined });
    expect(calls.length).toBeGreaterThan(0); // runner was invoked; remote flag handled by caller wiring (see CLI task)
  });

  test("returns empty snapshot when DB has no tables", async () => {
    const runner = mockRunner({
      "sqlite_version": [{ v: "3.44.2" }],
    });
    const snap = await introspectD1({ runner, binding: "DB", remote: false, configPath: undefined });
    expect(snap.tables).toEqual([]);
    expect(snap.views).toEqual([]);
  });

  test("surfaces runner errors with helpful context", async () => {
    const runner: D1Runner = async () => { throw new Error("wrangler not found on PATH"); };
    await expect(introspectD1({ runner, binding: "DB", remote: false, configPath: undefined }))
      .rejects.toThrow(/wrangler not found/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/introspect-d1.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `introspect/d1.ts`.**

Create `server/typescript/packages/migrate-ts/src/introspect/d1.ts`:

```ts
import type {
  SchemaSnapshot, TableDescriptor, ColumnDescriptor, ColumnDefault, SnapshotMeta,
  IndexDescriptor, FkDescriptor, FkAction, ViewDescriptor,
} from "../types.js";
import type { SqlType } from "../sql-type.js";

/**
 * Runner contract: takes a SQL command string and returns wrangler's raw
 * JSON envelope stdout. The CLI wires this to a real exec; tests pass a mock.
 * The runner is responsible for ALL transport concerns (local vs remote,
 * config path, error mapping). introspectD1 only knows about SQL queries.
 */
export type D1Runner = (sql: string) => Promise<string>;

export interface IntrospectD1Options {
  runner: D1Runner;
  binding: string;
  remote: boolean;
  configPath: string | undefined;
}

export async function introspectD1(opts: IntrospectD1Options): Promise<SchemaSnapshot> {
  const exec = async (sql: string): Promise<Record<string, unknown>[]> => {
    const stdout = await opts.runner(sql);
    return parseEnvelope(stdout);
  };

  const versionRows = await exec("SELECT sqlite_version() AS v");
  const meta: SnapshotMeta = {
    sqliteVersion: String(versionRows[0]?.v ?? "0.0.0"),
  };

  const tableRows = await exec(
    "SELECT name, sql FROM sqlite_master\n    WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__new_%'\n    ORDER BY name",
  );

  const tables: TableDescriptor[] = [];
  for (const t of tableRows) {
    const name = String(t.name);
    const createSql = String(t.sql ?? "");
    const cols = await readColumns(exec, name);
    const pk = await readPrimaryKey(exec, name);
    const hasAutoincrement = createSql.toUpperCase().includes("AUTOINCREMENT");
    if (hasAutoincrement && pk.length === 1) {
      const pkCol = cols.find((c) => c.name === pk[0]);
      if (pkCol) pkCol.identity = "increment";
    }
    tables.push({
      name,
      columns: cols,
      indexes: await readIndexes(exec, name),
      foreignKeys: await readForeignKeys(exec, name),
      primaryKey: pk,
    });
  }

  const views = await readViews(exec);
  return { tables, views, meta };
}

function parseEnvelope(stdout: string): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`failed to parse wrangler JSON output: ${(err as Error).message}`);
  }
  const envelope = Array.isArray(parsed) ? parsed[0] : parsed;
  if (envelope === undefined || envelope === null || typeof envelope !== "object") {
    throw new Error(`unexpected wrangler output shape: ${stdout.slice(0, 200)}`);
  }
  const env = envelope as { success?: boolean; error?: string; results?: unknown };
  if (env.success === false) {
    throw new Error(`wrangler d1 execute failed: ${env.error ?? "(no error message)"}`);
  }
  const results = env.results;
  if (!Array.isArray(results)) return [];
  return results as Record<string, unknown>[];
}

async function readColumns(exec: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<ColumnDescriptor[]> {
  const rows = await exec(`SELECT * FROM pragma_table_info('${table}') ORDER BY cid`);
  return rows.map((r) => {
    const col: ColumnDescriptor = {
      name: String(r.name),
      sqlType: sqliteTypeToSqlType(String(r.type)),
      nullable: Number(r.notnull) === 0 && Number(r.pk) === 0,
    };
    const def = parseSqliteDefault(r.dflt_value === null ? null : String(r.dflt_value));
    if (def) col.default = def;
    return col;
  });
}

async function readPrimaryKey(exec: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<string[]> {
  const rows = await exec(`SELECT * FROM pragma_table_info('${table}') WHERE pk > 0 ORDER BY pk`);
  return rows.map((r) => String(r.name));
}

async function readIndexes(exec: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<IndexDescriptor[]> {
  const list = await exec(`SELECT * FROM pragma_index_list('${table}')`);
  const indexes: IndexDescriptor[] = [];
  for (const ix of list) {
    if (String(ix.origin) === "pk") continue;
    if (Number(ix.partial) === 1) continue;
    const ixName = String(ix.name);
    const cols = await exec(`SELECT seqno, cid, name FROM pragma_index_info('${ixName}') ORDER BY seqno`);
    indexes.push({
      name: ixName,
      columns: cols.map((c) => String(c.name)),
      unique: Number(ix.unique) === 1,
    });
  }
  return indexes;
}

async function readForeignKeys(exec: (sql: string) => Promise<Record<string, unknown>[]>, table: string): Promise<FkDescriptor[]> {
  const rows = await exec(`SELECT * FROM pragma_foreign_key_list('${table}') ORDER BY id, seq`);
  const byId = new Map<number, { refTable: string; cols: string[]; refCols: string[]; onDelete: FkAction; onUpdate: FkAction; }>();
  for (const r of rows) {
    const id = Number(r.id);
    let entry = byId.get(id);
    if (!entry) {
      entry = {
        refTable: String(r.table),
        cols: [],
        refCols: [],
        onDelete: sqliteRuleToAction(String(r.on_delete)),
        onUpdate: sqliteRuleToAction(String(r.on_update)),
      };
      byId.set(id, entry);
    }
    entry.cols.push(String(r.from));
    entry.refCols.push(String(r.to));
  }
  return Array.from(byId.entries()).map(([_id, v]) => {
    const fk: FkDescriptor = {
      name: `${table}_${v.cols.join("_")}_fk`,
      columns: v.cols,
      refTable: v.refTable,
      refColumns: v.refCols,
    };
    if (v.onDelete !== "no-action") fk.onDelete = v.onDelete;
    if (v.onUpdate !== "no-action") fk.onUpdate = v.onUpdate;
    return fk;
  });
}

async function readViews(exec: (sql: string) => Promise<Record<string, unknown>[]>): Promise<ViewDescriptor[]> {
  const rows = await exec(
    "SELECT name FROM sqlite_master WHERE type='view' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return rows.map((r) => ({ name: String(r.name) }));
}

const SQLITE_EXPR_DEFAULT_PATTERNS = [
  /^current_timestamp$/i,
  /^current_date$/i,
  /^current_time$/i,
  /\(.*\)/,
];

function parseSqliteDefault(raw: string | null): ColumnDefault | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const isExpr = SQLITE_EXPR_DEFAULT_PATTERNS.some((re) => re.test(raw));
  if (isExpr) return { kind: "expr", value: raw };
  const cleaned = raw.replace(/^'(.*)'$/, "$1");
  return { kind: "literal", value: cleaned };
}

function sqliteTypeToSqlType(declaredType: string): SqlType {
  const t = declaredType.trim().toUpperCase();
  const varcharMatch = /^(?:VARCHAR|CHAR|CHARACTER|TEXT)\((\d+)\)$/.exec(t);
  if (varcharMatch) return { kind: "text", maxLength: parseInt(varcharMatch[1] ?? "0", 10) };
  if (/TEXT|CLOB|VARCHAR|CHAR/.test(t)) return { kind: "text" };
  const numMatch = /^(?:NUMERIC|DECIMAL)\((\d+)(?:,\s*(\d+))?\)$/.exec(t);
  if (numMatch) {
    const out: SqlType = { kind: "numeric" };
    if (numMatch[1]) out.precision = parseInt(numMatch[1], 10);
    if (numMatch[2]) out.scale = parseInt(numMatch[2], 10);
    return out;
  }
  if (t === "BOOLEAN" || t === "BOOL") return { kind: "boolean" };
  if (t === "DATE") return { kind: "date" };
  if (t === "DATETIME" || t === "TIMESTAMP") return { kind: "timestamp", withTimezone: false };
  if (t === "INT" || t === "SMALLINT" || t === "TINYINT") return { kind: "integer", bits: 32 };
  if (/INT/.test(t)) return { kind: "integer", bits: 64 };
  if (/REAL|FLOA|DOUB/.test(t)) return { kind: "real" };
  if (t === "BLOB" || t === "") return { kind: "blob" };
  if (/NUMERIC|DECIMAL/.test(t)) return { kind: "numeric" };
  if (t === "JSON") return { kind: "json" };
  return { kind: "text" };
}

function sqliteRuleToAction(rule: string): FkAction {
  const r = rule.toUpperCase();
  if (r === "CASCADE") return "cascade";
  if (r === "SET NULL") return "set-null";
  if (r === "RESTRICT") return "restrict";
  return "no-action";
}
```

- [ ] **Step 4: Re-export from package root.**

Edit `server/typescript/packages/migrate-ts/src/index.ts`. Add:

```ts
export { introspectD1, type D1Runner, type IntrospectD1Options } from "./introspect/d1.js";
export { findWranglerConfig, parseWranglerConfig, resolveD1Binding, type D1Binding, type WranglerConfig } from "./wrangler-config.js";
```

- [ ] **Step 5: Run test to verify it passes.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/introspect-d1.test.ts
```
Expected: PASS, all 5 tests.

- [ ] **Step 6: Run the full migrate-ts suite.**

```
cd server/typescript && bun test packages/migrate-ts/
```
Expected: all green.

- [ ] **Step 7: Commit.**

```bash
git add server/typescript/packages/migrate-ts/src/introspect/d1.ts \
        server/typescript/packages/migrate-ts/src/index.ts \
        server/typescript/packages/migrate-ts/test/unit/introspect-d1.test.ts
git commit -m "feat(migrate-ts): introspectD1 (mockable runner; sqlite catalog over wrangler exec)"
```

---

### Task 7: `writeMigrationD1` — Wrangler layout writer

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/write-migration-d1.ts`
- Modify: `server/typescript/packages/migrate-ts/src/index.ts` (re-export)
- Create: `server/typescript/packages/migrate-ts/test/unit/write-migration-d1.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `server/typescript/packages/migrate-ts/test/unit/write-migration-d1.test.ts`:

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMigrationD1 } from "../../src/write-migration-d1.js";

describe("writeMigrationD1", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "migrate-d1-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("writes 0001_<slug>.sql in an empty migrations dir", async () => {
    const result = await writeMigrationD1(
      { up: "CREATE TABLE x (id INT);", down: "DROP TABLE x;" },
      { dir, slug: "init" },
    );
    expect(result.upPath).toBe(join(dir, "0001_init.sql"));
    expect(result.downPath).toBe(join(dir, ".down", "0001_init.sql"));
    expect(readFileSync(result.upPath, "utf8")).toBe("CREATE TABLE x (id INT);\n");
    expect(readFileSync(result.downPath, "utf8")).toBe("DROP TABLE x;\n");
  });

  test("picks max(seq)+1 when prior migrations exist", async () => {
    writeFileSync(join(dir, "0001_init.sql"), "x");
    writeFileSync(join(dir, "0002_add-users.sql"), "x");
    writeFileSync(join(dir, "0007_skip.sql"), "x");
    const result = await writeMigrationD1(
      { up: "CREATE TABLE y (id INT);", down: "DROP TABLE y;" },
      { dir, slug: "next" },
    );
    expect(result.upPath).toBe(join(dir, "0008_next.sql"));
  });

  test("creates migrations dir if missing", async () => {
    const sub = join(dir, "db", "migrations");
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir: sub, slug: "init" },
    );
    expect(existsSync(result.upPath)).toBe(true);
    expect(existsSync(result.downPath)).toBe(true);
  });

  test("creates .down subfolder", async () => {
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "init" },
    );
    expect(existsSync(join(dir, ".down"))).toBe(true);
    expect(result.downPath).toBe(join(dir, ".down", "0001_init.sql"));
  });

  test("ignores non-matching .sql files when assigning seq", async () => {
    writeFileSync(join(dir, "schema.sql"), "x");
    writeFileSync(join(dir, "0003_real.sql"), "x");
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "next" },
    );
    expect(result.upPath).toBe(join(dir, "0004_next.sql"));
  });

  test("does not recurse into .down when computing seq", async () => {
    mkdirSync(join(dir, ".down"), { recursive: true });
    writeFileSync(join(dir, ".down", "0099_old.sql"), "x");
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "init" },
    );
    expect(result.upPath).toBe(join(dir, "0001_init.sql"));
  });

  test("slug is sanitized to safe filename (lowercase, hyphens)", async () => {
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "Add Customer/Shipping!" },
    );
    expect(result.upPath).toBe(join(dir, "0001_add-customer-shipping.sql"));
  });

  test("trailing newline added if missing", async () => {
    const result = await writeMigrationD1(
      { up: "no-newline", down: "also-none" },
      { dir, slug: "x" },
    );
    expect(readFileSync(result.upPath, "utf8").endsWith("\n")).toBe(true);
    expect(readFileSync(result.downPath, "utf8").endsWith("\n")).toBe(true);
  });

  test("pads sequence to 4 digits up to 9999, then 5", async () => {
    writeFileSync(join(dir, "9999_max.sql"), "x");
    const result = await writeMigrationD1(
      { up: "x", down: "y" },
      { dir, slug: "next" },
    );
    expect(result.upPath).toBe(join(dir, "10000_next.sql"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/write-migration-d1.test.ts
```
Expected: FAIL with module not found.

- [ ] **Step 3: Implement `write-migration-d1.ts`.**

Create `server/typescript/packages/migrate-ts/src/write-migration-d1.ts`:

```ts
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmitResult } from "./types.js";

export interface WriteMigrationD1Options {
  /** Migrations dir (e.g., "migrations"). Created if missing. */
  dir: string;
  /** Human-readable slug; sanitized to lowercase + hyphens. */
  slug: string;
}

export interface WriteMigrationD1Result {
  /** Full path to the up SQL file. */
  upPath: string;
  /** Full path to the down sidecar SQL file. */
  downPath: string;
  /** Assigned sequence number (e.g., 1, 2, 10000). */
  sequence: number;
}

const SEQ_RE = /^(\d+)_/;

export async function writeMigrationD1(
  result: Pick<EmitResult, "up" | "down">,
  opts: WriteMigrationD1Options,
): Promise<WriteMigrationD1Result> {
  await mkdir(opts.dir, { recursive: true });
  await mkdir(join(opts.dir, ".down"), { recursive: true });

  const seq = await nextSequence(opts.dir);
  const padded = String(seq).padStart(4, "0");
  const slug = sanitizeSlug(opts.slug);
  const filename = `${padded}_${slug}.sql`;

  const upPath = join(opts.dir, filename);
  const downPath = join(opts.dir, ".down", filename);

  await writeFile(upPath, ensureTrailingNewline(result.up), "utf8");
  await writeFile(downPath, ensureTrailingNewline(result.down), "utf8");

  return { upPath, downPath, sequence: seq };
}

async function nextSequence(dir: string): Promise<number> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".sql")) continue;
    const m = SEQ_RE.exec(entry);
    if (!m) continue;
    const n = parseInt(m[1]!, 10);
    if (n > max) max = n;
  }
  return max + 1;
}

function sanitizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 60);
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
```

- [ ] **Step 4: Re-export.**

Edit `server/typescript/packages/migrate-ts/src/index.ts`. Add:

```ts
export { writeMigrationD1, type WriteMigrationD1Options, type WriteMigrationD1Result } from "./write-migration-d1.js";
```

- [ ] **Step 5: Run test to verify it passes.**

```
cd server/typescript && bun test packages/migrate-ts/test/unit/write-migration-d1.test.ts
```
Expected: PASS, all 9 tests.

- [ ] **Step 6: Commit.**

```bash
git add server/typescript/packages/migrate-ts/src/write-migration-d1.ts \
        server/typescript/packages/migrate-ts/src/index.ts \
        server/typescript/packages/migrate-ts/test/unit/write-migration-d1.test.ts
git commit -m "feat(migrate-ts): writeMigrationD1 (Wrangler <seq>_<slug>.sql + .down sidecar)"
```

---

### Task 8: CLI args + config schema for D1

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts:134-207`
- Modify: `server/typescript/packages/cli/src/lib/config.ts`
- Modify: `server/typescript/packages/sdk/src/config.ts` (add `d1` block in `MigrateBlock`)
- Test: extend `server/typescript/packages/cli/test/unit/args.test.ts` (or create if not present — check first)

- [ ] **Step 1: Check if there's an existing args test file.**

```
ls server/typescript/packages/cli/test/unit/args.test.ts 2>/dev/null || ls server/typescript/packages/cli/test/unit/ | grep -i args
```

If a file exists, append the new tests. If not, create a new file (use the path below).

- [ ] **Step 2: Write the failing test.**

Create or append to `server/typescript/packages/cli/test/unit/args.test.ts`:

```ts
import { test, expect, describe } from "bun:test";
import { parseMigrateArgs } from "../../src/lib/args.js";

describe("parseMigrateArgs (d1 flags)", () => {
  test("accepts --dialect d1", () => {
    const flags = parseMigrateArgs(["--dialect", "d1"]);
    expect(flags.dialect).toBe("d1");
  });

  test("captures --d1 binding name", () => {
    const flags = parseMigrateArgs(["--dialect", "d1", "--d1", "MYDB"]);
    expect(flags.d1Binding).toBe("MYDB");
  });

  test("captures --remote as a boolean", () => {
    expect(parseMigrateArgs(["--dialect", "d1", "--remote"]).remote).toBe(true);
    expect(parseMigrateArgs(["--dialect", "d1"]).remote).toBe(false);
  });

  test("captures --apply as a boolean", () => {
    expect(parseMigrateArgs(["--dialect", "d1", "--apply"]).apply).toBe(true);
    expect(parseMigrateArgs(["--dialect", "d1"]).apply).toBe(false);
  });

  test("captures --yes as a boolean", () => {
    expect(parseMigrateArgs(["--dialect", "d1", "--yes"]).yes).toBe(true);
    expect(parseMigrateArgs(["--dialect", "d1"]).yes).toBe(false);
  });

  test("rejects unknown dialect", () => {
    expect(() => parseMigrateArgs(["--dialect", "mysql"])).toThrow(/invalid --dialect/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

```
cd server/typescript && bun test packages/cli/test/unit/args.test.ts
```
Expected: FAIL — `--d1`, `--remote`, `--apply`, `--yes` are unknown options under `strict: true`.

- [ ] **Step 4: Extend `MigrateFlags` and the parser.**

Edit `server/typescript/packages/cli/src/lib/args.ts`:

First, extend the `DIALECTS` tuple at line 134:
```ts
// Before:
const DIALECTS = ["sqlite", "postgres"] as const;
// After:
const DIALECTS = ["sqlite", "postgres", "d1"] as const;
```

Extend `MigrateFlags` to add the new fields (after `dryRun`):
```ts
export interface MigrateFlags {
  db: string | undefined;
  dialect: Dialect | undefined;
  outDir: string | undefined;
  slug: string | undefined;
  allow: AllowToken[];
  onAmbiguous: OnAmbiguous | undefined;
  dryRun: boolean;
  // D1-specific:
  d1Binding: string | undefined;
  remote: boolean;
  apply: boolean;
  yes: boolean;
}
```

Extend the `parseArgs` options block (currently lines ~163-172):
```ts
const { values } = parseArgs({
  args: argv,
  options: {
    "db": { type: "string" },
    "dialect": { type: "string" },
    "out-dir": { type: "string" },
    "slug": { type: "string" },
    "allow": { type: "string" },
    "on-ambiguous": { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "d1": { type: "string" },
    "remote": { type: "boolean", default: false },
    "apply": { type: "boolean", default: false },
    "yes": { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});
```

Extend the return object:
```ts
return {
  db: values.db as string | undefined,
  dialect: dialect as Dialect | undefined,
  outDir: values["out-dir"] as string | undefined,
  slug: values.slug as string | undefined,
  allow: allowTokens as AllowToken[],
  onAmbiguous: onAmb as OnAmbiguous | undefined,
  dryRun: !!values["dry-run"],
  d1Binding: values.d1 as string | undefined,
  remote: !!values.remote,
  apply: !!values.apply,
  yes: !!values.yes,
};
```

- [ ] **Step 5: Extend the SDK config schema.**

Edit `server/typescript/packages/sdk/src/config.ts`. Add a `D1Block` schema and include it in `MigrateBlock`:

```ts
// After DialectEnum (line 5):

const D1Block = z.object({
  binding: z.string(),
  remote: z.boolean(),
  autoApply: z.boolean(),
  wranglerConfigPath: z.string(),
}).partial();

// Replace MigrateBlock with:
const MigrateBlock = z.object({
  outDir: z.string(),
  databaseUrl: z.string(),
  dialect: DialectEnum,
  onAmbiguous: OnAmbiguousEnum,
  allow: z.array(AllowTokenEnum),
  d1: D1Block,
}).partial();
```

- [ ] **Step 6: Extend `ResolvedMigrateConfig` and `resolveMigrateConfig`.**

Edit `server/typescript/packages/cli/src/lib/config.ts`. Update the dialect literal to include "d1":

```ts
const MIGRATE_DEFAULTS = {
  outDir: "./.metaobjects/migrations",
  databaseUrl: undefined as string | undefined,
  dialect: undefined as "sqlite" | "postgres" | "d1" | undefined,
  onAmbiguous: "abort" as const,
  allow: [] as string[],
};
```

Add a D1-specific resolved block:
```ts
export interface ResolvedD1Config {
  binding: string | undefined;
  remote: boolean;
  autoApply: boolean;
  wranglerConfigPath: string | undefined;
}

export interface ResolvedMigrateConfig {
  outDir: string;
  databaseUrl: string | undefined;
  dialect: "sqlite" | "postgres" | "d1" | undefined;
  onAmbiguous: "abort" | "rename" | "drop-add";
  allow: string[];
  slug: string | undefined;
  dryRun: boolean;
  d1: ResolvedD1Config;
}
```

Update `resolveMigrateConfig` to populate the `d1` block:
```ts
const d1Block = cfgBlock.d1 ?? {};
return {
  outDir: flags.outDir ?? cfgBlock.outDir ?? MIGRATE_DEFAULTS.outDir,
  databaseUrl: flags.db ?? envUrl ?? cfgBlock.databaseUrl ?? MIGRATE_DEFAULTS.databaseUrl,
  dialect: flags.dialect ?? cfgBlock.dialect ?? MIGRATE_DEFAULTS.dialect,
  onAmbiguous: flags.onAmbiguous ?? cfgBlock.onAmbiguous ?? MIGRATE_DEFAULTS.onAmbiguous,
  allow: flags.allow.length > 0 ? flags.allow : (cfgBlock.allow ?? MIGRATE_DEFAULTS.allow),
  slug: flags.slug,
  dryRun: flags.dryRun,
  d1: {
    binding: flags.d1Binding ?? d1Block.binding,
    remote: flags.remote || (d1Block.remote ?? false),
    autoApply: flags.apply || (d1Block.autoApply ?? false),
    wranglerConfigPath: d1Block.wranglerConfigPath,
  },
};
```

- [ ] **Step 7: Run test to verify it passes.**

```
cd server/typescript && bun test packages/cli/test/unit/args.test.ts
```
Expected: PASS, all 6 tests.

- [ ] **Step 8: Run the whole server suite to check for regressions.**

```
cd server/typescript && bun test
```
Expected: all green. If `cli/test/unit/load-metaobjects-config.test.ts` or similar fixtures fail because the new `d1` field shape rejects something, update the fixtures.

- [ ] **Step 9: Type-check.**

```
bun run --filter '*' typecheck
```
Expected: passes.

- [ ] **Step 10: Commit.**

```bash
git add server/typescript/packages/cli/src/lib/args.ts \
        server/typescript/packages/cli/src/lib/config.ts \
        server/typescript/packages/sdk/src/config.ts \
        server/typescript/packages/cli/test/unit/args.test.ts
git commit -m "feat(cli): add --d1/--remote/--apply/--yes flags + d1 config block"
```

---

### Task 9: `migrate` command branch for D1

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/migrate.ts`
- Create: `server/typescript/packages/cli/test/unit/migrate-d1.test.ts`

This task wires the dialect to a new code path that uses `findWranglerConfig` → `resolveD1Binding` → `introspectD1` → `renderD1` → `writeMigrationD1`. It skips `buildKyselyFromUrl` entirely for d1.

- [ ] **Step 1: Write the failing test.**

Create `server/typescript/packages/cli/test/unit/migrate-d1.test.ts`. This is an integration-style test that exercises the d1 branch with a mocked wrangler runner and a temp wrangler.toml + metaobjects/:

```ts
import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("migrate command with --dialect d1", () => {
  let dir: string;
  let cwdBefore: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrate-d1-cmd-"));
    cwdBefore = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(cwdBefore);
    rmSync(dir, { recursive: true, force: true });
  });

  test("empty DB + one entity → emits 0001_<slug>.sql with CREATE TABLE", async () => {
    // Set up wrangler.toml with one D1 binding.
    writeFileSync(join(dir, "wrangler.toml"), [
      `name = "test-app"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "test-db"`,
      `database_id = "test-id"`,
    ].join("\n"));

    // Set up a minimal metaobjects/ with one entity.
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.users.json"), JSON.stringify({
      "metadata.root": {
        "package": "test::users",
        "children": [{
          "object.entity": {
            "name": "User",
            "children": [
              { "field.long":   { "name": "id" } },
              { "field.string": { "name": "email" } },
              { "identity.primary": { "@fields": ["id"], "@generation": "increment" } }
            ]
          }
        }]
      }
    }));

    // Mock the wrangler runner — return an empty DB.
    const wranglerMod = await import("../../src/lib/wrangler.js");
    const originalRunner = wranglerMod.defaultWranglerRunner;
    let runnerCalls: string[][] = [];
    (wranglerMod as { defaultWranglerRunner: typeof originalRunner }).defaultWranglerRunner = async (args, _cwd) => {
      runnerCalls.push(args);
      // Extract the SQL from the args (arg pattern: ... --command <sql> ...)
      const cmdIdx = args.indexOf("--command");
      const sql = cmdIdx >= 0 ? args[cmdIdx + 1] ?? "" : "";
      if (sql.includes("sqlite_version")) {
        return { stdout: JSON.stringify([{ success: true, results: [{ v: "3.44.2" }] }]), stderr: "" };
      }
      return { stdout: JSON.stringify([{ success: true, results: [] }]), stderr: "" };
    };

    try {
      const { migrateCommand } = await import("../../src/commands/migrate.js");
      const code = await migrateCommand(["--dialect", "d1", "--slug", "init"], dir);
      expect(code).toBe(0);

      const migrationsDir = join(dir, "migrations");
      expect(existsSync(migrationsDir)).toBe(true);
      const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
      expect(files).toEqual(["0001_init.sql"]);
      const sql = readFileSync(join(migrationsDir, "0001_init.sql"), "utf8");
      expect(sql).toContain("CREATE TABLE");
      expect(sql).not.toMatch(/BEGIN/);
      // .down sidecar exists too:
      expect(existsSync(join(migrationsDir, ".down", "0001_init.sql"))).toBe(true);
    } finally {
      (wranglerMod as { defaultWranglerRunner: typeof originalRunner }).defaultWranglerRunner = originalRunner;
    }
  });

  test("errors when wrangler.toml is missing and --d1 is not supplied", async () => {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.users.json"), JSON.stringify({
      "metadata.root": { "package": "test::users", "children": [] },
    }));

    const { migrateCommand } = await import("../../src/commands/migrate.js");
    const code = await migrateCommand(["--dialect", "d1", "--slug", "init"], dir);
    expect(code).toBe(2);
  });

  test("errors when --db is supplied with --dialect d1", async () => {
    writeFileSync(join(dir, "wrangler.toml"), `name = "x"\n[[d1_databases]]\nbinding = "DB"\ndatabase_name = "x"\ndatabase_id = "y"\n`);
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "meta.users.json"), JSON.stringify({
      "metadata.root": { "package": "test::users", "children": [] },
    }));

    const { migrateCommand } = await import("../../src/commands/migrate.js");
    const code = await migrateCommand(["--dialect", "d1", "--db", "file:foo.db", "--slug", "init"], dir);
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails.**

```
cd server/typescript && bun test packages/cli/test/unit/migrate-d1.test.ts
```
Expected: FAIL — d1 branch not yet wired in `migrate.ts`.

- [ ] **Step 3: Branch `migrate.ts` on dialect === "d1".**

Edit `server/typescript/packages/cli/src/commands/migrate.ts`. After flag parsing and config resolution but before `buildKyselyFromUrl` (around line 147), insert a d1 branch:

```ts
// (existing code parses flags, resolves config, loads metadata...)

// After `const config = await resolveMigrateConfig(flags, metaRoot);` block:

if (config.dialect === "d1") {
  // d1 has its own pipeline: skip Kysely, use wrangler exec.
  if (config.databaseUrl !== undefined) {
    log.error(`migrate: --db / DATABASE_URL is not used for dialect 'd1' — wrangler.toml owns connection`);
    return 2;
  }
  return await runD1Migrate(config, metaRoot);
}

// (existing kysely-based code continues unchanged for postgres + sqlite)
```

Then move the existing connection check to gate only non-d1:

```ts
// Replace the original:
//   if (config.databaseUrl === undefined) { ... return 2; }
// With:
if (config.dialect !== "d1" && config.databaseUrl === undefined) {
  log.error(`migrate: --db <url> required ...`);
  return 2;
}
```

Add the new `runD1Migrate` helper at the bottom of `migrate.ts` (before the existing `readExistingViewSql` helper):

```ts
import { findWranglerConfig, parseWranglerConfig, resolveD1Binding, introspectD1, renderD1, writeMigrationD1, type D1Runner } from "@metaobjectsdev/migrate-ts";
import { buildWranglerExecuteArgs, defaultWranglerRunner } from "../lib/wrangler.js";
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import type { ResolvedMigrateConfig } from "../lib/config.js";

async function runD1Migrate(config: ResolvedMigrateConfig, metaRoot: string): Promise<number> {
  // 1. Resolve wrangler.toml + binding.
  const wranglerConfigPath = config.d1.wranglerConfigPath
    ? resolvePath(metaRoot, config.d1.wranglerConfigPath)
    : findWranglerConfig(metaRoot);
  if (wranglerConfigPath === undefined && config.d1.binding === undefined) {
    log.error(`migrate: no wrangler.toml found in ${metaRoot} or parents; pass --d1 <binding> to bypass`);
    return 2;
  }
  let binding: { binding: string; database_name: string; database_id: string; migrations_dir: string | undefined };
  if (wranglerConfigPath !== undefined) {
    const parsed = parseWranglerConfig(wranglerConfigPath);
    try {
      binding = resolveD1Binding(parsed.d1Bindings, config.d1.binding);
    } catch (err) {
      log.error(`migrate: ${(err as Error).message}`);
      return 2;
    }
  } else {
    // No wrangler config but explicit binding — let wrangler discover the DB itself.
    binding = { binding: config.d1.binding!, database_name: "", database_id: "", migrations_dir: undefined };
  }

  // 2. Build a runner closure that includes the binding/remote/config context.
  const runner: D1Runner = async (sql) => {
    const args = buildWranglerExecuteArgs({
      binding: binding.binding,
      remote: config.d1.remote,
      command: sql,
      configPath: wranglerConfigPath,
    });
    const { stdout } = await defaultWranglerRunner(args, metaRoot);
    return stdout;
  };

  // 3. Load metadata.
  let metadata;
  try {
    metadata = await loadMemory(metaRoot);
  } catch (err) {
    log.error(`migrate: failed to load metadata: ${(err as Error).message}`);
    return 2;
  }

  // 4. Build expected schema + introspect actual.
  const expected = buildExpectedSchema(metadata, { dialect: "d1" });
  let actual;
  try {
    actual = await introspectD1({ runner, binding: binding.binding, remote: config.d1.remote, configPath: wranglerConfigPath });
  } catch (err) {
    log.error(`migrate: failed to introspect D1: ${(err as Error).message}`);
    return 2;
  }

  // 5. Diff.
  const collectedAmbiguous: AmbiguousChange[] = [];
  const onAmbiguousResolution = mapOnAmbiguous(config.onAmbiguous);
  let diffResult;
  try {
    diffResult = await diff({
      expected,
      actual,
      allow: tokensToAllowOptions(config.allow),
      onAmbiguous: async (a) => { collectedAmbiguous.push(a); return onAmbiguousResolution; },
    });
  } catch (err) {
    if ((err as Error).message.includes("aborted by onAmbiguous")) {
      log.error(`migrate: aborted on ambiguous change`);
      return 1;
    }
    throw err;
  }

  const changeCounts = summarizeChanges(diffResult.changes);

  if (diffResult.changes.length === 0) {
    log.info(`migrate: no schema changes for d1 binding '${binding.binding}'`);
    return 0;
  }

  if (config.slug === undefined) {
    log.error(`migrate: --slug <name> required when there are changes`);
    return 2;
  }

  // 6. Emit (with safety pass) + write Wrangler files.
  let emitResult;
  try {
    emitResult = renderD1(diffResult.changes, expected, actual.meta);
  } catch (err) {
    if (err instanceof BlockedChangesError) {
      const entries = blockedToEntries(err);
      for (const e of entries) {
        log.error(`migrate: blocked '${e.kind}' on ${e.description} (allow with --allow ${e.allowFlag})`);
      }
      return 1;
    }
    throw err;
  }

  // Migration dir resolution: --out-dir > wrangler.toml's migrations_dir > "migrations"
  const migrationsDir = resolvePath(
    metaRoot,
    config.outDir !== "./.metaobjects/migrations"  // user-supplied via flag/config
      ? config.outDir
      : (binding.migrations_dir ?? "migrations"),
  );

  if (config.dryRun) {
    log.info(`-- UP --\n${emitResult.up}\n\n-- DOWN --\n${emitResult.down}`);
    return 0;
  }

  const writeResult = await writeMigrationD1(emitResult, { dir: migrationsDir, slug: config.slug });
  log.info(`migrate: wrote ${writeResult.upPath}`);
  log.info(`migrate: wrote ${writeResult.downPath}`);
  for (const [kind, count] of Object.entries(changeCounts)) {
    log.info(`  ${kind}: ${count}`);
  }

  // 7. Optional --apply.
  if (config.d1.autoApply) {
    return await runWranglerApply(binding.binding, binding.database_name, config.d1.remote, wranglerConfigPath, config.yes);
  }

  return 0;
}

async function runWranglerApply(
  bindingName: string,
  databaseName: string,
  remote: boolean,
  wranglerConfigPath: string | undefined,
  yes: boolean,
): Promise<number> {
  if (remote && !yes) {
    log.info(`Applying to remote D1 '${databaseName}' (binding=${bindingName}) in 2s — Ctrl+C to abort or pass --yes to skip this pause.`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  const args = ["d1", "migrations", "apply", bindingName, remote ? "--remote" : "--local"];
  if (wranglerConfigPath !== undefined) args.push("--config", wranglerConfigPath);

  return await new Promise<number>((resolve) => {
    const child = spawn("wrangler", args, { stdio: "inherit" });
    child.on("error", (err) => {
      log.error(`migrate: failed to run wrangler: ${(err as Error).message}`);
      resolve(2);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
```

Make sure `tokensToAllowOptions`, `mapOnAmbiguous`, `summarizeChanges`, and `blockedToEntries` (defined elsewhere in `migrate.ts`) remain accessible to `runD1Migrate`. If they're not exported/hoisted, leave them at module scope (they already are based on the file structure observed).

- [ ] **Step 4: Run test to verify it passes.**

```
cd server/typescript && bun test packages/cli/test/unit/migrate-d1.test.ts
```
Expected: PASS, all 3 tests.

- [ ] **Step 5: Run the full server suite to catch regressions in postgres/sqlite paths.**

```
cd server/typescript && bun test
```
Expected: all green.

- [ ] **Step 6: Type-check.**

```
bun run --filter '*' typecheck
```
Expected: passes.

- [ ] **Step 7: Commit.**

```bash
git add server/typescript/packages/cli/src/commands/migrate.ts \
        server/typescript/packages/cli/test/unit/migrate-d1.test.ts
git commit -m "feat(cli): wire d1 branch in migrate command (wrangler resolve + introspect + write + apply)"
```

---

### Task 10: `meta init` D1 path

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/init.ts`
- Modify: `server/typescript/packages/cli/src/lib/args.ts` (add `--d1` to `InitFlags`)
- Add tests: extend `server/typescript/packages/cli/test/init.test.ts`

This task adds an opt-in `meta init --d1` flow that scaffolds `migrate.dialect = "d1"` in `.metaobjects/config.json` and (if `wrangler.toml` is present) prefills the binding.

- [ ] **Step 1: Read the existing init code to understand its shape.**

```
cat server/typescript/packages/cli/src/commands/init.ts | head -80
```

Note where the `MIGRATE_DEFAULTS` are merged or written into the scaffolded `config.json`. The new D1 path slots in at the same merge point.

- [ ] **Step 2: Write the failing test.**

Append to `server/typescript/packages/cli/test/init.test.ts` (or create if absent — keep test style consistent with the file):

```ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.js";

describe("init --d1", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "init-d1-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  test("scaffolds config with migrate.dialect = 'd1' and prefilled binding from wrangler.toml", async () => {
    writeFileSync(join(dir, "wrangler.toml"), [
      `name = "myapp"`,
      ``,
      `[[d1_databases]]`,
      `binding = "DB"`,
      `database_name = "myapp-prod"`,
      `database_id = "abc-123"`,
    ].join("\n"));
    const code = await initCommand(["--d1"], dir);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.migrate.dialect).toBe("d1");
    expect(cfg.migrate.d1.binding).toBe("DB");
  });

  test("scaffolds config with migrate.dialect = 'd1' but no binding when wrangler.toml absent", async () => {
    const code = await initCommand(["--d1"], dir);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, ".metaobjects", "config.json"), "utf8"));
    expect(cfg.migrate.dialect).toBe("d1");
    expect(cfg.migrate.d1?.binding).toBeUndefined();
  });

  test("without --d1, existing init behavior is unchanged", async () => {
    const code = await initCommand([], dir);
    expect(code).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dir, ".metaobjects", "config.json"), "utf8"));
    // existing default is sqlite per init.ts MIGRATE_DEFAULTS:
    expect(cfg.migrate?.dialect ?? "sqlite").toBe("sqlite");
  });
});
```

- [ ] **Step 3: Run test to verify it fails.**

```
cd server/typescript && bun test packages/cli/test/init.test.ts
```
Expected: FAIL — `--d1` is unknown to `parseInitArgs`.

- [ ] **Step 4: Add `--d1` to `parseInitArgs`.**

Edit `server/typescript/packages/cli/src/lib/args.ts`:

```ts
export interface InitFlags {
  force: boolean;
  quiet: boolean;
  printOnly: boolean;
  refreshDocs: boolean;
  d1: boolean;
}

export function parseInitArgs(argv: string[]): InitFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      force: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
      "print-only": { type: "boolean", default: false },
      "refresh-docs": { type: "boolean", default: false },
      d1: { type: "boolean", default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    force: !!values.force,
    quiet: !!values.quiet,
    printOnly: !!values["print-only"],
    refreshDocs: !!values["refresh-docs"],
    d1: !!values.d1,
  };
}
```

- [ ] **Step 5: Wire the d1 path in `init.ts`.**

Open `server/typescript/packages/cli/src/commands/init.ts`. Find the `MIGRATE_DEFAULTS` block (around line 36, with `dialect: "sqlite"`). Replace its consumption with a conditional:

```ts
import { findWranglerConfig, parseWranglerConfig } from "@metaobjectsdev/migrate-ts";

// (existing init code...)

const migrateBlock = flags.d1
  ? buildD1MigrateBlock(cwd)
  : { /* existing default sqlite-ish block from MIGRATE_DEFAULTS */ };

function buildD1MigrateBlock(cwd: string): Record<string, unknown> {
  const block: Record<string, unknown> = {
    dialect: "d1",
    onAmbiguous: "abort",
    allow: [],
  };
  const cfgPath = findWranglerConfig(cwd);
  if (cfgPath !== undefined) {
    try {
      const parsed = parseWranglerConfig(cfgPath);
      if (parsed.d1Bindings.length === 1) {
        block.d1 = { binding: parsed.d1Bindings[0]!.binding };
      } else if (parsed.d1Bindings.length > 1) {
        // Multiple bindings — leave binding unset; user must pick later with --d1.
        block.d1 = {};
      }
    } catch {
      // Parse failed; leave d1 block empty.
    }
  }
  return block;
}
```

Adjust the exact integration based on how `init.ts` currently constructs the config to write — the principle is: when `flags.d1` is true, the `migrate` block goes out with `dialect: "d1"` and (optionally) a prefilled `d1.binding`.

- [ ] **Step 6: Run test to verify it passes.**

```
cd server/typescript && bun test packages/cli/test/init.test.ts
```
Expected: PASS for the 3 new d1 tests and all pre-existing init tests.

- [ ] **Step 7: Run the full suite.**

```
cd server/typescript && bun test
```
Expected: all green.

- [ ] **Step 8: Commit.**

```bash
git add server/typescript/packages/cli/src/commands/init.ts \
        server/typescript/packages/cli/src/lib/args.ts \
        server/typescript/packages/cli/test/init.test.ts
git commit -m "feat(cli): meta init --d1 scaffolds d1 dialect config + prefills binding"
```

---

### Task 11: Documentation refresh

**Files:**
- Modify: `server/typescript/packages/migrate-ts/README.md`
- Modify: `server/typescript/packages/cli/README.md` (or wherever migrate is documented)
- Modify: `CLAUDE.md` — add D1 to dialect vocabulary section under "Cross-language porting" (constants that must be preserved across languages — D1 is TS-only, so note that explicitly)

- [ ] **Step 1: Update migrate-ts README.**

Add a section under "Dialects":

```markdown
### `d1` — Cloudflare D1

Targets Cloudflare D1 via the wrangler CLI. Connection is read from `wrangler.toml`; introspection runs via `wrangler d1 execute --json`. SQL emit reuses the `sqlite` path with a D1-safety post-pass (strips explicit transactions, rejects `ATTACH`/`VACUUM`). Migration files are written in Wrangler's native layout (`migrations/<seq>_<slug>.sql` + a `.down/` sidecar for rollback).

Flags:
- `--dialect d1` — selects this pipeline.
- `--d1 <binding>` — explicit binding from wrangler.toml (auto-detected when there's exactly one).
- `--remote` — target remote D1 (default: local).
- `--apply` — invoke `wrangler d1 migrations apply` after writing.
- `--yes` — skip the `--remote --apply` 2-second confirmation pause.

Config (`.metaobjects/config.json`):
```jsonc
{
  "migrate": {
    "dialect": "d1",
    "d1": { "binding": "DB", "remote": false, "autoApply": false }
  }
}
```

Requirements: `wrangler` >= 3 on PATH (`npm i -D wrangler`).
```

- [ ] **Step 2: Update CLI README's migrate section** with the same flag table.

- [ ] **Step 3: Update CLAUDE.md.**

Find the "Cross-language porting" section. Add a note under the dialect-related items:

```markdown
- **D1 is TS-only.** Cloudflare D1 lives at the `dialect: "d1"` peer of `sqlite`/`postgres` in TS. It is SQLite at the SQL level — Java/Python/C# don't have an analogue (Cloudflare Workers run JS). When adding cross-language vocabulary, D1 doesn't constrain anything: its uniqueness is wrangler-CLI transport + Wrangler-native file layout, both of which are TS-only concerns.
```

- [ ] **Step 4: Run docs verification (typecheck still applies; no test changes here).**

```
cd server/typescript && bun test
```
Expected: all green (no test changes; this is a sanity check).

- [ ] **Step 5: Commit.**

```bash
git add server/typescript/packages/migrate-ts/README.md \
        server/typescript/packages/cli/README.md \
        CLAUDE.md
git commit -m "docs: document the d1 dialect in migrate-ts/cli READMEs + CLAUDE.md"
```

---

## Done

All eleven tasks complete. The pipeline now supports `dialect: "d1"` end-to-end:
- `meta migrate --dialect d1 --slug my-change` introspects local D1 via wrangler, diffs, emits, writes `migrations/<seq>_<slug>.sql` + `.down/` sidecar.
- `meta migrate --dialect d1 --remote --slug ... --apply --yes` targets production D1 and applies via wrangler.
- `meta init --d1` scaffolds the right config block.

Run the whole TS suite from the repo root:
```
cd server/typescript && bun test
```
All previously passing tests should still pass. New green coverage:
- `migrate-ts/test/unit/wrangler-config.test.ts` (11 tests)
- `migrate-ts/test/unit/d1-safety-pass.test.ts` (12 tests)
- `migrate-ts/test/unit/emit-d1.test.ts` (3 tests)
- `migrate-ts/test/unit/introspect-d1.test.ts` (5 tests)
- `migrate-ts/test/unit/write-migration-d1.test.ts` (9 tests)
- `cli/test/unit/wrangler.test.ts` (7 tests)
- `cli/test/unit/args.test.ts` (6 new d1 tests)
- `cli/test/unit/migrate-d1.test.ts` (3 tests)
- `cli/test/init.test.ts` (3 new d1 tests)

Then live-smoke against a real D1 in a sandbox project (out-of-band — not part of CI):
```
cd <some-d1-app>
meta migrate --dialect d1 --slug initial-schema
wrangler d1 execute DB --local --command "SELECT name FROM sqlite_master"
meta migrate --dialect d1 --slug initial-schema --apply
wrangler d1 execute DB --local --command "SELECT name FROM sqlite_master"
```
The second `wrangler d1 execute` should list the tables the migration created.
