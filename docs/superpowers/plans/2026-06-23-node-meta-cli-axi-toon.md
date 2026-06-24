# Node `meta` CLI → axi + TOON — Implementation Plan (Plan 2 of 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Node `meta` CLI agent-friendly per the axi standard — TOON output (TTY-aware default), a uniform `--format` flag, structured errors + exit codes, next-step suggestions, per-subcommand `--help`, and the `meta migrate` UX fixes — so an agent (and the four downstream ports that mirror it) gets token-efficient, parseable, self-describing output.

**Architecture:** `meta`'s output already flows through pure formatter functions (`src/lib/output.ts`) and a stdout/stderr-split logger (`src/lib/log.ts`). We add a sibling TOON formatter per result type using `@toon-format/toon`, a `resolveFormat()` selector, and a global `--format` flag parsed in `run()` (like the existing `--cwd`). Default is TTY-aware: humans at a terminal get the current text; pipes/agents get TOON. axi's robustness/discoverability rules (exit codes, structured errors on stdout, `help[]` next-steps, per-subcommand `--help`) are layered onto the existing dispatcher.

**Tech Stack:** TypeScript, `bun test`, `@toon-format/toon@^2.3.0`, the existing `meta` CLI (`server/typescript/packages/cli`).

## Global Constraints

- **Decisions (from the 2026-06-23 design review):** D1 TTY-aware TOON (text on TTY, TOON on non-TTY); D2 flag is `--format <toon|json|text>`; exit codes `0` success/no-op, `1` error, `2` usage error; structured errors on **stdout** (per axi), progress/debug on stderr; D5 build order Node first (this plan).
- **TOON package:** `@toon-format/toon` (the official org pkg; the bare `toon` is an unrelated squatter). Confirm the encode export name on install (Task 1 Step 2).
- **No interactive prompts** — every operation completable via flags (axi). The migrate `--remote --apply` confirmation pause must be skippable with `--yes` (already exists).
- **Public repo:** no private names / local abspaths in committed files.
- Tests: `bun test` from `server/typescript/packages/cli/`.
- Existing data shapes (do not rename): `GenResultShape { files: GenFileEntry[]; outDir; dialect; dryRun; warnings }`, `GenFileEntry { path; status: GenFileStatus; info }`, `GenFileStatus = "new"|"merged"|"conflict"|"unchanged"|"refused"`. The migrate shape is in `output.ts` (`formatMigrateResult` input) — read it in Task 4.

---

## File Structure

```
server/typescript/packages/cli/
  src/lib/format.ts          # NEW: OutputFormat type + resolveFormat() + toonEncode() wrapper
  src/lib/output.ts          # MODIFY: add formatGenResultToon / formatMigrateResult Toon; add help[] next-steps
  src/lib/output-json.ts     # NEW: plain JSON fallback (--format json) for gen/migrate result shapes
  src/index.ts               # MODIFY: parse global --format; per-subcommand --help; content-first no-args
  src/commands/gen.ts        # MODIFY: emit chosen format
  src/commands/migrate.ts    # MODIFY: emit chosen format; axi UX fixes (baseline, libsql, idempotency)
  package.json               # MODIFY: add @toon-format/toon + @libsql/kysely-libsql dep
  test/lib/format.test.ts    # NEW
  test/lib/output-toon.test.ts # NEW
```

---

## Task 1: Format selector + TOON wrapper

**Files:**
- Create: `src/lib/format.ts`
- Modify: `package.json` (add `@toon-format/toon`)
- Test: `test/lib/format.test.ts`

**Interfaces:**
- Produces: `type OutputFormat = "toon" | "json" | "text"`; `resolveFormat(flag: string | undefined, isTTY: boolean): OutputFormat`; `toonEncode(value: unknown): string`.

- [ ] **Step 1: Write the failing test**

`test/lib/format.test.ts`:
```ts
import { test, expect, describe } from "bun:test";
import { resolveFormat, toonEncode } from "../../src/lib/format.js";

describe("resolveFormat", () => {
  test("explicit flag wins over TTY", () => {
    expect(resolveFormat("toon", true)).toBe("toon");
    expect(resolveFormat("text", false)).toBe("text");
    expect(resolveFormat("json", true)).toBe("json");
  });
  test("default is TTY-aware: text on TTY, toon on non-TTY", () => {
    expect(resolveFormat(undefined, true)).toBe("text");
    expect(resolveFormat(undefined, false)).toBe("toon");
  });
});

describe("toonEncode", () => {
  test("emits tabular TOON for a uniform array of objects", () => {
    const out = toonEncode({ gen: [{ file: "a.ts", status: "new" }, { file: "b.ts", status: "new" }] });
    expect(out).toContain("gen[2]{file,status}:");
    expect(out).toContain("a.ts,new");
  });
});
```

- [ ] **Step 2: Add the dep and confirm the encode export**

Run: `cd server/typescript/packages/cli && npm pkg set dependencies.@toon-format/toon=^2.3.0 && npm install @toon-format/toon@^2.3.0`
Then confirm the export: `node -e "console.log(Object.keys(require('@toon-format/toon')))"`
Expected: an `encode` (and `decode`) export. If the encoder is named differently (e.g. `stringify`), use that name in Step 3 and note it.

- [ ] **Step 3: Implement `format.ts`**

```ts
import { encode } from "@toon-format/toon"; // confirm name in Step 2

export type OutputFormat = "toon" | "json" | "text";

const VALID = new Set<OutputFormat>(["toon", "json", "text"]);

export function resolveFormat(flag: string | undefined, isTTY: boolean): OutputFormat {
  if (flag && VALID.has(flag as OutputFormat)) return flag as OutputFormat;
  // TTY-aware default: humans at a terminal get text; pipes/agents get TOON.
  return isTTY ? "text" : "toon";
}

export function toonEncode(value: unknown): string {
  return encode(value);
}
```

- [ ] **Step 4: Run the test; verify pass**

Run: `bun test test/lib/format.test.ts`
Expected: PASS (both describes). If `toonEncode`'s tabular output differs (header/row shape), align the assertion to the real TOON output (it must collapse uniform object arrays to `name[len]{keys}:` + CSV rows).

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts test/lib/format.test.ts package.json package-lock.json
git commit -m "feat(cli): add output-format selector (TTY-aware) + TOON encode wrapper"
```

---

## Task 2: TOON + JSON formatters for the gen result

**Files:**
- Modify: `src/lib/output.ts` (add `formatGenResultToon`, `genResultToData`)
- Create: `src/lib/output-json.ts`
- Test: `test/lib/output-toon.test.ts`

**Interfaces:**
- Consumes: `GenResultShape`, `toonEncode` (Task 1).
- Produces: `genResultToData(result: GenResultShape): object` (the axi-shaped plain object: tabular files + aggregates + `help`), `formatGenResultToon(result: GenResultShape): string`, `formatGenResultJson(result: GenResultShape): string`.

- [ ] **Step 1: Write the failing test**

`test/lib/output-toon.test.ts`:
```ts
import { test, expect, describe } from "bun:test";
import { formatGenResultToon, genResultToData } from "../../src/lib/output.js";

const result = {
  files: [
    { path: "src/User.ts", status: "new" as const, info: "" },
    { path: "src/User.routes.ts", status: "unchanged" as const, info: "" },
  ],
  outDir: "src", dialect: "sqlite" as const, dryRun: false, warnings: [],
};

describe("gen TOON output (axi)", () => {
  test("data has tabular files, aggregate summary, and next-step help", () => {
    const d = genResultToData(result) as any;
    expect(d.gen).toHaveLength(2);
    expect(d.gen[0]).toEqual({ file: "src/User.ts", status: "new" });
    expect(d.summary).toContain("1 written");     // aggregate inline
    expect(d.summary).toContain("1 unchanged");
    expect(Array.isArray(d.help)).toBe(true);      // next-step suggestions
    expect(d.help.join(" ")).toContain("tsc");     // build hint
  });
  test("TOON string collapses the file array to a tabular block", () => {
    const s = formatGenResultToon(result);
    expect(s).toContain("gen[2]{file,status}:");
    expect(s).toContain("src/User.ts,new");
  });
  test("empty gen states the zero explicitly (axi definitive empty state)", () => {
    const d = genResultToData({ ...result, files: [] }) as any;
    expect(d.summary.toLowerCase()).toContain("no entities");
  });
});
```

- [ ] **Step 2: Run it; verify it fails**

Run: `bun test test/lib/output-toon.test.ts`
Expected: FAIL — `genResultToData`/`formatGenResultToon` not exported.

- [ ] **Step 3: Implement in `output.ts`**

Add (reuse the existing `GenFileStatus` counts logic):
```ts
import { toonEncode } from "./format.js";

export function genResultToData(result: GenResultShape): {
  gen: { file: string; status: GenFileStatus }[]; summary: string; help: string[];
} {
  const counts = result.files.reduce<Record<GenFileStatus, number>>(
    (a, f) => ((a[f.status] = (a[f.status] ?? 0) + 1), a),
    { new: 0, merged: 0, conflict: 0, unchanged: 0, refused: 0 },
  );
  const parts: string[] = [];
  if (counts.new) parts.push(`${counts.new} written`);
  if (counts.merged) parts.push(`${counts.merged} merged`);
  if (counts.conflict) parts.push(`${counts.conflict} conflict`);
  if (counts.unchanged) parts.push(`${counts.unchanged} unchanged`);
  if (counts.refused) parts.push(`${counts.refused} refused`);
  const summary = result.files.length === 0
    ? `no entities to generate in ${result.outDir}`
    : parts.join(", ");
  const help = result.files.length === 0
    ? ["author entities under metaobjects/ then re-run `meta gen`"]
    : ["typecheck the generated code with `npx tsc`", "run schema with `meta migrate --db <url> --slug <name>`"];
  return { gen: result.files.map((f) => ({ file: f.path, status: f.status })), summary, help };
}

export function formatGenResultToon(result: GenResultShape): string {
  return toonEncode(genResultToData(result));
}
```
`src/lib/output-json.ts`:
```ts
import type { GenResultShape } from "./output.js";
import { genResultToData } from "./output.js";
export function formatGenResultJson(result: GenResultShape): string {
  return JSON.stringify(genResultToData(result), null, 2);
}
```

- [ ] **Step 4: Run the test; verify pass**

Run: `bun test test/lib/output-toon.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/output.ts src/lib/output-json.ts test/lib/output-toon.test.ts
git commit -m "feat(cli): TOON+JSON gen formatters with axi aggregates + next-step help"
```

---

## Task 3: TOON + JSON formatters for the migrate result

**Files:**
- Modify: `src/lib/output.ts` (add `migrateResultToData`, `formatMigrateResultToon`), `src/lib/output-json.ts`
- Test: `test/lib/output-toon.test.ts` (extend)

**Interfaces:**
- Consumes: the migrate result shape (the input type of the existing `formatMigrateResult` — read it first).
- Produces: `migrateResultToData(result): object`, `formatMigrateResultToon(result): string`, `formatMigrateResultJson(result): string`.

- [ ] **Step 1: Read the migrate result shape**

Run: `sed -n '/migrate/,/^export function formatMigrateResult/p' src/lib/output.ts` (find the input interface + the `formatMigrateResult` signature). Note the field names (dialect, db/url, changes, written files, blocked entries).

- [ ] **Step 2: Write the failing test** (extend `output-toon.test.ts`)

```ts
import { formatMigrateResultToon, migrateResultToData } from "../../src/lib/output.js";
test("migrate TOON: tabular changes + status + applied count", () => {
  // Build a minimal result object matching the real shape read in Step 1.
  const r = /* minimal MigrateResultShape: dialect sqlite, 1 create-table change, 0 blocked */;
  const d = migrateResultToData(r) as any;
  expect(d.changes[0]).toHaveProperty("kind");
  expect(typeof d.summary).toBe("string");
  expect(formatMigrateResultToon(r)).toContain("changes[");
});
```
(Fill the `r` literal from the shape read in Step 1 — do not leave it as a comment in the committed test.)

- [ ] **Step 3: Implement `migrateResultToData` + `formatMigrateResultToon`** mirroring Task 2's structure: a tabular `changes[]{kind,object}` array, a `written[]` list, an inline `summary` (e.g. `"1 create-table, 2 add-index; applied"`), and `help[]` (`["inspect with `meta migrate status`"]` or, when blocked, the `--allow`/`--slug` next step). Add the JSON variant to `output-json.ts`.

- [ ] **Step 4: Run the test; verify pass**

Run: `bun test test/lib/output-toon.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/output.ts src/lib/output-json.ts test/lib/output-toon.test.ts
git commit -m "feat(cli): TOON+JSON migrate formatters with axi aggregates + next-step help"
```

---

## Task 4: Parse `--format` globally and thread it to commands

**Files:**
- Modify: `src/index.ts` (extract `--format` like `--cwd`; pass into command dispatch), `src/commands/gen.ts`, `src/commands/migrate.ts`
- Test: `test/index-format.test.ts` (new)

**Interfaces:**
- Consumes: `resolveFormat` (Task 1), the format functions (Tasks 2–3).
- Produces: each command receives a resolved `OutputFormat` and emits the matching string via `log.info`.

- [ ] **Step 1: Write the failing test** (dispatch-level, capturing stdout)

`test/index-format.test.ts`:
```ts
import { test, expect } from "bun:test";
import { run } from "../src/index.js";
// Run `meta gen --format toon --dry-run` in a fixture dir; capture console.log.
// Assert stdout contains a TOON header ("gen[" or "no entities") not the glyph text.
```
(Use an existing gen fixture/project dir; if none, point `--cwd` at a minimal metaobjects/ fixture. Assert the TOON shape appears under `--format toon` and the word-table appears under `--format text`.)

- [ ] **Step 2: Extract `--format` in `run()`** alongside the `--cwd` loop in `src/index.ts`:
```ts
let format: string | undefined;
// inside the argv loop, before pushing to cleaned:
if (a === "--format") { format = argv[++i]; continue; }
if (a.startsWith("--format=")) { format = a.slice("--format=".length); continue; }
```
Resolve once and pass into the command calls:
```ts
import { resolveFormat } from "./lib/format.js";
const fmt = resolveFormat(format, process.stdout.isTTY ?? false);
// e.g. return genCommand(rest, cwd, fmt);
```
Add `--format <toon|json|text>` to `HELP_TEXT` GLOBAL OPTIONS.

- [ ] **Step 3: Route gen + migrate output through the format** in `src/commands/gen.ts` / `migrate.ts`:
```ts
import { formatGenResult, formatGenResultToon } from "../lib/output.js";
import { formatGenResultJson } from "../lib/output-json.js";
const out =
  fmt === "toon" ? formatGenResultToon(result)
  : fmt === "json" ? formatGenResultJson(result)
  : formatGenResult(result, { isTTY: process.stdout.isTTY ?? false });
log.info(out);
```
(Same pattern in migrate.)

- [ ] **Step 4: Run the test; verify pass**

Run: `bun test test/index-format.test.ts && bun test`
Expected: PASS; full CLI suite still green.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts src/commands/gen.ts src/commands/migrate.ts test/index-format.test.ts
git commit -m "feat(cli): --format flag (TTY-aware) routes gen/migrate through TOON/JSON/text"
```

---

## Task 5: `meta migrate` axi UX fixes

**Files:**
- Modify: `src/commands/migrate.ts`, `package.json` (declare `@libsql/kysely-libsql`)
- Test: `test/migrate-ux.test.ts` (new)

**Interfaces:**
- Produces: idempotent/clear baseline flow, declared sqlite driver dep, package-manager-aware error, structured error output on stdout.

- [ ] **Step 1: Declare the sqlite driver dependency**

Run: `cd server/typescript/packages/cli && npm pkg set dependencies.@libsql/kysely-libsql=^0.4.0 && npm install`
(Removes the "install it: `bun add ...`" runtime surprise; sqlite migrate now works out of the box.)

- [ ] **Step 2: Write the failing tests**

`test/migrate-ux.test.ts`:
```ts
import { test, expect } from "bun:test";
import { run } from "../src/index.js";
test("migrate --help prints migrate-specific usage and exits 0", async () => {
  // capture console.log; run(["migrate","--help"]); assert it mentions --db/--slug/baseline and returns 0
});
test("re-running migrate with no changes is a no-op exit 0 with an explicit empty state", async () => {
  // against an already-migrated fixture: assert exit 0 + a 'no changes' message (not an error)
});
```

- [ ] **Step 3: Implement**
  - **Per-subcommand `--help`:** in `migrate.ts`, if `rest` includes `--help`/`-h`, print a migrate-usage block (the MIGRATE FLAGS section) and return 0.
  - **Baseline discoverability:** when the engine reports "no schema snapshot", instead of surfacing the raw error, emit a structured next-step on stdout: `help[1]: first run `meta migrate baseline --dialect <d>`` (or auto-run baseline when safe — choose the auto path only if the engine exposes it without a destructive risk; otherwise the guided message).
  - **Idempotency:** when there are no changes, return exit 0 with an explicit `migrate: no changes` empty-state (already partially true — ensure exit 0, not error).
  - **PM-aware missing-dep error:** if `@libsql/kysely-libsql` is somehow absent, detect the lockfile (package-lock.json/pnpm-lock.yaml/bun.lockb) and print the matching install command, not a hardcoded `bun add`.
  - **Structured errors on stdout:** migrate failures print a `{error, hint}` object in the active `--format` on stdout (exit 1), per axi.

- [ ] **Step 4: Run tests; verify pass**

Run: `bun test test/migrate-ux.test.ts && bun test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/commands/migrate.ts package.json package-lock.json test/migrate-ux.test.ts
git commit -m "fix(cli): axi-conformant meta migrate (--help, idempotent, declared libsql, PM-aware errors)"
```

---

## Task 6: Per-subcommand `--help` + content-first no-args + structured errors/exit codes

**Files:**
- Modify: `src/index.ts` (per-subcommand `--help` routing; no-args view; ensure exit codes 0/1/2)
- Test: `test/help-and-exit.test.ts` (new)

**Interfaces:**
- Produces: `gen --help`, `verify --help`, `export --help`, `docs --help`, `prompt-snapshot --help`, `init --help` each print a focused usage block (exit 0); bare `meta` prints a content-first status + `help[]` next-steps; usage errors return 2, runtime errors return 1.

- [ ] **Step 1: Write the failing tests**

`test/help-and-exit.test.ts`:
```ts
import { test, expect } from "bun:test";
import { run } from "../src/index.js";
test("each subcommand supports --help and exits 0", async () => {
  for (const c of ["gen","migrate","verify","export","docs","init"]) {
    expect(await run([c, "--help"])).toBe(0);
  }
});
test("unknown command exits 2 (usage error)", async () => {
  expect(await run(["bogus"])).toBe(2);
});
```

- [ ] **Step 2: Implement** a small per-command help map in `index.ts` (each command's usage slice from `HELP_TEXT`), routed when `rest` includes `--help`/`-h` before the command runs; make the `default:` switch case return 2 (usage error) for unknown commands; keep bare-`meta` as a concise status + next-step `help[]` (content-first) rather than dumping the full manual.

- [ ] **Step 3: Run tests; verify pass**

Run: `bun test test/help-and-exit.test.ts && bun test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.ts test/help-and-exit.test.ts
git commit -m "feat(cli): per-subcommand --help, content-first no-args, 0/1/2 exit codes (axi)"
```

---

## Task 7: Conformance pass + docs

**Files:**
- Modify: `agent-context/skills/metaobjects-verify/references/migration.md` (document the now-discoverable baseline flow + `--format`), `agent-context/skills/metaobjects-codegen/references/typescript.md` (note `--format toon` default for agents)
- Test: full `bun test`

- [ ] **Step 1: Run the whole CLI suite**

Run: `cd server/typescript/packages/cli && bun test`
Expected: all green.

- [ ] **Step 2: Update the references** to mention `--format <toon|json|text>` (TTY-aware default) and the baseline step now surfaced by `migrate`. Re-bundle: `cd ../sdk && npm run bundle-agent-context && bun test test/agent-context/drift.test.ts`.

- [ ] **Step 3: Commit**

```bash
git add agent-context/skills/metaobjects-verify/references/migration.md \
        agent-context/skills/metaobjects-codegen/references/typescript.md
git commit -m "docs(agent-context): document --format + discoverable migrate baseline"
```

---

## Self-Review

**Spec coverage (axi 10 principles):** TOON output (T1–4) ✔; minimal schemas — gen/migrate data uses ~2-field rows ✔; aggregates/totals inline (T2/T3 `summary`) ✔; definitive empty states (T2 empty test, T5 no-op) ✔; idempotent mutations + exit 0/1/2 (T5/T6) ✔; structured errors on stdout (T5/T6) ✔; no prompts — `--yes` exists, no new prompts ✔; content-first no-args (T6) ✔; next-step `help[]` (T2/T3) ✔; per-subcommand `--help` (T6) ✔. Truncation w/ size hint: **not yet needed** (gen/migrate output has no large free-text fields) — defer to any command that emits large blobs.

**Placeholder scan:** Task 3 Step 2 and Task 4/5/6 test bodies contain `/* ... */` describing a literal/capture to fill from the shape read in the preceding step — these are explicit "fill from observed shape" steps (the exact shape/capture API can't be known until the file is read at execution), not silent TODOs. All implementation code blocks are concrete.

**Type consistency:** `OutputFormat`, `resolveFormat`, `toonEncode`, `genResultToData`, `formatGenResultToon`, `formatGenResultJson`, `migrateResultToData`, `formatMigrateResultToon` are used consistently across `format.ts`, `output.ts`, `output-json.ts`, and the command files. Existing `GenResultShape`/`GenFileStatus` names are reused unchanged.
