# Prompt Snapshot Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `meta prompt-snapshot [--check]` CLI command (TypeScript) that renders each `template.*` against a committed fixture payload and snapshots the byte-exact output under `.metaobjects/snapshots/`, with a `--check` CI gate that fails on drift.

**Architecture:** A new CLI command mirroring `meta verify`: load metadata, build a `FileProvider` over the prompts dir, iterate the root's `template.*` children, and for each that has a committed `.metaobjects/snapshots/<name>/payload.json`, render via the existing `render()` engine. Write mode overwrites `output.snap`; check mode diffs against it and exits non-zero on drift. Two small pure helpers (arg parsing, path+diff) are unit-tested; the command is covered by integration tests that scaffold a temp project.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/cli` (host package), `@metaobjectsdev/render` (`render`, `RenderFormat`), `@metaobjectsdev/metadata` (`TYPE_TEMPLATE`, `TEMPLATE_ATTR_TEXT_REF`, `TEMPLATE_ATTR_FORMAT`), `@metaobjectsdev/sdk` (`loadMemory`). Node `parseArgs`.

**Spec:** `docs/superpowers/specs/2026-05-23-prompt-snapshot-harness-design.md`

---

## File Structure

All paths under `server/typescript/packages/cli/`.

- **Create** `src/lib/snapshot.ts` — pure helpers: `snapshotPaths(cwd, templateName)` (resolves the per-template dir + `payload.json` + `output.snap` paths) and `unifiedDiff(expected, actual)` (compact line diff for drift reporting). No I/O, no metadata — trivially unit-testable.
- **Modify** `src/lib/args.ts` — add `parsePromptSnapshotArgs` + `PromptSnapshotFlags` (`--check` boolean, `--prompts` string), mirroring `parseVerifyArgs`.
- **Create** `src/commands/prompt-snapshot.ts` — the command (`promptSnapshotCommand(args, cwd)`): load, iterate templates, render, write-or-check. Console I/O + exit code, mirroring `src/commands/verify.ts`.
- **Modify** `src/index.ts` — register the `prompt-snapshot` case in `run()` and add it to `HELP_TEXT`.
- **Create** `test/unit/args-prompt-snapshot.test.ts` — arg-parsing unit tests.
- **Create** `test/unit/snapshot.test.ts` — `snapshotPaths` + `unifiedDiff` unit tests.
- **Create** `test/integration/prompt-snapshot.test.ts` — end-to-end command tests (scaffold temp project, run via `run()`, assert exit codes + files + console).

Run all CLI tests from `server/typescript/`: `bun test packages/cli`.

---

## Task 1: Argument parsing

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts`
- Test: `server/typescript/packages/cli/test/unit/args-prompt-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/cli/test/unit/args-prompt-snapshot.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { parsePromptSnapshotArgs } from "../../src/lib/args.js";

describe("parsePromptSnapshotArgs", () => {
  test("defaults: check false, prompts undefined", () => {
    expect(parsePromptSnapshotArgs([])).toEqual({ check: false, prompts: undefined });
  });
  test("--check sets check true", () => {
    expect(parsePromptSnapshotArgs(["--check"])).toEqual({ check: true, prompts: undefined });
  });
  test("--prompts <dir> is captured", () => {
    expect(parsePromptSnapshotArgs(["--prompts", "templates"])).toEqual({
      check: false,
      prompts: "templates",
    });
  });
  test("throws on an unknown flag", () => {
    expect(() => parsePromptSnapshotArgs(["--bogus"])).toThrow();
  });
  test("throws on a positional argument", () => {
    expect(() => parsePromptSnapshotArgs(["extra"])).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript && bun test packages/cli/test/unit/args-prompt-snapshot.test.ts`
Expected: FAIL — `parsePromptSnapshotArgs` is not exported from `args.js`.

- [ ] **Step 3: Implement `parsePromptSnapshotArgs`**

Append to `server/typescript/packages/cli/src/lib/args.ts` (after the `verify flags` block, before the `migrate flags` block):

```ts
// ---------------------------------------------------------------------------
// prompt-snapshot flags
// ---------------------------------------------------------------------------

export interface PromptSnapshotFlags {
  /** Compare against committed snapshots and fail on drift; never write. */
  check: boolean;
  /** Directory (relative to cwd) holding provider-resolved template text. */
  prompts: string | undefined;
}

export function parsePromptSnapshotArgs(argv: string[]): PromptSnapshotFlags {
  const { values } = parseArgs({
    args: argv,
    options: {
      check: { type: "boolean", default: false },
      prompts: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  return {
    check: !!values.check,
    prompts: values.prompts,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript && bun test packages/cli/test/unit/args-prompt-snapshot.test.ts`
Expected: PASS (5 pass).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/lib/args.ts server/typescript/packages/cli/test/unit/args-prompt-snapshot.test.ts
git commit -m "feat(cli): parsePromptSnapshotArgs for meta prompt-snapshot [FR-004]"
```

---

## Task 2: Snapshot path + diff helpers

**Files:**
- Create: `server/typescript/packages/cli/src/lib/snapshot.ts`
- Test: `server/typescript/packages/cli/test/unit/snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/cli/test/unit/snapshot.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { join } from "node:path";
import { snapshotPaths, unifiedDiff } from "../../src/lib/snapshot.js";

describe("snapshotPaths", () => {
  test("resolves the per-template dir + payload + golden under .metaobjects/snapshots", () => {
    const p = snapshotPaths("/proj", "Greeting");
    expect(p.dir).toBe(join("/proj", ".metaobjects", "snapshots", "Greeting"));
    expect(p.payloadPath).toBe(join("/proj", ".metaobjects", "snapshots", "Greeting", "payload.json"));
    expect(p.snapPath).toBe(join("/proj", ".metaobjects", "snapshots", "Greeting", "output.snap"));
  });
});

describe("unifiedDiff", () => {
  test("identical strings produce no -/+ lines", () => {
    const d = unifiedDiff("a\nb\nc", "a\nb\nc");
    expect(d).not.toContain("\n- ");
    expect(d).not.toContain("\n+ ");
  });
  test("shows the differing region with - (expected) then + (actual)", () => {
    const d = unifiedDiff("a\nOLD\nc", "a\nNEW\nc");
    expect(d).toContain("- OLD");
    expect(d).toContain("+ NEW");
    // common leading/trailing lines are trimmed from the diff body
    expect(d).not.toContain("- a");
    expect(d).not.toContain("+ c");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript && bun test packages/cli/test/unit/snapshot.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/snapshot.js`.

- [ ] **Step 3: Implement the helpers**

Create `server/typescript/packages/cli/src/lib/snapshot.ts`:

```ts
// Path + diff helpers for `meta prompt-snapshot`. Pure (no I/O, no metadata) so
// they unit-test trivially; the command does the filesystem work.

import { join } from "node:path";

export interface SnapshotPaths {
  /** The per-template snapshot directory: <cwd>/.metaobjects/snapshots/<name>. */
  dir: string;
  /** The committed fixture payload (author-owned input). */
  payloadPath: string;
  /** The golden rendered output (tool-managed, byte-exact). */
  snapPath: string;
}

export function snapshotPaths(cwd: string, templateName: string): SnapshotPaths {
  const dir = join(cwd, ".metaobjects", "snapshots", templateName);
  return {
    dir,
    payloadPath: join(dir, "payload.json"),
    snapPath: join(dir, "output.snap"),
  };
}

// A compact line diff: trim the common leading/trailing lines, then show the
// differing middle as `- <expected>` followed by `+ <actual>`. Enough to make
// drift reviewable in CI output without pulling in a diff dependency.
export function unifiedDiff(expected: string, actual: string): string {
  const e = expected.split("\n");
  const a = actual.split("\n");

  let pre = 0;
  while (pre < e.length && pre < a.length && e[pre] === a[pre]) pre++;

  let suf = 0;
  while (
    suf < e.length - pre &&
    suf < a.length - pre &&
    e[e.length - 1 - suf] === a[a.length - 1 - suf]
  ) {
    suf++;
  }

  const eMid = e.slice(pre, e.length - suf);
  const aMid = a.slice(pre, a.length - suf);

  const out: string[] = [`@@ line ${pre + 1} @@`];
  for (const line of eMid) out.push(`- ${line}`);
  for (const line of aMid) out.push(`+ ${line}`);
  return out.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript && bun test packages/cli/test/unit/snapshot.test.ts`
Expected: PASS (3 pass).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/lib/snapshot.ts server/typescript/packages/cli/test/unit/snapshot.test.ts
git commit -m "feat(cli): snapshot path + diff helpers [FR-004]"
```

---

## Task 3: prompt-snapshot command — write mode + dispatcher

**Files:**
- Create: `server/typescript/packages/cli/src/commands/prompt-snapshot.ts`
- Modify: `server/typescript/packages/cli/src/index.ts` (register command + help)
- Test: `server/typescript/packages/cli/test/integration/prompt-snapshot.test.ts`

- [ ] **Step 1: Write the failing integration tests (write mode)**

Create `server/typescript/packages/cli/test/integration/prompt-snapshot.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../../src/index.js";

// A view-object payload (Brief) + two prompts. `greeting` includes a shared
// partial (the load-bearing case: editing the partial drifts the rendered
// prompt while greeting.mustache itself is unchanged).
const META = {
  "metadata.root": {
    package: "acme::ai",
    children: [
      { "object.value": { name: "Brief", children: [{ "field.string": { name: "name" } }] } },
      {
        "template.prompt": {
          name: "greeting",
          "@payloadRef": "Brief",
          "@textRef": "prompt/greeting",
          "@format": "text",
        },
      },
      {
        "template.prompt": {
          name: "farewell",
          "@payloadRef": "Brief",
          "@textRef": "prompt/farewell",
          "@format": "text",
        },
      },
    ],
  },
};

function scaffold(): string {
  const tmp = mkdtempSync(join(tmpdir(), "meta-snap-"));
  mkdirSync(join(tmp, "metaobjects"), { recursive: true });
  writeFileSync(join(tmp, "metaobjects", "meta.ai.json"), JSON.stringify(META), "utf8");
  mkdirSync(join(tmp, "prompts", "shared"), { recursive: true });
  mkdirSync(join(tmp, "prompts", "prompt"), { recursive: true });
  writeFileSync(join(tmp, "prompts", "shared", "preamble.mustache"), "You are a helpful guide.\n", "utf8");
  writeFileSync(join(tmp, "prompts", "prompt", "greeting.mustache"), "{{> shared/preamble}}Hi {{name}}.", "utf8");
  writeFileSync(join(tmp, "prompts", "prompt", "farewell.mustache"), "Bye {{name}}.", "utf8");
  return tmp;
}

function writePayload(tmp: string, templateName: string, payload: unknown): void {
  const dir = join(tmp, ".metaobjects", "snapshots", templateName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "payload.json"), JSON.stringify(payload), "utf8");
}

const snapPath = (tmp: string, name: string) =>
  join(tmp, ".metaobjects", "snapshots", name, "output.snap");

let out: string[];
let err: string[];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
});
afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe("meta prompt-snapshot (write mode)", () => {
  test("writes output.snap for a template that has a payload", async () => {
    const tmp = scaffold();
    writePayload(tmp, "greeting", { name: "Ada" });
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(0);
      expect(existsSync(snapPath(tmp, "greeting"))).toBe(true);
      expect(readFileSync(snapPath(tmp, "greeting"), "utf8")).toBe("You are a helpful guide.\nHi Ada.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("skips a template that has no payload (no golden written)", async () => {
    const tmp = scaffold();
    writePayload(tmp, "greeting", { name: "Ada" }); // farewell intentionally has none
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(0);
      expect(existsSync(snapPath(tmp, "farewell"))).toBe(false);
      expect([...out, ...err].join("\n")).toContain("farewell");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 2 when metaobjects/ is missing", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "meta-snap-none-"));
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 1 when a template's @textRef does not resolve", async () => {
    const tmp = scaffold();
    writePayload(tmp, "farewell", { name: "Ada" }); // not skipped — it has a payload
    rmSync(join(tmp, "prompts", "prompt", "farewell.mustache"), { force: true }); // @textRef now unresolvable
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(1);
      expect([...out, ...err].join("\n")).toContain("farewell");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/typescript && bun test packages/cli/test/integration/prompt-snapshot.test.ts`
Expected: FAIL — `prompt-snapshot` is an unknown command (`run` returns 2 and prints help), so the write-mode tests fail (no file written / wrong exit code).

- [ ] **Step 3: Implement the command (write mode)**

Create `server/typescript/packages/cli/src/commands/prompt-snapshot.ts`:

```ts
// `meta prompt-snapshot` — deterministic rendered-prompt goldens (FR-004 #4).
//
// For each template.* node with a committed fixture payload, render its @textRef
// text against that payload (same engine, provider, and @format escaping prod
// uses) and snapshot the byte-exact output under .metaobjects/snapshots/<name>/.
// Write mode (default) overwrites output.snap; --check (a later task) diffs and
// fails on drift. Closes the gap the template's own git history misses: a shared
// partial or payload-shape change that silently alters the rendered prompt.

import { join } from "node:path";
import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parsePromptSnapshotArgs } from "../lib/args.js";
import { log } from "../lib/log.js";
import { FileProvider } from "../lib/file-provider.js";
import { snapshotPaths } from "../lib/snapshot.js";
import { loadMemory } from "@metaobjectsdev/sdk";
import { TYPE_TEMPLATE, TEMPLATE_ATTR_TEXT_REF, TEMPLATE_ATTR_FORMAT } from "@metaobjectsdev/metadata";
import { render, type RenderFormat } from "@metaobjectsdev/render";

const DEFAULT_PROMPTS_DIR = "prompts";

export async function promptSnapshotCommand(args: string[], cwd: string): Promise<number> {
  let flags;
  try {
    flags = parsePromptSnapshotArgs(args);
  } catch (err) {
    log.error((err as Error).message);
    return 2;
  }

  let root;
  try {
    root = await loadMemory(cwd);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("ENOENT") || msg.includes("no such") || msg.includes("cannot read")) {
      log.error(`no metaobjects/ found in ${cwd}; run 'meta init' to scaffold`);
      return 2;
    }
    log.error(`failed to load metadata: ${msg}`);
    return 1;
  }

  const promptsDir = join(cwd, flags.prompts ?? DEFAULT_PROMPTS_DIR);
  const provider = new FileProvider(promptsDir);

  const templates = root.ownChildren().filter((c) => c.type === TYPE_TEMPLATE);
  if (templates.length === 0) {
    log.info("meta prompt-snapshot — no template.* nodes found; nothing to snapshot.");
    return 0;
  }

  let errorCount = 0;
  let wrote = 0;
  let skipped = 0;

  for (const tmpl of templates) {
    const textRef = tmpl.ownAttr(TEMPLATE_ATTR_TEXT_REF);
    // Absent/typeless required attrs are a loader-schema concern, not ours.
    if (typeof textRef !== "string") continue;

    const { dir, payloadPath, snapPath } = snapshotPaths(cwd, tmpl.name);
    if (!existsSync(payloadPath)) {
      log.info(`[${tmpl.name}] skipped — no payload at ${payloadPath}`);
      skipped++;
      continue;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    } catch (err) {
      log.error(`[${tmpl.name}] invalid payload.json: ${(err as Error).message}`);
      errorCount++;
      continue;
    }

    const fmtAttr = tmpl.ownAttr(TEMPLATE_ATTR_FORMAT);
    const format = typeof fmtAttr === "string" ? (fmtAttr as RenderFormat) : undefined;

    let rendered: string;
    try {
      rendered = render({ ref: textRef, payload, provider, ...(format ? { format } : {}) });
    } catch (err) {
      log.error(`[${tmpl.name}] render failed: ${(err as Error).message}`);
      errorCount++;
      continue;
    }

    mkdirSync(dir, { recursive: true });
    writeFileSync(snapPath, rendered, "utf8");
    log.info(`[${tmpl.name}] wrote ${snapPath}`);
    wrote++;
  }

  if (errorCount > 0) {
    log.error(`meta prompt-snapshot — ${errorCount} error(s); ${wrote} snapshot(s) written.`);
    return 1;
  }
  log.info(
    `meta prompt-snapshot — ${wrote} snapshot(s) written${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
  );
  return 0;
}
```

- [ ] **Step 4: Register the command in the dispatcher**

In `server/typescript/packages/cli/src/index.ts`, add a case to the `switch (cmd)` in `run()`, immediately after the `verify` case (around line 131):

```ts
    case "prompt-snapshot": {
      const { promptSnapshotCommand } = await import("./commands/prompt-snapshot.js");
      return promptSnapshotCommand(rest, cwd);
    }
```

- [ ] **Step 5: Add the command to HELP_TEXT**

In the same file, in the `COMMANDS:` block of `HELP_TEXT`, add a line after the `verify` line:

```
  prompt-snapshot       Snapshot rendered template.* output; --check gates drift
```

And after the `VERIFY FLAGS:` block, add:

```
PROMPT-SNAPSHOT FLAGS:
  --check               Compare against committed snapshots; exit 1 on drift (CI gate)
  --prompts <dir>       Directory of provider-resolved template text (default: prompts)
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd server/typescript && bun test packages/cli/test/integration/prompt-snapshot.test.ts`
Expected: PASS (4 pass — write creates the golden, skip leaves no farewell golden, missing metaobjects → exit 2, unresolved @textRef → exit 1).

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/cli/src/commands/prompt-snapshot.ts server/typescript/packages/cli/src/index.ts server/typescript/packages/cli/test/integration/prompt-snapshot.test.ts
git commit -m "feat(cli): meta prompt-snapshot write mode + dispatcher [FR-004]"
```

---

## Task 4: prompt-snapshot command — `--check` mode

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/prompt-snapshot.ts`
- Test: `server/typescript/packages/cli/test/integration/prompt-snapshot.test.ts` (add a describe block)

- [ ] **Step 1: Write the failing tests (check mode)**

Append this `describe` block to `server/typescript/packages/cli/test/integration/prompt-snapshot.test.ts` (the `scaffold`/`writePayload`/`snapPath`/console-capture helpers above are reused):

```ts
describe("meta prompt-snapshot --check", () => {
  test("passes clean immediately after a write", async () => {
    const tmp = scaffold();
    writePayload(tmp, "greeting", { name: "Ada" });
    try {
      expect(await run(["prompt-snapshot", "--cwd", tmp])).toBe(0); // write golden
      expect(await run(["prompt-snapshot", "--check", "--cwd", tmp])).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 1 + reports drift when a shared partial changed", async () => {
    const tmp = scaffold();
    writePayload(tmp, "greeting", { name: "Ada" });
    try {
      await run(["prompt-snapshot", "--cwd", tmp]); // write golden
      // Edit the shared partial — greeting.mustache itself is untouched, yet the
      // rendered prompt changes. This is the case the template's git history misses.
      writeFileSync(join(tmp, "prompts", "shared", "preamble.mustache"), "You are a WISE guide.\n", "utf8");
      expect(await run(["prompt-snapshot", "--check", "--cwd", tmp])).toBe(1);
      const all = [...out, ...err].join("\n");
      expect(all).toContain("greeting");
      expect(all).toMatch(/drift/i);
      // --check must NOT rewrite the golden.
      expect(readFileSync(snapPath(tmp, "greeting"), "utf8")).toBe("You are a helpful guide.\nHi Ada.");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("exit 1 when a payload exists but no golden is committed", async () => {
    const tmp = scaffold();
    writePayload(tmp, "greeting", { name: "Ada" }); // payload but no output.snap written
    try {
      expect(await run(["prompt-snapshot", "--check", "--cwd", tmp])).toBe(1);
      expect([...out, ...err].join("\n")).toContain("greeting");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server/typescript && bun test packages/cli/test/integration/prompt-snapshot.test.ts`
Expected: the two new "exit 1" tests FAIL — the command ignores `flags.check`, so it writes (rewriting the golden) and returns 0 instead of 1. (The "passes clean" test may pass already since write also returns 0.)

- [ ] **Step 3: Add the `--check` branch**

In `server/typescript/packages/cli/src/commands/prompt-snapshot.ts`:

First, add the diff import — change the `snapshot.js` import line to:

```ts
import { snapshotPaths, unifiedDiff } from "../lib/snapshot.js";
```

Add a `driftCount` and `checked` counter next to the existing counters:

```ts
  let errorCount = 0;
  let driftCount = 0;
  let wrote = 0;
  let checked = 0;
  let skipped = 0;
```

Replace the per-template write block (from `mkdirSync(dir, { recursive: true });` through `wrote++;`) with this write-or-check block:

```ts
    if (flags.check) {
      checked++;
      if (!existsSync(snapPath)) {
        log.error(
          `[${tmpl.name}] no committed snapshot at ${snapPath}; run 'meta prompt-snapshot' to create it`,
        );
        driftCount++;
        continue;
      }
      const golden = readFileSync(snapPath, "utf8");
      if (golden !== rendered) {
        log.error(`[${tmpl.name}] snapshot drift:\n${unifiedDiff(golden, rendered)}`);
        log.error(`[${tmpl.name}] run 'meta prompt-snapshot' to accept the change`);
        driftCount++;
      }
    } else {
      mkdirSync(dir, { recursive: true });
      writeFileSync(snapPath, rendered, "utf8");
      log.info(`[${tmpl.name}] wrote ${snapPath}`);
      wrote++;
    }
```

Replace the final summary/return block (from `if (errorCount > 0) {` to the end of the function) with:

```ts
  if (flags.check) {
    if (errorCount > 0 || driftCount > 0) {
      log.error(
        `meta prompt-snapshot --check — ${driftCount} drifted, ${errorCount} error(s) across ${checked} checked.`,
      );
      return 1;
    }
    log.info(
      `meta prompt-snapshot --check — ${checked} snapshot(s) clean${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
    );
    return 0;
  }

  if (errorCount > 0) {
    log.error(`meta prompt-snapshot — ${errorCount} error(s); ${wrote} snapshot(s) written.`);
    return 1;
  }
  log.info(
    `meta prompt-snapshot — ${wrote} snapshot(s) written${skipped > 0 ? `, ${skipped} skipped` : ""}.`,
  );
  return 0;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/typescript && bun test packages/cli/test/integration/prompt-snapshot.test.ts`
Expected: PASS (7 pass — the 4 write-mode + 3 check-mode tests).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/commands/prompt-snapshot.ts server/typescript/packages/cli/test/integration/prompt-snapshot.test.ts
git commit -m "feat(cli): meta prompt-snapshot --check drift gate [FR-004]"
```

---

## Task 5: Full-suite verification + typecheck

**Files:** none (verification only)

- [ ] **Step 1: Run the full CLI package test suite**

Run: `cd server/typescript && bun test packages/cli`
Expected: PASS — all CLI tests green (existing + the new unit + integration tests).

- [ ] **Step 2: Run the full server suite (no regressions)**

Run: `cd server/typescript && bun test`
Expected: PASS — 2275+ tests, 0 fail.

- [ ] **Step 3: Typecheck the CLI package**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/cli' build && bun run --filter '@metaobjectsdev/cli' typecheck`
Expected: `@metaobjectsdev/cli typecheck: Exited with code 0` (build first so workspace dep `.d.ts` are present).

- [ ] **Step 4: Commit (if anything was adjusted)**

```bash
git add -A
git commit -m "chore(cli): prompt-snapshot full-suite + typecheck green [FR-004]" || echo "nothing to commit"
```

---

## Notes for the implementer

- **No `any`.** `@format` is read as `unknown`; narrow with `typeof fmtAttr === "string"` then cast to `RenderFormat` (the loader already validated it against the closed format set). `payload` is `unknown` and passed straight to `render()` (whose `payload` param is `unknown`).
- **`exactOptionalPropertyTypes`.** Pass `format` to `render()` via a conditional spread (`...(format ? { format } : {})`), never `format: undefined` — mirrors `verify.ts`'s provider/requiredSlots spreads.
- **Byte-exact goldens.** Write the rendered string verbatim (no trailing-newline normalization, no header); `--check` compares with strict `!==`. The tool owns `output.snap`; humans never hand-edit it.
- **`maxChars` is not applied** in snapshotting — it's a runtime budget concern, out of scope here.
- **Out of scope this slice:** the C# port (identical command over the identical layout — a later slice), Python/Java (no `render()`), a `snapshotPrompt()` helper, multiple payload cases per template.
- **After all tasks:** run a code review + code-simplifier on the diff and fix findings, then merge forward onto the current `origin/main` tip via merge (never rebase/reset/force main), push, and remove the worktree — per this repo's discipline.
