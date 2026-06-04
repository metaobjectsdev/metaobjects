# Agent-Context P1 — `meta init` scaffolding + re-init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the TypeScript `meta init` CLI to scaffold the agent-context (the slim always-on `.metaobjects/AGENTS.md`/`CLAUDE.md` + the five `metaobjects-*` Claude skills with only the project's language reference fragments) by calling the P0 assembler, with stack detection + `--server`/`--client` overrides + `--no-skills`, and **re-init/refresh** that preserves hand-edits — replacing the stale single `AGENT_DOCS_BODY` blob.

**Architecture:** A sidecar manifest (`.metaobjects/.agent-context.json`) records the sha256 of each scaffolded file. On (re-)init the CLI resolves the project's stack, calls the P0 `assemble()`, and for each file: writes it if new, overwrites if the on-disk hash still matches the manifest (unmodified), or writes a `.new` sidecar + warns if hand-edited. The manifest mechanism (vs the old in-file `<!-- hash -->` comment) is required because Claude `SKILL.md` files must start with `---` frontmatter. Content-root resolution walks up from the module to the monorepo's `agent-context/` (dev); a build step bundles a copy into the published package so a released CLI self-carries it.

**Tech Stack:** TypeScript (ESM), Bun test runner, `@metaobjectsdev/sdk` (the P0 `assemble`/`makeStack`/`detectStack`), `@metaobjectsdev/cli` (`meta init`). No new runtime deps.

---

## Scope note

This is **P1** of `docs/superpowers/specs/2026-06-02-downstream-agent-context-design.md`. **In scope:** content-root resolution, the manifest-based scaffold/re-init engine (in `sdk`), and the `meta init` wiring (detection, `--server`/`--client`/`--no-skills`, refresh, opt-in root wiring, replacing the stale body), with a publish-bundling step. **Out of scope (later):** per-port emit commands for JVM/Python/C# (P2), the website `llms.txt` (P3), the plugin (P4), and authoring the remaining `csharp`/`python`/`angular` fragments (content plan; `kotlin` already landed). Depends on P0 (`@metaobjectsdev/sdk/agent-context` `assemble`/`makeStack`/`detectStack`/`Stack`/`AssembledFile`).

## File Structure

**sdk (`server/typescript/packages/sdk/`):**
- `src/agent-context/content-root.ts` — `resolveAgentContextRoot()` (locate the `agent-context/` content tree).
- `src/agent-context/scaffold.ts` — `hashContents`, the `Manifest` type, `AGENT_CONTEXT_MANIFEST_PATH`, and the pure `planScaffold()` (decide writes vs hand-edit conflicts vs new manifest).
- `src/agent-context/index.ts` — re-export the two new modules.
- `package.json` build script — bundle the content into the package (publish path).

**cli (`server/typescript/packages/cli/`):**
- `src/lib/args.ts` — add `--server` (repeatable), `--client` (repeatable), `--no-skills`, `--wire-root` to `parseInitArgs`/`InitFlags`.
- `src/commands/init.ts` — add `detectProjectStack()`, replace `writeAgentDocs` with `writeAgentContext`, thread the new options, write/read the manifest, optional root-wiring; drop the `AGENT_DOCS_BODY` import.
- `src/index.ts` — pass the new flags from `parseInitArgs` into `init()`.

**Tests:**
- `sdk/test/agent-context/content-root.test.ts`, `sdk/test/agent-context/scaffold.test.ts`
- `cli/test/unit/init-agent-context.test.ts`

---

### Task 1: Content-root resolver (sdk)

**Files:**
- Create: `server/typescript/packages/sdk/src/agent-context/content-root.ts`
- Modify: `server/typescript/packages/sdk/src/agent-context/index.ts`
- Test: `server/typescript/packages/sdk/test/agent-context/content-root.test.ts`

- [ ] **Step 1: Write the failing test** (the test resolves the real monorepo `agent-context/`)

```ts
// test/agent-context/content-root.test.ts
import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentContextRoot } from "../../src/agent-context/content-root.js";

describe("resolveAgentContextRoot", () => {
  test("locates the monorepo agent-context/ content tree", () => {
    const root = resolveAgentContextRoot();
    expect(existsSync(join(root, "skills", "metaobjects-authoring", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, "templates", "always-on.md.mustache"))).toBe(true);
  });
  test("a provided override that exists is returned as-is", () => {
    const root = resolveAgentContextRoot();
    expect(resolveAgentContextRoot(root)).toBe(root);
  });
  test("a non-existent override throws a clear error", () => {
    expect(() => resolveAgentContextRoot("/no/such/agent-context")).toThrow(/agent-context content not found/i);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server/typescript/packages/sdk && bun test test/agent-context/content-root.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/agent-context/content-root.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A directory is a valid content root iff it holds the authoring skill body. */
function isContentRoot(dir: string): boolean {
  return existsSync(join(dir, "skills", "metaobjects-authoring", "SKILL.md"));
}

/**
 * Resolve the `agent-context/` content tree the assembler reads.
 * - If `override` is given, it must be a valid content root (else throw).
 * - Otherwise: check a bundled copy beside this module (`<pkg>/agent-context`,
 *   the published path), then walk up looking for a monorepo `agent-context/` (dev).
 */
export function resolveAgentContextRoot(override?: string): string {
  if (override !== undefined) {
    if (isContentRoot(override)) return override;
    throw new Error(`agent-context content not found at override: ${override}`);
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    // bundled copy shipped inside the package
    const bundled = join(dir, "agent-context");
    if (isContentRoot(bundled)) return bundled;
    // monorepo content tree (dev / workspace)
    const mono = join(dir, "agent-context");
    if (isContentRoot(mono)) return mono;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "agent-context content not found — looked for a bundled `agent-context/` beside the package " +
      "and a monorepo `agent-context/` walking up from the sdk module.",
  );
}
```

Append to `src/agent-context/index.ts`:

```ts
export * from "./content-root.js";
```

- [ ] **Step 4: Run + typecheck** — `cd server/typescript/packages/sdk && bun test test/agent-context/content-root.test.ts && bun run typecheck` — PASS, typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/agent-context/content-root.ts \
        server/typescript/packages/sdk/src/agent-context/index.ts \
        server/typescript/packages/sdk/test/agent-context/content-root.test.ts
git commit -m "feat(agent-context): resolveAgentContextRoot (bundled-then-monorepo content lookup)"
```

---

### Task 2: Manifest + planScaffold (sdk)

**Files:**
- Create: `server/typescript/packages/sdk/src/agent-context/scaffold.ts`
- Modify: `server/typescript/packages/sdk/src/agent-context/index.ts`
- Test: `server/typescript/packages/sdk/test/agent-context/scaffold.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-context/scaffold.test.ts
import { test, expect, describe } from "bun:test";
import { hashContents, planScaffold, AGENT_CONTEXT_MANIFEST_PATH, type Manifest } from "../../src/agent-context/scaffold.js";
import { makeStack } from "../../src/agent-context/resolve.js";
import type { AssembledFile } from "../../src/agent-context/types.js";

const stack = makeStack(["typescript"], ["react"]);
const files: AssembledFile[] = [
  { path: ".metaobjects/AGENTS.md", contents: "always-on v2" },
  { path: ".claude/skills/metaobjects-codegen/SKILL.md", contents: "---\nname: x\n---\nbody v2" },
];

describe("planScaffold", () => {
  test("manifest path is the dotfile under .metaobjects", () => {
    expect(AGENT_CONTEXT_MANIFEST_PATH).toBe(".metaobjects/.agent-context.json");
  });

  test("all-new project: every file is a write; manifest records hashes; no conflicts", () => {
    const d = planScaffold({ stack, assembled: files, prior: undefined, readCurrent: () => undefined });
    expect(d.writes.map((w) => w.path).sort()).toEqual(files.map((f) => f.path).sort());
    expect(d.conflicts).toEqual([]);
    expect(d.manifest.files[".metaobjects/AGENTS.md"]).toBe(hashContents("always-on v2"));
    expect(d.manifest.servers).toEqual(["typescript"]);
    expect(d.manifest.clients).toEqual(["react"]);
  });

  test("unmodified file (on-disk hash matches prior manifest) → overwrite, not conflict", () => {
    const prior: Manifest = { version: 1, servers: ["typescript"], clients: ["react"], files: { ".metaobjects/AGENTS.md": hashContents("always-on v1") } };
    const d = planScaffold({
      stack, assembled: [files[0]!], prior,
      readCurrent: (p) => (p === ".metaobjects/AGENTS.md" ? "always-on v1" : undefined),
    });
    expect(d.writes.map((w) => w.path)).toEqual([".metaobjects/AGENTS.md"]);
    expect(d.conflicts).toEqual([]);
  });

  test("hand-edited file (on-disk differs from prior hash) → .new conflict + keep original", () => {
    const prior: Manifest = { version: 1, servers: ["typescript"], clients: ["react"], files: { ".metaobjects/AGENTS.md": hashContents("always-on v1") } };
    const d = planScaffold({
      stack, assembled: [files[0]!], prior,
      readCurrent: () => "I HAND EDITED THIS",
    });
    expect(d.writes).toEqual([]);
    expect(d.conflicts).toEqual([{ path: ".metaobjects/AGENTS.md", newPath: ".metaobjects/AGENTS.md.new", contents: "always-on v2" }]);
  });

  test("file present but no prior manifest record → treat as hand-edited (.new), never clobber", () => {
    const d = planScaffold({ stack, assembled: [files[0]!], prior: undefined, readCurrent: () => "pre-existing unknown" });
    expect(d.conflicts.map((c) => c.path)).toEqual([".metaobjects/AGENTS.md"]);
  });

  test("a file in the prior manifest no longer assembled (stack shrank) is reported as removed", () => {
    const prior: Manifest = { version: 1, servers: ["typescript", "java"], clients: ["react"], files: { ".claude/skills/metaobjects-codegen/references/java.md": "abc" } };
    const d = planScaffold({ stack, assembled: files, prior, readCurrent: () => undefined });
    expect(d.removed).toEqual([".claude/skills/metaobjects-codegen/references/java.md"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server/typescript/packages/sdk && bun test test/agent-context/scaffold.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/agent-context/scaffold.ts
import { createHash } from "node:crypto";
import type { AssembledFile, Stack } from "./types.js";

/** Consumer-relative path of the sidecar manifest that tracks scaffolded files. */
export const AGENT_CONTEXT_MANIFEST_PATH = ".metaobjects/.agent-context.json";

export interface Manifest {
  version: 1;
  servers: string[];
  clients: string[];
  /** consumer-relative path → sha256 of the contents as last scaffolded. */
  files: Record<string, string>;
}

export function hashContents(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface ScaffoldDecision {
  /** files to (over)write at their own path: new, or unmodified-since-last-scaffold. */
  writes: { path: string; contents: string }[];
  /** hand-edited files: write the fresh contents to `<path>.new`, leave the original. */
  conflicts: { path: string; newPath: string; contents: string }[];
  /** the manifest to persist after writing. */
  manifest: Manifest;
  /** paths the prior manifest tracked that are no longer assembled (e.g. stack shrank) — reported, never auto-deleted. */
  removed: string[];
}

/**
 * Decide what to write for a (re-)scaffold. Pure: filesystem access is via the
 * `readCurrent` callback (returns the on-disk contents, or undefined if absent).
 * A file is safe to overwrite iff it is absent, or its on-disk hash still equals
 * the hash the prior manifest recorded (i.e. the user hasn't hand-edited it).
 */
export function planScaffold(opts: {
  stack: Stack;
  assembled: AssembledFile[];
  prior: Manifest | undefined;
  readCurrent: (path: string) => string | undefined;
}): ScaffoldDecision {
  const { stack, assembled, prior, readCurrent } = opts;
  const writes: ScaffoldDecision["writes"] = [];
  const conflicts: ScaffoldDecision["conflicts"] = [];
  const files: Record<string, string> = {};

  for (const f of assembled) {
    files[f.path] = hashContents(f.contents);
    const current = readCurrent(f.path);
    if (current === undefined) {
      writes.push({ path: f.path, contents: f.contents });
      continue;
    }
    const priorHash = prior?.files[f.path];
    if (priorHash !== undefined && hashContents(current) === priorHash) {
      writes.push({ path: f.path, contents: f.contents }); // unmodified → refresh to latest
    } else {
      conflicts.push({ path: f.path, newPath: `${f.path}.new`, contents: f.contents });
    }
  }

  const assembledPaths = new Set(assembled.map((f) => f.path));
  const removed = prior ? Object.keys(prior.files).filter((p) => !assembledPaths.has(p)) : [];

  return {
    writes,
    conflicts,
    manifest: { version: 1, servers: stack.servers, clients: stack.clients, files },
    removed,
  };
}
```

Append to `src/agent-context/index.ts`:

```ts
export * from "./scaffold.js";
```

- [ ] **Step 4: Run + typecheck** — `cd server/typescript/packages/sdk && bun test test/agent-context/scaffold.test.ts && bun run typecheck` — PASS, typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/agent-context/scaffold.ts \
        server/typescript/packages/sdk/src/agent-context/index.ts \
        server/typescript/packages/sdk/test/agent-context/scaffold.test.ts
git commit -m "feat(agent-context): manifest + planScaffold (hand-edit-preserving re-init engine)"
```

---

### Task 3: New init flags (cli args)

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/args.ts`
- Test: `server/typescript/packages/cli/test/unit/init-args-stack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/init-args-stack.test.ts
import { test, expect, describe } from "bun:test";
import { parseInitArgs } from "../../src/lib/args.js";

describe("parseInitArgs — stack flags", () => {
  test("repeatable --server / --client and --no-skills", () => {
    const f = parseInitArgs(["--server", "java", "--server", "kotlin", "--client", "react", "--client", "tanstack", "--no-skills"]);
    expect(f.servers).toEqual(["java", "kotlin"]);
    expect(f.clients).toEqual(["react", "tanstack"]);
    expect(f.noSkills).toBe(true);
    expect(f.wireRoot).toBe(false);
  });
  test("defaults: empty server/client overrides, skills on, no root wiring", () => {
    const f = parseInitArgs([]);
    expect(f.servers).toEqual([]);
    expect(f.clients).toEqual([]);
    expect(f.noSkills).toBe(false);
    expect(f.wireRoot).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server/typescript/packages/cli && bun test test/unit/init-args-stack.test.ts` — FAIL (`servers`/`noSkills` undefined).

- [ ] **Step 3: Implement** — in `src/lib/args.ts`, extend the `InitFlags` interface and `parseInitArgs`. Add to the `options` object passed to `parseArgs`:

```ts
      server: { type: "string", multiple: true },
      client: { type: "string", multiple: true },
      "no-skills": { type: "boolean", default: false },
      "wire-root": { type: "boolean", default: false },
```

Add to the `InitFlags` interface:

```ts
  servers: string[];
  clients: string[];
  noSkills: boolean;
  wireRoot: boolean;
```

Add to the returned object in `parseInitArgs`:

```ts
    servers: (values.server as string[] | undefined) ?? [],
    clients: (values.client as string[] | undefined) ?? [],
    noSkills: !!values["no-skills"],
    wireRoot: !!values["wire-root"],
```

- [ ] **Step 4: Run + typecheck** — `cd server/typescript/packages/cli && bun test test/unit/init-args-stack.test.ts && bun run typecheck` — PASS, typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/lib/args.ts \
        server/typescript/packages/cli/test/unit/init-args-stack.test.ts
git commit -m "feat(cli): init flags --server/--client (repeatable) + --no-skills + --wire-root"
```

---

### Task 4: Project stack detection (cli)

**Files:**
- Create: `server/typescript/packages/cli/src/lib/detect-stack.ts`
- Test: `server/typescript/packages/cli/test/unit/detect-stack.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/detect-stack.test.ts
import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStack } from "../../src/lib/detect-stack.js";

function tmp(): string { return mkdtempSync(join(tmpdir(), "detect-")); }

describe("resolveStack", () => {
  test("explicit --server/--client overrides win over detection", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@metaobjectsdev/react": "1" } }));
      const s = resolveStack(dir, { servers: ["java", "kotlin"], clients: ["tanstack"] });
      expect(s.servers).toEqual(["java", "kotlin"]);
      expect(s.clients).toEqual(["tanstack"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("detects a TS server + react/tanstack from package.json deps", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ dependencies: { "@metaobjectsdev/cli": "1", "@metaobjectsdev/react": "1", "@metaobjectsdev/tanstack": "1" } }));
      const s = resolveStack(dir, { servers: [], clients: [] });
      expect(s.servers).toEqual(["typescript"]);
      expect(s.clients.sort()).toEqual(["react", "tanstack"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test("detects a Java (Maven) server from pom.xml", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "pom.xml"), "<project/>");
      const s = resolveStack(dir, { servers: [], clients: [] });
      expect(s.servers).toEqual(["java"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server/typescript/packages/cli && bun test test/unit/detect-stack.test.ts` — FAIL (module missing).

- [ ] **Step 3: Implement**

```ts
// src/lib/detect-stack.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  detectStack, makeStack,
  type ServerLang, type ClientFramework, type Stack, type ProjectProbe,
  SERVER_LANGS, CLIENT_FRAMEWORKS,
} from "@metaobjectsdev/sdk/agent-context";

function depNames(cwd: string): Set<string> {
  const out = new Set<string>();
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, Record<string, string>>;
      for (const key of ["dependencies", "devDependencies", "peerDependencies"]) {
        for (const name of Object.keys(pkg[key] ?? {})) out.add(name);
      }
    } catch { /* unreadable manifest — treat as no deps */ }
  }
  return out;
}

function probe(cwd: string): ProjectProbe {
  const deps = depNames(cwd);
  const names = existsSync(cwd) ? readdirSync(cwd) : [];
  return {
    hasDep: (name) => deps.has(name),
    hasFileMatching: (re) => names.some((n) => re.test(n)),
  };
}

/** Resolve the stack: explicit --server/--client overrides take precedence; otherwise detect. */
export function resolveStack(cwd: string, overrides: { servers: string[]; clients: string[] }): Stack {
  const validServers = SERVER_LANGS as readonly string[];
  const validClients = CLIENT_FRAMEWORKS as readonly string[];
  const oServers = overrides.servers.filter((s): s is ServerLang => validServers.includes(s));
  const oClients = overrides.clients.filter((c): c is ClientFramework => validClients.includes(c));
  if (oServers.length > 0 || oClients.length > 0) return makeStack(oServers, oClients);
  const detected = detectStack(probe(cwd));
  return makeStack(detected.servers, detected.clients);
}
```

(Note: `ProjectProbe`, `SERVER_LANGS`, `CLIENT_FRAMEWORKS` are exported from `@metaobjectsdev/sdk/agent-context` via the P0 barrel — confirm with `grep -rn "export" server/typescript/packages/sdk/src/agent-context/index.ts`; if `ProjectProbe` isn't re-exported, add `export type { ProjectProbe } from "./resolve.js";` to that barrel in this task.)

- [ ] **Step 4: Run + typecheck** — `cd server/typescript/packages/cli && bun test test/unit/detect-stack.test.ts && bun run typecheck` — PASS, typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/lib/detect-stack.ts \
        server/typescript/packages/cli/test/unit/detect-stack.test.ts \
        server/typescript/packages/sdk/src/agent-context/index.ts
git commit -m "feat(cli): resolveStack — detect server/client from project, --server/--client override"
```

---

### Task 5: Wire `meta init` to scaffold the agent-context

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/init.ts`
- Test: `server/typescript/packages/cli/test/unit/init-agent-context.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// test/unit/init-agent-context.test.ts
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../../src/commands/init.js";

let cwd: string;
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "init-ac-")); });
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

const javaReact = { servers: ["java"], clients: ["react"] };

describe("init() — agent-context scaffolding", () => {
  test("scaffolds always-on + skills + only the stack's reference fragments + a manifest", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients });
    expect(existsSync(join(cwd, ".metaobjects/AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".metaobjects/CLAUDE.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"))).toBe(true);
    // java ref installed, typescript ref NOT (token-gated)
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/java.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/references/typescript.md"))).toBe(false);
    expect(existsSync(join(cwd, ".metaobjects/.agent-context.json"))).toBe(true);
    // the always-on names the stack
    expect(readFileSync(join(cwd, ".metaobjects/AGENTS.md"), "utf8").toLowerCase()).toContain("java");
  });

  test("--no-skills scaffolds the always-on but no skills", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, noSkills: true });
    expect(existsSync(join(cwd, ".metaobjects/AGENTS.md"))).toBe(true);
    expect(existsSync(join(cwd, ".claude/skills"))).toBe(false);
  });

  test("re-init (refreshDocs) over an unmodified scaffold is idempotent — no .new files", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients });
    const before = readFileSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"), "utf8");
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, refreshDocs: true });
    expect(readFileSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md"), "utf8")).toBe(before);
    expect(existsSync(join(cwd, ".claude/skills/metaobjects-codegen/SKILL.md.new"))).toBe(false);
  });

  test("re-init preserves a hand-edited file by writing .new, never clobbering", async () => {
    await init({ cwd, servers: javaReact.servers, clients: javaReact.clients });
    const p = join(cwd, ".metaobjects/AGENTS.md");
    writeFileSync(p, "MY HAND EDIT", "utf8");
    const r = await init({ cwd, servers: javaReact.servers, clients: javaReact.clients, refreshDocs: true });
    expect(readFileSync(p, "utf8")).toBe("MY HAND EDIT");           // original untouched
    expect(existsSync(`${p}.new`)).toBe(true);                       // fresh version offered alongside
    expect(r.warnings.some((w) => w.includes("AGENTS.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server/typescript/packages/cli && bun test test/unit/init-agent-context.test.ts` — FAIL (`init` doesn't accept `servers`/`noSkills`, doesn't scaffold skills).

- [ ] **Step 3: Implement** — in `src/commands/init.ts`:

(a) Replace the agent-docs import. **Remove** `import { AGENT_DOCS_BODY, withContentHash, isUnmodified } from "@metaobjectsdev/sdk/agent-docs";` and add:

```ts
import {
  assemble, resolveAgentContextRoot, planScaffold,
  AGENT_CONTEXT_MANIFEST_PATH, type Manifest,
} from "@metaobjectsdev/sdk/agent-context";
import { resolveStack } from "../lib/detect-stack.js";
```

(b) Extend `InitOptions`:

```ts
export interface InitOptions {
  cwd: string;
  force?: boolean;
  quiet?: boolean;
  printOnly?: boolean;
  refreshDocs?: boolean;
  d1?: boolean;
  servers?: string[];
  clients?: string[];
  noSkills?: boolean;
  wireRoot?: boolean;
}
```

(c) Replace the whole `writeAgentDocs` function (and the `AGENT_DOC_FILES` constant if now unused elsewhere — keep it if other code references it) with `writeAgentContext`:

```ts
async function readManifest(cwd: string): Promise<Manifest | undefined> {
  const p = join(cwd, AGENT_CONTEXT_MANIFEST_PATH);
  if (!(await fileExists(p))) return undefined;
  try { return JSON.parse(await readFile(p, "utf8")) as Manifest; } catch { return undefined; }
}

async function writeAgentContext(opts: InitOptions, result: InitResult): Promise<void> {
  const stack = resolveStack(opts.cwd, { servers: opts.servers ?? [], clients: opts.clients ?? [] });
  let assembled = assemble({ contentRoot: resolveAgentContextRoot(), stack });
  if (opts.noSkills) assembled = assembled.filter((f) => !f.path.startsWith(".claude/skills/"));

  const prior = await readManifest(opts.cwd);
  const decision = planScaffold({
    stack, assembled, prior,
    readCurrent: (rel) => {
      const abs = join(opts.cwd, rel);
      return existsSyncWrap(abs) ? readFileSyncWrap(abs) : undefined;
    },
  });

  for (const w of decision.writes) {
    const abs = join(opts.cwd, w.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, w.contents, "utf8");
    result.created.push(w.path);
  }
  for (const c of decision.conflicts) {
    const abs = join(opts.cwd, c.newPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, c.contents, "utf8");
    result.created.push(c.newPath);
    result.warnings.push(`${c.path} appears hand-edited; refreshed version written to ${c.newPath}`);
  }
  const manifestAbs = join(opts.cwd, AGENT_CONTEXT_MANIFEST_PATH);
  await mkdir(dirname(manifestAbs), { recursive: true });
  await writeFile(manifestAbs, JSON.stringify(decision.manifest, null, 2) + "\n", "utf8");

  if (opts.wireRoot) await wireRootMemory(opts.cwd, result);
}
```

Add the imports `dirname` (from `node:path`) and sync fs helpers near the top:

```ts
import { existsSync as existsSyncWrap, readFileSync as readFileSyncWrap } from "node:fs";
import { dirname } from "node:path";
```

(d) Add the opt-in root-wiring helper:

```ts
const ROOT_IMPORT_LINE = "@.metaobjects/AGENTS.md";
async function wireRootMemory(cwd: string, result: InitResult): Promise<void> {
  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const p = join(cwd, name);
    if (!(await fileExists(p))) continue;
    const body = await readFile(p, "utf8");
    if (body.includes(ROOT_IMPORT_LINE)) continue;
    await writeFile(p, `${body.replace(/\n*$/, "\n")}\n${ROOT_IMPORT_LINE}\n`, "utf8");
    result.created.push(`${name} (added @import)`);
  }
}
```

(e) In `init()`: replace the two `writeAgentDocs(agentDir, result)` call sites with `await writeAgentContext(opts, result);`. In the `printOnly` branch, replace the `for (const filename of AGENT_DOC_FILES) result.created.push(...)` lines with a representative listing:

```ts
    result.created.push(".metaobjects/AGENTS.md", ".metaobjects/CLAUDE.md", ".claude/skills/metaobjects-*", AGENT_CONTEXT_MANIFEST_PATH);
```

- [ ] **Step 4: Run + typecheck** — `cd server/typescript/packages/cli && bun test test/unit/init-agent-context.test.ts && bun run typecheck` — PASS, typecheck 0. (If the existing `test/unit/init-refresh-docs.test.ts` asserts the OLD single-blob behavior, update its expectations to the new files — the stale blob is intentionally replaced; do NOT weaken; adjust the assertions to the manifest/skills reality.)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/commands/init.ts \
        server/typescript/packages/cli/test/unit/init-agent-context.test.ts
git commit -m "feat(cli): meta init scaffolds agent-context (always-on + skills) via the assembler; manifest-tracked re-init; --no-skills/--wire-root"
```

---

### Task 6: Thread the flags through the CLI entry

**Files:**
- Modify: `server/typescript/packages/cli/src/index.ts` (the `init` command dispatch)
- Test: covered by `init-agent-context.test.ts` (unit) + a manual CLI check below.

- [ ] **Step 1: Find the init dispatch** — `grep -n "parseInitArgs\|init({" server/typescript/packages/cli/src/index.ts`. It calls `parseInitArgs(...)` then `init({ cwd, force, quiet, printOnly, refreshDocs, d1 })` (or similar).

- [ ] **Step 2: Pass the new flags** — update that `init({...})` call to forward the new fields:

```ts
    await init({
      cwd: process.cwd(),
      force: flags.force,
      quiet: flags.quiet,
      printOnly: flags.printOnly,
      refreshDocs: flags.refreshDocs,
      d1: flags.d1,
      servers: flags.servers,
      clients: flags.clients,
      noSkills: flags.noSkills,
      wireRoot: flags.wireRoot,
    });
```

(Match the existing variable name for the parsed flags — it may be `flags` or destructured; adapt to what's there, forwarding the four new fields.)

- [ ] **Step 3: Build + manual smoke** — `cd server/typescript/packages/cli && bun run build`, then in a temp dir: `mkdir -p /tmp/mo-smoke && cd /tmp/mo-smoke && node <repo>/server/typescript/packages/cli/dist/src/index.js init --server java --client react --no-skills --print-only` — expect the printed plan to list `.metaobjects/AGENTS.md` etc. Then without `--print-only` confirm files appear and `.metaobjects/.agent-context.json` exists. Clean up `/tmp/mo-smoke`.

- [ ] **Step 4: Run the cli suite + typecheck** — `cd server/typescript/packages/cli && bun test && bun run typecheck` — all PASS, typecheck 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/index.ts
git commit -m "feat(cli): forward --server/--client/--no-skills/--wire-root into init()"
```

---

### Task 7: Bundle the content into the published package

**Files:**
- Modify: `server/typescript/packages/sdk/package.json` (build + files)
- Create: `server/typescript/packages/sdk/scripts/bundle-agent-context.mjs`
- Test: `server/typescript/packages/sdk/test/agent-context/bundle.test.ts`

The dev resolver (Task 1) walks up to the monorepo `agent-context/`. A published package has no monorepo around it, so `resolveAgentContextRoot()` must also find a copy **inside** the package. This task copies `agent-context/` into the sdk package at build time and verifies the resolver finds it.

- [ ] **Step 1: Write the failing test**

```ts
// test/agent-context/bundle.test.ts
import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("bundled agent-context content", () => {
  test("the bundle script copies the content into the package", () => {
    // After `bun run bundle-agent-context`, a package-local copy exists.
    const pkgDir = join(import.meta.dir, "../..");
    expect(existsSync(join(pkgDir, "agent-context", "skills", "metaobjects-authoring", "SKILL.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `cd server/typescript/packages/sdk && bun test test/agent-context/bundle.test.ts` — FAIL (no package-local `agent-context/`).

- [ ] **Step 3: Implement the bundle script**

```js
// scripts/bundle-agent-context.mjs
import { cpSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// scripts/ → package root → walk up to the monorepo agent-context/
const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
let dir = pkgDir, src = "";
for (let i = 0; i < 8; i++) {
  const cand = join(dir, "agent-context", "skills", "metaobjects-authoring", "SKILL.md");
  if (existsSync(cand) && dir !== pkgDir) { src = join(dir, "agent-context"); break; }
  const parent = dirname(dir);
  if (parent === dir) break;
  dir = parent;
}
if (!src) { console.error("monorepo agent-context/ not found to bundle"); process.exit(1); }
const dest = join(pkgDir, "agent-context");
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log("bundled agent-context →", dest);
```

In `server/typescript/packages/sdk/package.json`:
- Add to `scripts`: `"bundle-agent-context": "node scripts/bundle-agent-context.mjs"`, and make `build` run it first: change `"build": "tsc -p ."` to `"build": "node scripts/bundle-agent-context.mjs && tsc -p ."`.
- Add `"agent-context"` and `"scripts"` to the `files` array so the bundled copy + script ship.
- Add `agent-context/` to the package's `.gitignore` (create `server/typescript/packages/sdk/.gitignore` with `agent-context/` if absent, or append) — the bundle is a build artifact, not committed (the source of truth is the monorepo root `agent-context/`).

- [ ] **Step 4: Run the bundle + test** — `cd server/typescript/packages/sdk && bun run bundle-agent-context && bun test test/agent-context/bundle.test.ts` — PASS. Confirm `git status` does NOT show `server/typescript/packages/sdk/agent-context/` as untracked (it's gitignored).

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/scripts/bundle-agent-context.mjs \
        server/typescript/packages/sdk/package.json \
        server/typescript/packages/sdk/.gitignore \
        server/typescript/packages/sdk/test/agent-context/bundle.test.ts
git commit -m "build(agent-context): bundle the content into the sdk package for published resolution"
```

---

### Task 8: Full green + drop the stale agent-docs body usage

**Files:**
- Modify: `server/typescript/packages/sdk/src/agent-docs/index.ts` (mark `AGENT_DOCS_BODY` deprecated) — only if nothing else imports it.

- [ ] **Step 1: Confirm the stale body is no longer used by init** — `grep -rn "AGENT_DOCS_BODY" server/typescript/packages` — expect the only references are in `sdk/src/agent-docs/{body.ts,index.ts}` (its definition/re-export). The `cli/src/commands/init.ts` reference must be gone.

- [ ] **Step 2: Deprecate (don't delete) the export** — `body.ts` is large and may be referenced by tests; add a JSDoc deprecation above the `AGENT_DOCS_BODY` export in `sdk/src/agent-docs/body.ts`:

```ts
/** @deprecated The single-blob agent doc is replaced by the assembled agent-context
 * (see `@metaobjectsdev/sdk/agent-context`). Kept only for back-compat; not scaffolded by `meta init`. */
```

- [ ] **Step 3: Run the whole sdk + cli suites + typechecks**

Run:
```
cd server/typescript/packages/sdk && bun test && bun run typecheck
cd server/typescript/packages/cli && bun test && bun run typecheck
```
Expected: all PASS, both typechecks exit 0. (If any pre-existing cli/sdk test asserted the old single-blob agent docs, update it to the new reality — the replacement is intentional per the spec; never weaken a test to hide a real regression.)

- [ ] **Step 4: Build both packages** — `cd server/typescript/packages/sdk && bun run build && cd ../cli && bun run build` — exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/agent-docs/body.ts
git commit -m "chore(agent-context): deprecate the single-blob AGENT_DOCS_BODY (replaced by assembled agent-context)"
```

---

## What this plan does NOT do (next)

- **P2:** per-port emit commands (Java/Kotlin `metaobjects:agent-docs` Maven goal, Python `metaobjects agent-docs`, C# `dotnet meta agent-docs`) so JVM-only/Python/C# shops scaffold without Node.
- **P3:** monorepo-generated `llms.txt`/`llms-full.txt` + the `metaobjects.dev` consumption.
- **Content:** the remaining `csharp`/`python`/`angular` reference fragments (kotlin already shipped).
- **Release:** publishing a CLI version that carries the bundled content so adopters self-scaffold via their installed `meta` (until then, run the monorepo's local CLI against a consumer project).
