# Flyway Output Adapter (#192) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore metadata → migration generation for JVM/Flyway consumers by adding a Flyway-prefix output adapter (`V<N>__`/`U<N>__`) to the shared TS migrate engine — the ADR-0015 replacement for the removed `meta:migrate --flyway` mojo that was never built.

**Architecture:** A third output adapter beside `write-migration.ts` (homegrown) and `write-migration-d1.ts` (Wrangler). The diff/emit engine is untouched — it already returns `{ up, down }`; an adapter only chooses the file envelope. Format is a new axis orthogonal to dialect, selected by `--format` or `.metaobjects/config.json` `migrate.format`.

**Tech Stack:** TypeScript (ESM), Bun test runner, Zod (config schema), `node:fs/promises`.

**Spec:** `docs/superpowers/specs/2026-08-04-issue-192-flyway-output-adapter-design.md`

## Global Constraints

- **npm-only change.** `migrate-ts` + `cli` + `sdk` only. Schema is TS-owned (ADR-0015) — do NOT touch Java/Python/C#/Kotlin, and do NOT add or edit any conformance fixture.
- **No `any`.** Use `unknown` and narrow. No backwards-compat hacks.
- **Named constants for metamodel strings** — but note `"flyway"`/`"default"` are CLI format tokens, not metamodel vocabulary; a local `const` union in `args.ts` is correct, do NOT add them to `@metaobjectsdev/metadata` constants.
- **Byte-identical default output.** Existing `--format`-less behavior, and all D1 behavior, must be unchanged. Every existing migrate-ts and cli test must pass untouched.
- **Repo test commands:** `cd server/typescript/packages/migrate-ts && bun test`, `cd server/typescript/packages/cli && bun test --timeout 30000`. Never run a bare `bun test` at the repo root.
- **Public repo.** No absolute home paths, no private/other-project names in code, comments, or commit messages.
- **Commit style:** subject `fix(#192): …` or `feat(#192): …`; body explains why. End with the repo's standard trailers.

---

### Task 1: The Flyway adapter

**Files:**
- Create: `server/typescript/packages/migrate-ts/src/write-migration-flyway.ts`
- Modify: `server/typescript/packages/migrate-ts/src/index.ts` (add the export beside `writeMigrationD1`)
- Test: `server/typescript/packages/migrate-ts/test/write-migration-flyway.test.ts`

**Interfaces:**
- Consumes: `EmitResult` from `./types.js` (only `up` / `down` are read).
- Produces: `writeMigrationFlyway(result: Pick<EmitResult, "up" | "down">, opts: WriteMigrationFlywayOptions): Promise<WriteMigrationFlywayResult>` where
  `WriteMigrationFlywayOptions = { dir: string; slug: string }` and
  `WriteMigrationFlywayResult = { upPath: string; downPath: string; version: number }`.
  Task 3 calls this.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/migrate-ts/test/write-migration-flyway.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMigrationFlyway } from "../src/write-migration-flyway.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "flyway-adapter-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const SQL = { up: "CREATE TABLE t (id int);", down: "DROP TABLE t;" };

describe("writeMigrationFlyway — versioning", () => {
  test("an empty dir starts at V1 and writes both files", async () => {
    const res = await writeMigrationFlyway(SQL, { dir, slug: "init" });
    expect(res.version).toBe(1);
    expect(res.upPath).toBe(join(dir, "V1__init.sql"));
    expect(res.downPath).toBe(join(dir, "U1__init.sql"));
    expect(readFileSync(res.upPath, "utf8")).toBe("CREATE TABLE t (id int);\n");
    expect(readFileSync(res.downPath, "utf8")).toBe("DROP TABLE t;\n");
  });

  test("a missing dir is created", async () => {
    const nested = join(dir, "db", "migration");
    const res = await writeMigrationFlyway(SQL, { dir: nested, slug: "init" });
    expect(res.version).toBe(1);
    expect(readdirSync(nested).sort()).toEqual(["U1__init.sql", "V1__init.sql"]);
  });

  test("increments past the highest existing V", async () => {
    writeFileSync(join(dir, "V1__a.sql"), "");
    writeFileSync(join(dir, "V2__b.sql"), "");
    const res = await writeMigrationFlyway(SQL, { dir, slug: "third" });
    expect(res.version).toBe(3);
    expect(res.upPath).toBe(join(dir, "V3__third.sql"));
  });

  // The trap: a naive /^[VU](\d+)/ would let our OWN undo files bump the counter,
  // so every run would skip a version.
  test("U__ files do NOT bump the counter", async () => {
    writeFileSync(join(dir, "V1__a.sql"), "");
    writeFileSync(join(dir, "U1__a.sql"), "");
    const res = await writeMigrationFlyway(SQL, { dir, slug: "second" });
    expect(res.version).toBe(2);
  });

  // Flyway permits dotted versions; the LEADING integer is what we increment.
  test("a dotted version increments on its leading integer", async () => {
    writeFileSync(join(dir, "V10.5__a.sql"), "");
    const res = await writeMigrationFlyway(SQL, { dir, slug: "next" });
    expect(res.version).toBe(11);
  });

  test("non-migration files and repeatables are ignored", async () => {
    writeFileSync(join(dir, "README.md"), "");
    writeFileSync(join(dir, "R__view.sql"), "");
    writeFileSync(join(dir, "notes.txt"), "");
    const res = await writeMigrationFlyway(SQL, { dir, slug: "init" });
    expect(res.version).toBe(1);
  });
});

describe("writeMigrationFlyway — slug", () => {
  // Flyway renders underscores as spaces, so underscores are idiomatic here.
  // This deliberately DIFFERS from the D1 adapter, which uses hyphens.
  test("sanitizes to lowercase underscores, not hyphens", async () => {
    const res = await writeMigrationFlyway(SQL, { dir, slug: "Add Program View!" });
    expect(res.upPath).toBe(join(dir, "V1__add_program_view.sql"));
    expect(res.downPath).toBe(join(dir, "U1__add_program_view.sql"));
  });

  test("empty/punctuation-only slug falls back to 'migration'", async () => {
    const res = await writeMigrationFlyway(SQL, { dir, slug: "!!!" });
    expect(res.upPath).toBe(join(dir, "V1__migration.sql"));
  });

  test("already-newline-terminated SQL is not double-terminated", async () => {
    const res = await writeMigrationFlyway({ up: "A;\n", down: "B;\n" }, { dir, slug: "x" });
    expect(readFileSync(res.upPath, "utf8")).toBe("A;\n");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/migrate-ts && bun test test/write-migration-flyway.test.ts`
Expected: FAIL — cannot resolve module `../src/write-migration-flyway.js`.

- [ ] **Step 3: Write the implementation**

Create `server/typescript/packages/migrate-ts/src/write-migration-flyway.ts`:

```ts
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EmitResult } from "./types.js";

export interface WriteMigrationFlywayOptions {
  /** Flyway migrations dir (e.g. "src/main/resources/db/migration"). Created if missing. */
  dir: string;
  /** Human-readable slug; sanitized to lowercase + underscores. */
  slug: string;
}

export interface WriteMigrationFlywayResult {
  /** Full path to the versioned (V) migration. */
  upPath: string;
  /** Full path to the undo (U) migration. */
  downPath: string;
  /** Assigned version number (e.g. 1, 2, 11). */
  version: number;
}

// Versioned migrations ONLY. Matching [VU] here would let the undo files we
// ourselves emit bump the counter, skipping a version on every run. The version
// may be dotted (Flyway permits V1.1__ / V2.0.1__); we increment its LEADING
// integer, so an existing V10.5__ yields V11__.
const VERSIONED_RE = /^V(\d+)(?:\.\d+)*__/;

export async function writeMigrationFlyway(
  result: Pick<EmitResult, "up" | "down">,
  opts: WriteMigrationFlywayOptions,
): Promise<WriteMigrationFlywayResult> {
  await mkdir(opts.dir, { recursive: true });

  const version = await nextVersion(opts.dir);
  const slug = sanitizeSlug(opts.slug);

  const upPath = join(opts.dir, `V${version}__${slug}.sql`);
  const downPath = join(opts.dir, `U${version}__${slug}.sql`);

  await writeFile(upPath, ensureTrailingNewline(result.up), "utf8");
  await writeFile(downPath, ensureTrailingNewline(result.down), "utf8");

  return { upPath, downPath, version };
}

async function nextVersion(dir: string): Promise<number> {
  let entries: string[];
  // Best-effort: dir was just mkdir'd, but in race/permission edge cases the
  // listing can still fail; treat as empty (next version = 1) rather than rethrow.
  try {
    entries = await readdir(dir);
  } catch {
    return 1;
  }
  let max = 0;
  for (const entry of entries) {
    if (!entry.endsWith(".sql")) continue;
    const m = VERSIONED_RE.exec(entry);
    if (!m) continue;
    const n = parseInt(m[1]!, 10);
    if (n > max) max = n;
  }
  return max + 1;
}

// Underscores, NOT hyphens: Flyway renders a description's underscores as
// spaces, so V4__add_program_view.sql is the idiomatic shape. (The D1 adapter
// sanitizes to hyphens for Wrangler; do not copy that here.)
function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 60);
  return cleaned.length > 0 ? cleaned : "migration";
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s : s + "\n";
}
```

- [ ] **Step 4: Export it**

In `server/typescript/packages/migrate-ts/src/index.ts`, find the line exporting the D1 adapter (search for `write-migration-d1`) and add directly beneath it, matching the surrounding export style:

```ts
export { writeMigrationFlyway } from "./write-migration-flyway.js";
export type {
  WriteMigrationFlywayOptions,
  WriteMigrationFlywayResult,
} from "./write-migration-flyway.js";
```

If the existing D1 export uses a combined `export { x, type Y }` form, match that form instead — follow the file's existing convention.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server/typescript/packages/migrate-ts && bun test test/write-migration-flyway.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Run the whole package suite for regressions**

Run: `cd server/typescript/packages/migrate-ts && bun test`
Expected: PASS, no failures. (Nothing existing calls the new function, so this should be untouched.)

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/migrate-ts/src/write-migration-flyway.ts \
        server/typescript/packages/migrate-ts/src/index.ts \
        server/typescript/packages/migrate-ts/test/write-migration-flyway.test.ts
git commit -m "feat(#192): Flyway output adapter (V__/U__) on the shared migrate engine"
```

---

### Task 2: `--format` flag + config key

**Files:**
- Modify: `server/typescript/packages/sdk/src/config.ts` (add `format` to `MigrateBlock`, ~line 25-32)
- Modify: `server/typescript/packages/cli/src/lib/args.ts` (`MigrateFlags` ~line 324; `parseMigrateArgs` ~line 351)
- Modify: `server/typescript/packages/cli/src/lib/config.ts` (`ResolvedMigrateConfig` ~line 37; `resolveMigrateConfig` ~line 105)
- Test: `server/typescript/packages/cli/test/migrate-format-flag.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `MigrateFormat = "default" | "flyway"` exported from `cli/src/lib/args.ts`; `MigrateFlags.format: MigrateFormat | undefined`; `ResolvedMigrateConfig.format: MigrateFormat`. Task 3 reads `config.format`.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/cli/test/migrate-format-flag.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { parseMigrateArgs } from "../src/lib/args.js";

describe("migrate --format parsing", () => {
  test("absent --format leaves format undefined (config/default decides)", () => {
    expect(parseMigrateArgs([]).format).toBeUndefined();
  });

  test("--format flyway parses", () => {
    expect(parseMigrateArgs(["--format", "flyway"]).format).toBe("flyway");
  });

  test("--format default parses", () => {
    expect(parseMigrateArgs(["--format", "default"]).format).toBe("default");
  });

  test("an invalid --format is rejected, listing the valid values", () => {
    expect(() => parseMigrateArgs(["--format", "liquibase"])).toThrow(
      /invalid --format 'liquibase'; expected: default, flyway/,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/cli && bun test test/migrate-format-flag.test.ts --timeout 30000`
Expected: FAIL — `format` is not a property of the parse result / no such export.

- [ ] **Step 3: Add the format token union + flag to `args.ts`**

Near the other closed-set constants in `server/typescript/packages/cli/src/lib/args.ts` (where `DIALECTS` / `ON_AMBIGUOUS` / `ALLOW_TOKENS` are declared), add:

```ts
/**
 * Output-format adapters (#192). Orthogonal to dialect: a Flyway shop is still on
 * postgres or sqlite. "default" is the homegrown <ts>-<slug>/up.sql layout.
 */
export const MIGRATE_FORMATS = ["default", "flyway"] as const;
export type MigrateFormat = (typeof MIGRATE_FORMATS)[number];
```

In `interface MigrateFlags`, add beside `dialect`:

```ts
  /** Output-format adapter; undefined means "not specified on the CLI". */
  format: MigrateFormat | undefined;
```

In `parseMigrateArgs`, add to the `options` object beside `"dialect"`:

```ts
      "format": { type: "string" },
```

After the existing `--dialect` validation block, add the parallel validation:

```ts
  const format = values.format as string | undefined;
  if (format !== undefined && !MIGRATE_FORMATS.includes(format as MigrateFormat)) {
    throw new Error(`invalid --format '${format}'; expected: ${MIGRATE_FORMATS.join(", ")}`);
  }
```

And in the returned object, beside `dialect`:

```ts
    format: format as MigrateFormat | undefined,
```

- [ ] **Step 4: Add `format` to the config schema**

In `server/typescript/packages/sdk/src/config.ts`, the `MigrateBlock` is a `z.object({...}).partial()`. Add a format enum above it and the field inside it:

```ts
const MigrateFormatEnum = z.enum(["default", "flyway"]);

const MigrateBlock = z.object({
  outDir: z.string(),
  databaseUrl: z.string(),
  dialect: DialectEnum,
  format: MigrateFormatEnum,
  onAmbiguous: OnAmbiguousEnum,
  allow: z.array(AllowTokenEnum),
  d1: D1Block,
}).partial();
```

(Keep the existing fields exactly as they are; only the `format` line is new. `.partial()` already makes it optional.)

- [ ] **Step 5: Resolve the format in `cli/src/lib/config.ts`**

Add to `MIGRATE_DEFAULTS`:

```ts
  format: "default" as MigrateFormat,
```

Add to `interface ResolvedMigrateConfig`, beside `dialect`:

```ts
  /** Output-format adapter (#192): "default" homegrown layout, or "flyway" V__/U__. */
  format: MigrateFormat;
```

Add to the object returned by `resolveMigrateConfig`, beside the `dialect` line:

```ts
    format: flags.format ?? cfgBlock.format ?? MIGRATE_DEFAULTS.format,
```

Import the type at the top: add `MigrateFormat` to the existing `import type { GenFlags, MigrateFlags } from "./args.js";` line.

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server/typescript/packages/cli && bun test test/migrate-format-flag.test.ts --timeout 30000`
Expected: PASS, 4 tests.

- [ ] **Step 7: Typecheck and run the package suite**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/cli' typecheck && bun run --filter '@metaobjectsdev/sdk' typecheck`
Then: `cd server/typescript/packages/cli && bun test --timeout 30000`
Expected: both PASS. Existing tests untouched — `format` defaults to `"default"`, so no behavior changed yet.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/sdk/src/config.ts \
        server/typescript/packages/cli/src/lib/args.ts \
        server/typescript/packages/cli/src/lib/config.ts \
        server/typescript/packages/cli/test/migrate-format-flag.test.ts
git commit -m "feat(#192): --format flag + migrate.format config key (orthogonal to dialect)"
```

---

### Task 3: Wire the adapter into `migrate` + the refusal matrix

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/migrate.ts` (refusals near the existing `config.dialect === "d1"` block ~line 238; write dispatch at the two `writeMigration(` call sites ~line 479 and ~line 865; `--help` text ~line 70)
- Test: `server/typescript/packages/cli/test/migrate-format-flyway.test.ts`

**Interfaces:**
- Consumes: `writeMigrationFlyway` from Task 1 (`@metaobjectsdev/migrate-ts`); `config.format` from Task 2.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/cli/test/migrate-format-flyway.test.ts`. Model the harness on the existing `test/migrate-args.test.ts` / `test/migrate-ux.test.ts` — read one of them first to copy how `run()` is invoked and how exit codes are asserted, then write:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/index.js";

let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "migrate-flyway-cli-"));
  mkdirSync(join(cwd, "metaobjects"), { recursive: true });
  writeFileSync(
    join(cwd, "metaobjects", "meta.demo.json"),
    JSON.stringify({
      "metadata.root": {
        package: "acme",
        children: [
          {
            "object.entity": {
              name: "Program",
              children: [
                { "source.rdb": { name: "src", "@table": "programs" } },
                { "field.long": { name: "id" } },
                { "field.string": { name: "title" } },
                { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
              ],
            },
          },
        ],
      },
    }),
  );
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

describe("migrate --format flyway — refusals", () => {
  // Flyway owns apply + history; writing behind it desyncs flyway_schema_history.
  test("--apply is refused, naming flyway migrate", async () => {
    const code = await run(
      ["migrate", "--dialect", "postgres", "--format", "flyway", "--apply", "--slug", "x"],
      { cwd },
    );
    expect(code).toBe(2);
  });

  test("apply-pending is refused", async () => {
    const code = await run(
      ["migrate", "apply-pending", "--dialect", "postgres", "--format", "flyway"],
      { cwd },
    );
    expect(code).toBe(2);
  });

  test("--rollback is refused", async () => {
    const code = await run(
      ["migrate", "--dialect", "postgres", "--format", "flyway", "--rollback", "V1"],
      { cwd },
    );
    expect(code).toBe(2);
  });

  test("--dialect d1 with --format flyway is refused", async () => {
    const code = await run(
      ["migrate", "--dialect", "d1", "--format", "flyway", "--slug", "x"],
      { cwd },
    );
    expect(code).toBe(2);
  });
});

describe("migrate --format flyway — emit", () => {
  test("offline generate writes V1__/U1__ into the flyway convention dir", async () => {
    const code = await run(
      ["migrate", "--dialect", "sqlite", "--format", "flyway", "--slug", "init"],
      { cwd },
    );
    expect(code).toBe(0);
    const dir = join(cwd, "src", "main", "resources", "db", "migration");
    expect(readdirSync(dir).sort()).toEqual(["U1__init.sql", "V1__init.sql"]);
  });

  test("--out-dir overrides the convention dir", async () => {
    const code = await run(
      ["migrate", "--dialect", "sqlite", "--format", "flyway", "--slug", "init",
       "--out-dir", "db/mig"],
      { cwd },
    );
    expect(code).toBe(0);
    expect(readdirSync(join(cwd, "db", "mig")).sort()).toEqual(["U1__init.sql", "V1__init.sql"]);
  });

  test("default format is unchanged (no V__ files, per-migration dir)", async () => {
    const code = await run(["migrate", "--dialect", "sqlite", "--slug", "init"], { cwd });
    expect(code).toBe(0);
    const entries = readdirSync(join(cwd, ".metaobjects", "migrations"));
    expect(entries.some((e) => e.startsWith("V1__"))).toBe(false);
    expect(entries.length).toBe(1);
  });
});
```

**Note on the `run()` signature:** if the existing cli tests invoke `run(argv, { cwd })` differently (e.g. a `--cwd` flag or a different options object), copy their exact form — do not invent one.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/cli && bun test test/migrate-format-flyway.test.ts --timeout 30000`
Expected: FAIL — refusals return 0 instead of 2, and no `V1__init.sql` is produced.

- [ ] **Step 3: Add the refusal matrix**

In `server/typescript/packages/cli/src/commands/migrate.ts`, immediately BEFORE the existing `if (config.dialect === "d1") {` block, add:

```ts
  // #192 — Flyway owns apply + history (flyway_schema_history). We generate the
  // migration; applying it is Flyway's job. Refuse at generation time rather than
  // emitting something that would desync its history table (the #226/#241/#258
  // detect-and-refuse posture).
  if (config.format === "flyway") {
    if (config.dialect === "d1") {
      log.error(`migrate: --format flyway is not supported for dialect 'd1' (d1 has its own wrangler migrations layout)`);
      emitStructuredError(
        `migrate: --format flyway is not supported for dialect 'd1'`,
        "drop --format flyway for d1 — wrangler owns the migrations layout",
        fmt,
      );
      return 2;
    }
    if (config.apply) {
      log.error(`migrate: --apply is not supported with --format flyway — run 'flyway migrate' to apply`);
      emitStructuredError(
        `migrate: --apply is not supported with --format flyway`,
        "run 'flyway migrate' to apply — applying behind Flyway desyncs flyway_schema_history",
        fmt,
      );
      return 2;
    }
    if (config.applyPending) {
      log.error(`migrate apply-pending is not supported with --format flyway — run 'flyway migrate' to replay`);
      emitStructuredError(
        `migrate apply-pending is not supported with --format flyway`,
        "run 'flyway migrate' to replay committed migrations",
        fmt,
      );
      return 2;
    }
    if (config.rollback !== undefined) {
      log.error(`migrate: --rollback is not supported with --format flyway — use 'flyway undo' (Teams) or roll forward`);
      emitStructuredError(
        `migrate: --rollback is not supported with --format flyway`,
        "use 'flyway undo' (Flyway Teams) or roll forward — the metaobjects ledger does not exist on a Flyway-managed DB",
        fmt,
      );
      return 2;
    }
  }
```

- [ ] **Step 4: Dispatch at the two write call sites**

Add the import beside the existing `writeMigrationD1` import at the top of the file:

```ts
  writeMigrationFlyway,
```

Add this helper near the other module-level helpers in `migrate.ts`:

```ts
/** Flyway's conventional migrations location for a JVM project (#192). */
const FLYWAY_DEFAULT_OUT_DIR = "src/main/resources/db/migration";

/**
 * Resolve the migration output dir for the active format. Mirrors the D1 path's
 * shape: an explicit --out-dir always wins; otherwise each adapter falls back to
 * its own ecosystem convention rather than the homegrown default.
 */
function resolveFormatOutDir(config: ResolvedMigrateConfig, metaRoot: string): string {
  const isDefaultOutDir = config.outDir === MIGRATE_DEFAULT_OUT_DIR;
  if (config.format === "flyway" && isDefaultOutDir) {
    return resolvePath(metaRoot, FLYWAY_DEFAULT_OUT_DIR);
  }
  return resolvePath(metaRoot, config.outDir);
}
```

At the FIRST `writeMigration(` call site (the live-DB/diff path, ~line 477-482), replace:

```ts
          const outDir = resolvePath(metaRoot, config.outDir);
          await mkdir(outDir, { recursive: true });
          const res = await writeMigration(
            { up: emitted.up, down: emitted.down },
            { dir: outDir, slug: config.slug },
          );
          writtenPaths = [res.upPath, res.downPath];
```

with:

```ts
          const outDir = resolveFormatOutDir(config, metaRoot);
          await mkdir(outDir, { recursive: true });
          const res = config.format === "flyway"
            ? await writeMigrationFlyway(
                { up: emitted.up, down: emitted.down },
                { dir: outDir, slug: config.slug },
              )
            : await writeMigration(
                { up: emitted.up, down: emitted.down },
                { dir: outDir, slug: config.slug },
              );
          writtenPaths = [res.upPath, res.downPath];
```

At the SECOND `writeMigration(` call site (the offline `runOfflineGenerate` path, ~line 863-867), apply the same conditional, using that block's local variable names (`emitResult`, `outDir`). Ensure the `outDir` computed there also goes through `resolveFormatOutDir`.

**Type note:** both result shapes carry `upPath` and `downPath`, so `writtenPaths` and the log lines need no change. `WriteMigrationResult` additionally has `dir` and `WriteMigrationFlywayResult` has `version` — do NOT read either from the shared branch, or the union will not typecheck.

- [ ] **Step 5: Update the `--help` text**

In the help block (~line 70, beside the `--out-dir` line), add:

```
  --format <fmt>       Output layout: default | flyway (default: default)
```

And extend the `--out-dir` line to note the per-format default:

```
  --out-dir <path>     Migration directory (default: ./.metaobjects/migrations; flyway: src/main/resources/db/migration)
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd server/typescript/packages/cli && bun test test/migrate-format-flyway.test.ts --timeout 30000`
Expected: PASS, 7 tests.

- [ ] **Step 7: Full cli suite + typecheck**

Run: `cd server/typescript/packages/cli && bun test --timeout 30000`
Then: `cd server/typescript && bun run --filter '@metaobjectsdev/cli' typecheck`
Expected: both PASS with no existing test changed.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/cli/src/commands/migrate.ts \
        server/typescript/packages/cli/test/migrate-format-flyway.test.ts
git commit -m "feat(#192): wire the Flyway adapter into migrate + detect-and-refuse apply/rollback"
```

---

### Task 4: Real-engine gate + docs

**Files:**
- Test: `server/typescript/packages/cli/test/integration/migrate-flyway-apply.test.ts`
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section)
- Modify: `docs/features/cli.md` (the migrate section)

**Interfaces:**
- Consumes: everything from Tasks 1-3.
- Produces: nothing.

- [ ] **Step 1: Write the real-engine round-trip test**

This is the gate every migrate change in this repo carries, because a green unit suite has historically missed exactly this class: **emit → apply to a real engine → introspect → re-diff must be EMPTY.**

First read `server/typescript/packages/cli/test/integration/migrate-projection-kinds.test.ts` — it already does emit → apply-to-real-sqlite → assert, using `createClient` from `@libsql/client`. Copy its harness shape exactly (temp dir, metadata fixture, `run()` invocation, libsql client), then write `test/integration/migrate-flyway-apply.test.ts` asserting:

1. `meta migrate --dialect sqlite --format flyway --slug init` writes `V1__init.sql` + `U1__init.sql`.
2. Executing the statements in `V1__init.sql` against a real libsql database succeeds.
3. A SECOND `meta migrate --dialect sqlite --format flyway --slug next` run against the now-current snapshot reports **no schema changes** and writes **no** `V2__` file — i.e. the emitted migration genuinely converged.
4. Adding a field to the metadata and re-running produces `V2__`/`U2__` (the counter advanced past the existing `V1__`), and applying `V2__` also succeeds.

Assertion 3 is the load-bearing one: it proves the adapter's output is complete, not merely well-named.

- [ ] **Step 2: Run it and confirm it passes**

Run: `cd server/typescript/packages/cli && bun test test/integration/migrate-flyway-apply.test.ts --timeout 30000`
Expected: PASS. If assertion 3 fails, the bug is real — do NOT weaken the assertion; fix the emit/dispatch path.

- [ ] **Step 3: Document in `docs/features/cli.md`**

In the migrate section, add a short subsection covering: `--format default|flyway`; that format is orthogonal to dialect; the `V<N>__`/`U<N>__` layout with integer scan-and-increment; that Flyway Community ignores `U__` files (undo is a paid edition feature) so they are inert-but-correct there; the `src/main/resources/db/migration` default dir; and that apply/apply-pending/rollback are refused because Flyway owns apply and history.

- [ ] **Step 4: Add the CHANGELOG entry**

Under `## [Unreleased]`, add an `### Added` entry describing the adapter, noting it closes the ADR-0015 gap left when `meta:migrate --flyway` was removed, and that it is npm-only (`migrate-ts` + `cli` + `sdk`).

- [ ] **Step 5: Run the full TS gates**

```bash
cd server/typescript/packages/migrate-ts && bun test
cd server/typescript/packages/cli && bun test --timeout 30000
cd <repo-root> && bun run --filter '*' build && bun run --filter '*' typecheck
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/cli/test/integration/migrate-flyway-apply.test.ts \
        docs/features/cli.md CHANGELOG.md
git commit -m "test(#192): real-engine apply + re-diff gate for the Flyway adapter; docs"
```

---

## Self-Review

**Spec coverage:**
- §2 architecture (third adapter, engine untouched) → Task 1
- §3 D1 integer scan-and-increment, U__ non-bumping, dotted versions → Task 1 Steps 1/3
- §3 D2 `U<N>__` undo emission → Task 1
- §3 D3 underscore sanitization → Task 1 Step 1 (slug tests) + Step 3 comment
- §3 D4 `--format` flag + config key, flag wins → Task 2
- §3 D5 out-dir fallback → Task 3 Step 4 (`resolveFormatOutDir`)
- §4 components 1-5 → Tasks 1 (adapter, index export), 2 (sdk schema, args, config), 3 (migrate dispatch)
- §6 refusal matrix, all four rows → Task 3 Step 3 + tests
- §7 testing: unit → Task 1; CLI/refusals/precedence → Tasks 2+3; real-engine gate → Task 4; no-churn → Task 3 Step 1 final test + Task 1 Step 6
- §9 out of scope: no other adapters, no Java goal, no engine gap work — no task touches these.

**Placeholder scan:** No TBD/TODO. Every code step carries real code. Two steps intentionally say "read the neighbouring test first and copy its harness" (Task 3 Step 1, Task 4 Step 1) — this is a direct instruction to match an existing in-repo pattern rather than a vague placeholder, and the assertions to write are enumerated explicitly.

**Type consistency:** `writeMigrationFlyway` / `WriteMigrationFlywayOptions` / `WriteMigrationFlywayResult` named identically in Task 1 (definition), Task 1 Step 4 (export), and Task 3 Step 4 (call). `MigrateFormat` / `MIGRATE_FORMATS` named identically in Task 2 Steps 3/5 and consumed as `config.format` in Task 3. Result union caveat (`dir` vs `version`) is called out at the call site in Task 3 Step 4.
