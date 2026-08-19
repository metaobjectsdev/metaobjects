# Metadata Source Resolution — Phase 1 (TypeScript) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `sources` in `.metaobjects/config.json` the single authority on where metadata lives, with package-pattern scoping at output and nearest-ancestor discovery, so a consumer can point at a metadata tree elsewhere in the repo and take the slice it needs.

**Architecture:** Sources are an unordered **set** of tagged specs resolved to a canonically-sorted file list (the loader already derives whatever order it needs, so declared order carries no information). Scope is a package-pattern include/exclude filter applied at **output**, never to input — the collection always loads in full, which makes every scope closure-complete by construction. One new `resolveCollection()` entry point replaces nine hardcoded `metaobjects/` reads.

**Tech Stack:** TypeScript (ESM), Bun test runner, Zod for config schema, existing `@metaobjectsdev/metadata` loader and canonical serializer.

**Spec:** `docs/superpowers/specs/2026-08-17-metadata-source-resolution-design.md`

## Global Constraints

- **Named constants for metamodel strings — always.** Import `PACKAGE_SEPARATOR` from `@metaobjectsdev/metadata/constants`; never inline `"::"`.
- **No `any`.** Use `unknown` and narrow.
- **Never `instanceof` a metadata node from another package** — use the exported guards (`isMetaObject`, `isMetaField`, …). Two physical copies of `metadata` in one process make `instanceof` silently false.
- **Never call `own*()` accessors** (ADR-0039). Resolving/effective accessors are the default.
- **Backward compatibility is absolute:** a project with one config at the root, no `sources`, and no `scope` must produce **byte-identical** output to today. Every task that touches a read path must prove this.
- **Public repository.** No private project names, no absolute home paths (`/home/<user>/…`) in code, tests, fixtures, or commit messages.
- **Run tests scoped:** `cd server/typescript && bun test packages/<pkg>` — never a bare `bun test` at the repo root.
- Package separator is `::`. `*` matches any characters within one segment; a segment that is exactly `**` matches one or more segments.

---

## File Structure

**New — `server/typescript/packages/sdk/src/`**
- `scope.ts` — package-pattern compile + match. Pure, no I/O. The cross-port semantic core.
- `sources.ts` — `SourceSpec` union → canonically-sorted absolute file list. All filesystem I/O for source resolution.
- `discovery.ts` — nearest-ancestor config lookup. Filesystem walk only.
- `collection.ts` — `resolveCollection()`: the single authority composing the three above.

**New — tests**
- `packages/sdk/test/scope.test.ts`, `sources.test.ts`, `discovery.test.ts`, `collection.test.ts`
- `packages/sdk/test/order-independence.test.ts` — the linchpin gate
- `packages/sdk/test/scope-conformance.test.ts` — runs the shared corpus

**New — cross-port fixture**
- `fixtures/scope-conformance/cases.json`, `README.md`

**Modified**
- `packages/sdk/src/config.ts` — widen `sources`, add `scope`, add `migrate.scope`
- `packages/sdk/src/memory.ts` — `loadMemory` accepts a resolved file list
- `packages/sdk/src/index.ts` — export the new surface
- `packages/cli/src/commands/{gen,docs,export,migrate}.ts` — route reads through `resolveCollection()`
- `packages/cli/src/index.ts:275` — the "is this a MetaObjects project?" probe
- `packages/cli/src/lib/detect-stack.ts` — route + nested-symlink fix
- `packages/metadata/src/errors.ts` — register new error codes

**Deliberately unchanged**
- `packages/cli/src/commands/init.ts` — scaffolding writes the default directory. This is the one place the `"metaobjects"` literal belongs.

---

## Task 1: Scope pattern engine

**Files:**
- Create: `server/typescript/packages/sdk/src/scope.ts`
- Test: `server/typescript/packages/sdk/test/scope.test.ts`

**Interfaces:**
- Consumes: `PACKAGE_SEPARATOR` from `@metaobjectsdev/metadata/constants`
- Produces:
  - `interface Scope { readonly include?: readonly string[]; readonly exclude?: readonly string[] }`
  - `interface CompiledScope { readonly include: readonly RegExp[]; readonly exclude: readonly RegExp[] }`
  - `function compileScope(scope: Scope): CompiledScope` — throws `Error` whose message starts `ERR_SCOPE_PATTERN_INVALID` on an empty or malformed pattern
  - `function matchesScope(fqn: string, compiled: CompiledScope): boolean`

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/sdk/test/scope.test.ts
import { describe, test, expect } from "bun:test";
import { compileScope, matchesScope, type Scope } from "../src/scope.js";

const match = (fqn: string, scope: Scope) => matchesScope(fqn, compileScope(scope));

describe("compileScope / matchesScope", () => {
  test("empty include matches everything", () => {
    expect(match("acme::commerce::Order", {})).toBe(true);
  });

  test("* matches exactly one segment", () => {
    const s: Scope = { include: ["acme::*"] };
    expect(match("acme::Order", s)).toBe(true);
    expect(match("acme::commerce::Order", s)).toBe(false);
  });

  test("** matches one or more segments", () => {
    const s: Scope = { include: ["acme::**"] };
    expect(match("acme::Order", s)).toBe(true);
    expect(match("acme::commerce::Order", s)).toBe(true);
    expect(match("acme", s)).toBe(false);
    expect(match("other::Order", s)).toBe(false);
  });

  test("* within a segment matches a partial name but never crosses ::", () => {
    const s: Scope = { include: ["acme::Order*"] };
    expect(match("acme::OrderLine", s)).toBe(true);
    expect(match("acme::Order", s)).toBe(true);
    expect(match("acme::deep::OrderLine", s)).toBe(false);
  });

  test("exclude is applied after include", () => {
    const s: Scope = { include: ["acme::**"], exclude: ["acme::internal::**"] };
    expect(match("acme::commerce::Order", s)).toBe(true);
    expect(match("acme::internal::Secret", s)).toBe(false);
  });

  test("exclude alone narrows the implicit match-everything", () => {
    const s: Scope = { exclude: ["acme::internal::**"] };
    expect(match("acme::commerce::Order", s)).toBe(true);
    expect(match("acme::internal::Secret", s)).toBe(false);
  });

  test("a bare name with no package is matchable", () => {
    expect(match("Order", { include: ["Order"] })).toBe(true);
    expect(match("Order", { include: ["*"] })).toBe(true);
  });

  test("regex metacharacters in a pattern are literal", () => {
    expect(match("acme::Order.v2", { include: ["acme::Order.v2"] })).toBe(true);
    expect(match("acme::OrderXv2", { include: ["acme::Order.v2"] })).toBe(false);
  });

  test("an empty pattern is ERR_SCOPE_PATTERN_INVALID", () => {
    expect(() => compileScope({ include: [""] })).toThrow(/ERR_SCOPE_PATTERN_INVALID/);
  });

  test("an empty segment is ERR_SCOPE_PATTERN_INVALID", () => {
    expect(() => compileScope({ include: ["acme::::Order"] })).toThrow(/ERR_SCOPE_PATTERN_INVALID/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript && bun test packages/sdk/test/scope.test.ts`
Expected: FAIL — `Cannot find module '../src/scope.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// server/typescript/packages/sdk/src/scope.ts
import { PACKAGE_SEPARATOR } from "@metaobjectsdev/metadata/constants";

/** A consumer-side output filter over fully-qualified node names. */
export interface Scope {
  /** Absent or empty means "everything". */
  readonly include?: readonly string[];
  /** Applied after `include`. */
  readonly exclude?: readonly string[];
}

export interface CompiledScope {
  readonly include: readonly RegExp[];
  readonly exclude: readonly RegExp[];
}

/** One package segment: any run of characters containing no separator char. */
const SEGMENT = "[^:]+";
/** One or more segments, separator-joined — the `**` expansion. */
const SEGMENTS = `${SEGMENT}(?:${PACKAGE_SEPARATOR}${SEGMENT})*`;

function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile one segment. `**` spans segments; `*` never crosses a separator. */
function compileSegment(segment: string, pattern: string): string {
  if (segment.length === 0) {
    throw new Error(
      `ERR_SCOPE_PATTERN_INVALID: empty segment in scope pattern "${pattern}"`,
    );
  }
  if (segment === "**") return `(?:${SEGMENTS})`;
  // `*` inside a segment matches any characters except the separator char.
  return segment.split("*").map(escapeLiteral).join("[^:]*");
}

export function compilePattern(pattern: string): RegExp {
  if (pattern.length === 0) {
    throw new Error("ERR_SCOPE_PATTERN_INVALID: scope pattern must not be empty");
  }
  const body = pattern
    .split(PACKAGE_SEPARATOR)
    .map((segment) => compileSegment(segment, pattern))
    .join(PACKAGE_SEPARATOR);
  return new RegExp(`^${body}$`);
}

export function compileScope(scope: Scope): CompiledScope {
  return {
    include: (scope.include ?? []).map(compilePattern),
    exclude: (scope.exclude ?? []).map(compilePattern),
  };
}

/** True when `fqn` is inside the scope. An empty `include` means everything. */
export function matchesScope(fqn: string, compiled: CompiledScope): boolean {
  const included =
    compiled.include.length === 0 || compiled.include.some((re) => re.test(fqn));
  if (!included) return false;
  return !compiled.exclude.some((re) => re.test(fqn));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/typescript && bun test packages/sdk/test/scope.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Typecheck**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/sdk' typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/sdk/src/scope.ts server/typescript/packages/sdk/test/scope.test.ts
git commit -m "feat(sdk): package-pattern scope engine (* = one segment, ** = one or more)"
```

---

## Task 2: Scope-pattern conformance corpus

Pins the semantics cross-port so `*` and `**` cannot come to mean five different things — the failure mode that produced the cross-port `LIKE`/`ILIKE` divergence.

**Files:**
- Create: `fixtures/scope-conformance/cases.json`
- Create: `fixtures/scope-conformance/README.md`
- Test: `server/typescript/packages/sdk/test/scope-conformance.test.ts`

**Interfaces:**
- Consumes: `compileScope` / `matchesScope` from Task 1
- Produces: the corpus contract — `{ cases: Array<{ name: string; scope: {include?: string[]; exclude?: string[]}; expect: Array<{ fqn: string; matches: boolean }> }> }`. Every other port's runner reads this same file.

- [ ] **Step 1: Write the corpus**

```json
{
  "cases": [
    {
      "name": "empty-scope-matches-everything",
      "scope": {},
      "expect": [
        { "fqn": "acme::commerce::Order", "matches": true },
        { "fqn": "Order", "matches": true }
      ]
    },
    {
      "name": "single-star-is-one-segment",
      "scope": { "include": ["acme::*"] },
      "expect": [
        { "fqn": "acme::Order", "matches": true },
        { "fqn": "acme::commerce::Order", "matches": false },
        { "fqn": "other::Order", "matches": false }
      ]
    },
    {
      "name": "double-star-is-one-or-more-segments",
      "scope": { "include": ["acme::**"] },
      "expect": [
        { "fqn": "acme::Order", "matches": true },
        { "fqn": "acme::commerce::Order", "matches": true },
        { "fqn": "acme::commerce::internal::Secret", "matches": true },
        { "fqn": "acme", "matches": false },
        { "fqn": "acmex::Order", "matches": false }
      ]
    },
    {
      "name": "partial-star-never-crosses-separator",
      "scope": { "include": ["acme::Order*"] },
      "expect": [
        { "fqn": "acme::Order", "matches": true },
        { "fqn": "acme::OrderLine", "matches": true },
        { "fqn": "acme::deep::OrderLine", "matches": false }
      ]
    },
    {
      "name": "exclude-applied-after-include",
      "scope": { "include": ["acme::**"], "exclude": ["acme::internal::**"] },
      "expect": [
        { "fqn": "acme::commerce::Order", "matches": true },
        { "fqn": "acme::internal::Secret", "matches": false }
      ]
    },
    {
      "name": "exclude-alone-narrows-everything",
      "scope": { "exclude": ["acme::internal::**"] },
      "expect": [
        { "fqn": "other::Thing", "matches": true },
        { "fqn": "acme::internal::Secret", "matches": false }
      ]
    },
    {
      "name": "multiple-includes-are-a-union",
      "scope": { "include": ["acme::commerce::**", "acme::common::**"] },
      "expect": [
        { "fqn": "acme::commerce::Order", "matches": true },
        { "fqn": "acme::common::BaseEntity", "matches": true },
        { "fqn": "acme::billing::Invoice", "matches": false }
      ]
    },
    {
      "name": "regex-metacharacters-are-literal",
      "scope": { "include": ["acme::Order.v2"] },
      "expect": [
        { "fqn": "acme::Order.v2", "matches": true },
        { "fqn": "acme::OrderXv2", "matches": false }
      ]
    }
  ]
}
```

Write `fixtures/scope-conformance/README.md` stating: the corpus is the cross-port contract for `scope` pattern semantics; every port runs it; `*` matches any characters within one segment and never crosses `::`; a segment that is exactly `**` matches one or more segments; `include` empty means everything; `exclude` is applied after `include`.

- [ ] **Step 2: Write the failing runner test**

```ts
// server/typescript/packages/sdk/test/scope-conformance.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileScope, matchesScope, type Scope } from "../src/scope.js";

interface Case {
  name: string;
  scope: Scope;
  expect: Array<{ fqn: string; matches: boolean }>;
}

const CORPUS = join(import.meta.dir, "../../../../../fixtures/scope-conformance/cases.json");
const cases = (JSON.parse(readFileSync(CORPUS, "utf8")) as { cases: Case[] }).cases;

describe("scope-conformance corpus", () => {
  test("corpus is non-empty (a silent zero-case run is a failed gate)", () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  for (const c of cases) {
    test(c.name, () => {
      const compiled = compileScope(c.scope);
      for (const e of c.expect) {
        expect({ fqn: e.fqn, matches: matchesScope(e.fqn, compiled) })
          .toEqual({ fqn: e.fqn, matches: e.matches });
      }
    });
  }
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `cd server/typescript && bun test packages/sdk/test/scope-conformance.test.ts`
Expected: PASS — 9 tests (8 cases + the non-empty guard)

- [ ] **Step 4: Prove the gate by breaking it**

Temporarily change `SEGMENTS` in `scope.ts` to `".*"` (making `*` cross separators), re-run, and confirm `single-star-is-one-segment` FAILS. Then revert.

Expected: FAIL before revert, PASS after. A gate that has never been seen red is not known to work.

- [ ] **Step 5: Commit**

```bash
git add fixtures/scope-conformance server/typescript/packages/sdk/test/scope-conformance.test.ts
git commit -m "test(conformance): scope-pattern corpus pins * and ** semantics cross-port"
```

---

## Task 3: Register new error codes

**Files:**
- Modify: `server/typescript/packages/metadata/src/errors.ts:19` (the `ERROR_CODES` array)
- Test: `server/typescript/packages/metadata/test/errors.test.ts` (extend if present; create if not)

**Interfaces:**
- Produces: `"ERR_SOURCE_UNRESOLVED"`, `"ERR_SOURCE_KIND_UNSUPPORTED"`, `"ERR_SCOPE_PATTERN_INVALID"`, `"ERR_COLLECTION_NOT_FOUND"` as members of `ERROR_CODES`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { ERROR_CODES } from "../src/errors.js";

describe("phase-1 source-resolution error codes", () => {
  test("are registered in the shared ledger", () => {
    for (const code of [
      "ERR_SOURCE_UNRESOLVED",
      "ERR_SOURCE_KIND_UNSUPPORTED",
      "ERR_SCOPE_PATTERN_INVALID",
      "ERR_COLLECTION_NOT_FOUND",
    ]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/metadata/test/errors.test.ts`
Expected: FAIL — codes not found

- [ ] **Step 3: Add the codes**

Add these four string literals to the `ERROR_CODES` array in `errors.ts`, each with a comment naming the phase-1 source-resolution design as their origin, matching the file's existing comment style.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript && bun test packages/metadata/test/errors.test.ts`
Expected: PASS

- [ ] **Step 5: Note the cross-port debt**

Add a line to the plan's tracking notes: Python `errors.py` (superset) and Java `ErrorCode.java` need the same four codes in the ports plan. TS `errors.ts` is exact-bidirectional, so its own gate will now expect them.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/errors.ts server/typescript/packages/metadata/test/errors.test.ts
git commit -m "feat(metadata): register phase-1 source-resolution error codes"
```

---

## Task 4: Source spec resolution

**Files:**
- Create: `server/typescript/packages/sdk/src/sources.ts`
- Test: `server/typescript/packages/sdk/test/sources.test.ts`

**Interfaces:**
- Produces:
  - `type SourceSpec = { path: string } | { resource: string } | { package: string }`
  - `interface ResolvedSource { readonly file: string; readonly spec: SourceSpec }`
  - `function resolveSources(configDir: string, specs: readonly SourceSpec[]): Promise<ResolvedSource[]>` — returns files sorted by absolute path (canonical, order-free); throws on an unresolvable `path`; throws `ERR_SOURCE_KIND_UNSUPPORTED` for `resource`/`package` in phase 1
  - `const DEFAULT_SOURCES: readonly SourceSpec[]` — `[{ path: "metaobjects" }]`

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/sdk/test/sources.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSources, DEFAULT_SOURCES } from "../src/sources.js";

let root: string;
const write = (rel: string, body = "{}") => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body, "utf8");
  return full;
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-sources-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("resolveSources", () => {
  test("resolves a directory recursively, metadata files only", async () => {
    write("model/meta.a.json");
    write("model/nested/meta.b.yaml");
    write("model/notes.txt");
    const out = await resolveSources(root, [{ path: "model" }]);
    expect(out.map((r) => r.file.replace(root + "/", ""))).toEqual([
      "model/meta.a.json",
      "model/nested/meta.b.yaml",
    ]);
  });

  test("resolves a single file", async () => {
    write("model/meta.a.json");
    const out = await resolveSources(root, [{ path: "model/meta.a.json" }]);
    expect(out).toHaveLength(1);
  });

  test("output is canonically sorted regardless of spec order", async () => {
    write("b/meta.b.json");
    write("a/meta.a.json");
    const forward = await resolveSources(root, [{ path: "a" }, { path: "b" }]);
    const reverse = await resolveSources(root, [{ path: "b" }, { path: "a" }]);
    expect(forward.map((r) => r.file)).toEqual(reverse.map((r) => r.file));
  });

  test("de-duplicates a file contributed by two overlapping specs", async () => {
    write("model/meta.a.json");
    const out = await resolveSources(root, [{ path: "model" }, { path: "model/meta.a.json" }]);
    expect(out).toHaveLength(1);
  });

  test("paths resolve against the config dir, not process.cwd()", async () => {
    write("apps/ui/.keep");
    write("model/meta.a.json");
    const out = await resolveSources(join(root, "apps/ui"), [{ path: "../../model" }]);
    expect(out).toHaveLength(1);
  });

  test("an unresolvable path is ERR_SOURCE_UNRESOLVED, never a silent skip", async () => {
    await expect(resolveSources(root, [{ path: "missing" }])).rejects.toThrow(
      /ERR_SOURCE_UNRESOLVED/,
    );
  });

  test("resource and package kinds are ERR_SOURCE_KIND_UNSUPPORTED in phase 1", async () => {
    await expect(resolveSources(root, [{ resource: "acme/model" }])).rejects.toThrow(
      /ERR_SOURCE_KIND_UNSUPPORTED/,
    );
    await expect(resolveSources(root, [{ package: "@acme/model" }])).rejects.toThrow(
      /ERR_SOURCE_KIND_UNSUPPORTED/,
    );
  });

  test("_pending is excluded at any depth", async () => {
    write("model/meta.a.json");
    write("model/_pending/meta.draft.json");
    const out = await resolveSources(root, [{ path: "model" }]);
    expect(out).toHaveLength(1);
  });

  test("a nested symlinked directory is followed", async () => {
    write("real/meta.b.json");
    write("model/meta.a.json");
    const { symlinkSync } = await import("node:fs");
    symlinkSync(join(root, "real"), join(root, "model/linked"), "dir");
    const out = await resolveSources(root, [{ path: "model" }]);
    expect(out).toHaveLength(2);
  });

  test("DEFAULT_SOURCES is the metaobjects/ directory", () => {
    expect(DEFAULT_SOURCES).toEqual([{ path: "metaobjects" }]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/sdk/test/sources.test.ts`
Expected: FAIL — `Cannot find module '../src/sources.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// server/typescript/packages/sdk/src/sources.ts
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

/** Tagged union of source kinds. `resource` and `package` are declared now so the
 *  config shape is stable; only `path` resolves in phase 1. */
export type SourceSpec =
  | { readonly path: string }
  | { readonly resource: string }
  | { readonly package: string };

export interface ResolvedSource {
  /** Absolute path of one metadata file. */
  readonly file: string;
  /** The spec that contributed it — provenance for diagnostics. */
  readonly spec: SourceSpec;
}

/** Used when `sources` is absent or empty. `metaobjects/` is a DEFAULT, never a requirement. */
export const DEFAULT_SOURCES: readonly SourceSpec[] = [{ path: "metaobjects" }];

const PENDING_DIR = "_pending";

function isMetadataFile(name: string): boolean {
  return name.endsWith(".json") || name.endsWith(".yaml") || name.endsWith(".yml");
}

/** Recursively collect metadata files. Uses `stat` (follows symlinks) so a symlinked
 *  subdirectory is traversed — the loader has always followed them. */
async function collectDir(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir);
  for (const entry of entries) {
    if (entry === PENDING_DIR) continue;
    const full = join(dir, entry);
    const s = await stat(full);
    if (s.isDirectory()) await collectDir(full, out);
    else if (s.isFile() && isMetadataFile(entry)) out.push(full);
  }
}

/**
 * Resolve a source SET to a canonically-sorted list of metadata files.
 *
 * The result is sorted by absolute path and de-duplicated, so it is a pure function
 * of the source set: permuting `specs` cannot change the output. Declared order
 * carries no information (the loader derives whatever order it needs).
 *
 * @param configDir absolute directory of the declaring config — relative `path`
 *   specs resolve against it, never against ambient `process.cwd()`.
 */
export async function resolveSources(
  configDir: string,
  specs: readonly SourceSpec[],
): Promise<ResolvedSource[]> {
  const byFile = new Map<string, SourceSpec>();

  for (const spec of specs) {
    if (!("path" in spec)) {
      const kind = "resource" in spec ? "resource" : "package";
      throw new Error(
        `ERR_SOURCE_KIND_UNSUPPORTED: source kind "${kind}" is not supported by this ` +
          `toolchain yet; use a "path" source.`,
      );
    }
    const target = isAbsolute(spec.path) ? spec.path : resolve(configDir, spec.path);
    let s;
    try {
      s = await stat(target);
    } catch {
      throw new Error(
        `ERR_SOURCE_UNRESOLVED: source path "${spec.path}" does not exist ` +
          `(resolved to ${target}, relative to ${configDir}).`,
      );
    }
    const found: string[] = [];
    if (s.isDirectory()) await collectDir(target, found);
    else found.push(target);
    for (const file of found) if (!byFile.has(file)) byFile.set(file, spec);
  }

  return [...byFile.keys()]
    .sort()
    .map((file) => ({ file, spec: byFile.get(file)! }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript && bun test packages/sdk/test/sources.test.ts`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/sources.ts server/typescript/packages/sdk/test/sources.test.ts
git commit -m "feat(sdk): resolve a source SET to a canonically-sorted file list"
```

---

## Task 5: Config schema — `sources`, `scope`, `migrate.scope`

**Files:**
- Modify: `server/typescript/packages/sdk/src/config.ts:64-78`
- Test: `server/typescript/packages/sdk/test/config.test.ts`

**Interfaces:**
- Consumes: `SourceSpec` (Task 4), `Scope` (Task 1)
- Produces: `ConfigSchema` accepting `sources: SourceSpec[]`, `scope?: {include?: string[]; exclude?: string[]}`, and `migrate.scope?: string[]`

- [ ] **Step 1: Write the failing test**

Append to `packages/sdk/test/config.test.ts`:

```ts
describe("ConfigSchema — phase-1 source resolution", () => {
  test("accepts a path source", () => {
    const p = ConfigSchema.parse({ schema_version: 1, sources: [{ path: "../model" }] });
    expect(p.sources).toEqual([{ path: "../model" }]);
  });
  test("accepts resource and package source kinds", () => {
    const p = ConfigSchema.parse({
      schema_version: 1,
      sources: [{ resource: "acme/model" }, { package: "@acme/model" }],
    });
    expect(p.sources).toHaveLength(2);
  });
  test("rejects an unknown source kind", () => {
    expect(() => ConfigSchema.parse({ schema_version: 1, sources: [{ nope: "x" }] })).toThrow();
  });
  test("accepts a scope block", () => {
    const p = ConfigSchema.parse({
      schema_version: 1,
      scope: { include: ["acme::**"], exclude: ["acme::internal::**"] },
    });
    expect(p.scope?.include).toEqual(["acme::**"]);
  });
  test("scope defaults to undefined (match everything)", () => {
    expect(ConfigSchema.parse({ schema_version: 1 }).scope).toBeUndefined();
  });
  test("accepts migrate.scope", () => {
    const p = ConfigSchema.parse({
      schema_version: 1,
      migrate: { scope: ["acme::platform::**"] },
    });
    expect(p.migrate?.scope).toEqual(["acme::platform::**"]);
  });
  test("an existing config with no new keys still parses (back-compat)", () => {
    const p = ConfigSchema.parse({
      schema_version: 1, pending_in_git: true,
      confidence_thresholds: { pending_promote: 0.8, drift_warn: 0.7 },
      sources: [], extract: {},
    });
    expect(p.sources).toEqual([]);
    expect(p.scope).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/sdk/test/config.test.ts`
Expected: FAIL — the `resource` source and the `scope` block are rejected

- [ ] **Step 3: Widen the schema**

In `config.ts`, replace the existing `sources` union and add `scope`:

```ts
const SourceSpecSchema = z.union([
  z.object({ path: z.string().min(1) }).strict(),
  z.object({ resource: z.string().min(1) }).strict(),
  z.object({ package: z.string().min(1) }).strict(),
]);

const ScopeSchema = z.object({
  include: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
}).strict();
```

In `ConfigSchema`: replace the `sources` field with `z.array(SourceSpecSchema).default([])`, add `scope: ScopeSchema.optional()`, and add `scope: z.array(z.string().min(1))` to `MigrateBlock`'s partial shape.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript && bun test packages/sdk/test/config.test.ts`
Expected: PASS — including the pre-existing tests, unchanged

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/config.ts server/typescript/packages/sdk/test/config.test.ts
git commit -m "feat(sdk): config accepts a source SET, a scope block, and migrate.scope"
```

---

## Task 6: Nearest-ancestor discovery

**Files:**
- Create: `server/typescript/packages/sdk/src/discovery.ts`
- Test: `server/typescript/packages/sdk/test/discovery.test.ts`

**Interfaces:**
- Produces: `function findConfigDir(startDir: string): Promise<string | undefined>` — walks up for a directory containing `.metaobjects/config.json`; stops after examining a directory containing `.git`; returns the containing directory (not the `.metaobjects` dir), or `undefined`

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/sdk/test/discovery.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigDir } from "../src/discovery.js";

let root: string;
const mk = (rel: string) => mkdirSync(join(root, rel), { recursive: true });
const cfg = (rel: string) => {
  mk(join(rel, ".metaobjects"));
  writeFileSync(join(root, rel, ".metaobjects/config.json"), '{"schema_version":1}', "utf8");
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-discovery-")); mk(".git"); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("findConfigDir", () => {
  test("finds a config in the start directory", async () => {
    cfg("apps/ui"); mk("apps/ui/src");
    expect(await findConfigDir(join(root, "apps/ui"))).toBe(join(root, "apps/ui"));
  });
  test("walks up to the nearest ancestor config", async () => {
    cfg("apps/ui"); mk("apps/ui/src/deep");
    expect(await findConfigDir(join(root, "apps/ui/src/deep"))).toBe(join(root, "apps/ui"));
  });
  test("nearest wins over a further ancestor", async () => {
    cfg("."); cfg("apps/ui"); mk("apps/ui/src");
    expect(await findConfigDir(join(root, "apps/ui/src"))).toBe(join(root, "apps/ui"));
  });
  test("stops at the repository boundary — never adopts a parent checkout's config", async () => {
    // A config ABOVE the .git boundary must not be found.
    const outer = mkdtempSync(join(tmpdir(), "metaobjects-outer-"));
    try {
      mkdirSync(join(outer, "inner/.git"), { recursive: true });
      mkdirSync(join(outer, ".metaobjects"), { recursive: true });
      writeFileSync(join(outer, ".metaobjects/config.json"), '{"schema_version":1}', "utf8");
      mkdirSync(join(outer, "inner/src"), { recursive: true });
      expect(await findConfigDir(join(outer, "inner/src"))).toBeUndefined();
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
  test("a repo-root config IS found from a subdirectory", async () => {
    cfg("."); mk("apps/ui");
    expect(await findConfigDir(join(root, "apps/ui"))).toBe(root);
  });
  test("returns undefined when nothing is found", async () => {
    mk("apps/ui");
    expect(await findConfigDir(join(root, "apps/ui"))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/sdk/test/discovery.test.ts`
Expected: FAIL — `Cannot find module '../src/discovery.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// server/typescript/packages/sdk/src/discovery.ts
import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DEFAULT_METAOBJECTS_DIR } from "./memory.js";

const CONFIG_FILE = "config.json";
const GIT_DIR = ".git";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

/**
 * Walk up from `startDir` for the nearest directory holding
 * `.metaobjects/config.json`. The walk STOPS after examining a directory that
 * contains `.git`, so a monorepo can never silently adopt a parent checkout's
 * configuration. Returns the containing directory, or undefined.
 */
export async function findConfigDir(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);
  for (;;) {
    if (await exists(join(dir, DEFAULT_METAOBJECTS_DIR, CONFIG_FILE))) return dir;
    // Boundary check AFTER the config check: a repo-root config is still findable.
    if (await exists(join(dir, GIT_DIR))) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript && bun test packages/sdk/test/discovery.test.ts`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/discovery.ts server/typescript/packages/sdk/test/discovery.test.ts
git commit -m "feat(sdk): nearest-ancestor config discovery, bounded by the repo root"
```

---

## Task 7: `resolveCollection()` — the single authority

**Files:**
- Create: `server/typescript/packages/sdk/src/collection.ts`
- Modify: `server/typescript/packages/sdk/src/index.ts` (export the new surface)
- Test: `server/typescript/packages/sdk/test/collection.test.ts`

**Interfaces:**
- Consumes: `findConfigDir` (T6), `resolveSources`/`DEFAULT_SOURCES` (T4), `compileScope` (T1), `loadConfig` (T5)
- Produces:
  - `interface Collection { readonly configDir: string; readonly files: readonly string[]; readonly sources: readonly ResolvedSource[]; readonly scope: CompiledScope; readonly migrateScope: CompiledScope | undefined }`
  - `function resolveCollection(startDir: string, opts?: { explicitDir?: string }): Promise<Collection>` — throws `ERR_COLLECTION_NOT_FOUND` when no config is discovered AND the default directory does not exist

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/sdk/test/collection.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCollection } from "../src/collection.js";
import { matchesScope } from "../src/scope.js";

let root: string;
const write = (rel: string, body: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
};
const config = (dir: string, cfg: object) =>
  write(join(dir, ".metaobjects/config.json"), JSON.stringify({ schema_version: 1, ...cfg }));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-collection-")); mkdirSync(join(root, ".git")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("resolveCollection", () => {
  test("BACK-COMPAT: no sources declared falls back to metaobjects/", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", {});
    const c = await resolveCollection(root);
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual(["metaobjects/meta.a.json"]);
  });

  test("BACK-COMPAT: no config at all still finds metaobjects/ in the start dir", async () => {
    write("metaobjects/meta.a.json", "{}");
    const c = await resolveCollection(root);
    expect(c.files).toHaveLength(1);
  });

  test("a consumer reaches a tree elsewhere in the repo", async () => {
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }] });
    const c = await resolveCollection(join(root, "apps/ui"));
    expect(c.configDir).toBe(join(root, "apps/ui"));
    expect(c.files.map((f) => f.replace(root + "/", ""))).toEqual(["model/meta.a.json"]);
  });

  test("scope compiles and is applied by matchesScope", async () => {
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }], scope: { include: ["acme::**"] } });
    const c = await resolveCollection(join(root, "apps/ui"));
    expect(matchesScope("acme::Order", c.scope)).toBe(true);
    expect(matchesScope("other::Order", c.scope)).toBe(false);
  });

  test("migrateScope is undefined when not declared", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", {});
    expect((await resolveCollection(root)).migrateScope).toBeUndefined();
  });

  test("migrateScope compiles when declared", async () => {
    write("metaobjects/meta.a.json", "{}");
    config(".", { migrate: { scope: ["acme::platform::**"] } });
    const c = await resolveCollection(root);
    expect(matchesScope("acme::platform::Job", c.migrateScope!)).toBe(true);
    expect(matchesScope("arena::Match", c.migrateScope!)).toBe(false);
  });

  test("an explicit dir overrides discovery", async () => {
    write("model/meta.a.json", "{}");
    config("apps/ui", { sources: [{ path: "../../model" }] });
    config("apps/api", { sources: [{ path: "../../model" }] });
    const c = await resolveCollection(join(root, "apps/ui"), { explicitDir: join(root, "apps/api") });
    expect(c.configDir).toBe(join(root, "apps/api"));
  });

  test("nothing discoverable and no default dir is ERR_COLLECTION_NOT_FOUND", async () => {
    mkdirSync(join(root, "apps/ui"), { recursive: true });
    await expect(resolveCollection(join(root, "apps/ui"))).rejects.toThrow(
      /ERR_COLLECTION_NOT_FOUND/,
    );
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/sdk/test/collection.test.ts`
Expected: FAIL — `Cannot find module '../src/collection.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// server/typescript/packages/sdk/src/collection.ts
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { findConfigDir } from "./discovery.js";
import { compileScope, type CompiledScope } from "./scope.js";
import { DEFAULT_METADATA_DIR, DEFAULT_METAOBJECTS_DIR } from "./memory.js";
import { DEFAULT_SOURCES, resolveSources, type ResolvedSource, type SourceSpec } from "./sources.js";

export interface Collection {
  /** Directory whose config declared this collection. */
  readonly configDir: string;
  /** Canonically-sorted absolute metadata file paths. */
  readonly files: readonly string[];
  /** Same set, carrying the contributing spec for provenance. */
  readonly sources: readonly ResolvedSource[];
  /** Output filter for codegen. Empty include => everything. */
  readonly scope: CompiledScope;
  /** Output filter for migrate/verify --db. Undefined => the command governs everything in scope. */
  readonly migrateScope: CompiledScope | undefined;
}

async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

/**
 * THE single authority on where metadata lives. Every read path routes through
 * this — `metaobjects/` is the DEFAULT value of `sources`, never an assumption
 * baked into a call site.
 */
export async function resolveCollection(
  startDir: string,
  opts?: { explicitDir?: string },
): Promise<Collection> {
  const explicit = opts?.explicitDir;
  const configDir = explicit !== undefined
    ? resolve(explicit)
    : (await findConfigDir(startDir)) ?? resolve(startDir);

  let specs: readonly SourceSpec[] = DEFAULT_SOURCES;
  let scopeSpec = undefined as { include?: string[]; exclude?: string[] } | undefined;
  let migrateSpec: string[] | undefined;

  if (await isDir(join(configDir, DEFAULT_METAOBJECTS_DIR))) {
    try {
      const cfg = await loadConfig(join(configDir, DEFAULT_METAOBJECTS_DIR));
      if (cfg.sources.length > 0) specs = cfg.sources;
      scopeSpec = cfg.scope;
      migrateSpec = cfg.migrate?.scope;
    } catch {
      // No config.json, or unreadable — fall through to the default source set.
      // A malformed config surfaces from loadConfig on the paths that require it.
    }
  }

  // Only the DEFAULT is allowed to be absent — an explicitly declared source that
  // does not resolve is an error (resolveSources throws ERR_SOURCE_UNRESOLVED).
  if (specs === DEFAULT_SOURCES && !(await isDir(join(configDir, DEFAULT_METADATA_DIR)))) {
    throw new Error(
      `ERR_COLLECTION_NOT_FOUND: no metadata sources declared in ${configDir} and no ` +
        `default "${DEFAULT_METADATA_DIR}" directory found. Declare "sources" in ` +
        `${DEFAULT_METAOBJECTS_DIR}/config.json, or run 'meta init' to scaffold.`,
    );
  }

  const sources = await resolveSources(configDir, specs);
  return {
    configDir,
    files: sources.map((s) => s.file),
    sources,
    scope: compileScope(scopeSpec ?? {}),
    migrateScope: migrateSpec === undefined ? undefined : compileScope({ include: migrateSpec }),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript && bun test packages/sdk/test/collection.test.ts`
Expected: PASS — 8 tests

- [ ] **Step 5: Export the surface**

Add to `packages/sdk/src/index.ts`: `resolveCollection`, `type Collection` from `./collection.js`; `compileScope`, `matchesScope`, `type Scope`, `type CompiledScope` from `./scope.js`; `resolveSources`, `DEFAULT_SOURCES`, `type SourceSpec`, `type ResolvedSource` from `./sources.js`; `findConfigDir` from `./discovery.js`.

- [ ] **Step 6: Typecheck and commit**

```bash
cd server/typescript && bun run --filter '@metaobjectsdev/sdk' typecheck
git add server/typescript/packages/sdk/src/collection.ts server/typescript/packages/sdk/src/index.ts server/typescript/packages/sdk/test/collection.test.ts
git commit -m "feat(sdk): resolveCollection() — one authority for where metadata lives"
```

---

## Task 8: Order-independence gate (the linchpin)

Without this, set semantics is a belief that decays the first time someone writes an order-sensitive code path.

**Files:**
- Test: `server/typescript/packages/sdk/test/order-independence.test.ts`

**Interfaces:**
- Consumes: `resolveSources` (T4), `loadMemory` (existing), the canonical serializer from `@metaobjectsdev/metadata`

- [ ] **Step 1: Write the test**

```ts
// server/typescript/packages/sdk/test/order-independence.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSources, type SourceSpec } from "../src/sources.js";

let root: string;
const write = (rel: string, body: object) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), JSON.stringify(body), "utf8");
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "metaobjects-order-"));
  // A base declaration, an overlay onto it, and an independent third file —
  // the shapes whose merge is order-sensitive if anything is.
  write("a/meta.base.json", {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Order", children: [{ "field.string": { name: "id" } }] } }] },
  });
  write("b/meta.overlay.json", {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Order", overlay: true, children: [
        { "field.string": { name: "note" } }] } }] },
  });
  write("c/meta.other.json", {
    "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Customer", children: [{ "field.string": { name: "id" } }] } }] },
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const p of permutations(rest)) out.push([items[i]!, ...p]);
  }
  return out;
}

describe("order independence", () => {
  test("resolveSources output is identical across every spec permutation", async () => {
    const specs: SourceSpec[] = [{ path: "a" }, { path: "b" }, { path: "c" }];
    const results = await Promise.all(
      permutations(specs).map((p) => resolveSources(root, p).then((r) => r.map((x) => x.file))),
    );
    expect(results).toHaveLength(6);
    for (const r of results) expect(r).toEqual(results[0]!);
  });

  test("the loaded model serializes byte-identically across every permutation", async () => {
    const { MetaDataLoader, composeRegistry, coreProviders, serializeCanonical } =
      await import("@metaobjectsdev/metadata");
    const { FileSource } = await import("@metaobjectsdev/metadata/core");
    const specs: SourceSpec[] = [{ path: "a" }, { path: "b" }, { path: "c" }];

    const serialized: string[] = [];
    for (const p of permutations(specs)) {
      const resolved = await resolveSources(root, p);
      const loader = new MetaDataLoader({ registry: composeRegistry(coreProviders) });
      const result = await loader.load(resolved.map((r) => new FileSource(r.file)));
      expect(result.errors).toHaveLength(0);
      serialized.push(serializeCanonical(result.root));
    }
    expect(serialized).toHaveLength(6);
    for (const s of serialized) expect(s).toBe(serialized[0]!);
  });
});
```

- [ ] **Step 2: Run it**

Run: `cd server/typescript && bun test packages/sdk/test/order-independence.test.ts`
Expected: PASS.

**If the second test FAILS, stop and report before changing anything.** A failure means the loader is not in fact order-independent for this shape, which invalidates a load-bearing premise of the design — that is a finding to escalate, not a test to adjust.

**Note for the implementer:** confirm the exact export name of the canonical serializer (`serializeCanonical` above is the expected name) by grepping `packages/metadata/src/index.ts`; use the real export and adjust the import.

- [ ] **Step 3: Prove the gate by breaking it**

Temporarily remove the `.sort()` from `resolveSources` in `sources.ts`, re-run, and confirm the first test FAILS. Revert.

Expected: FAIL before revert, PASS after.

- [ ] **Step 4: Commit**

```bash
git add server/typescript/packages/sdk/test/order-independence.test.ts
git commit -m "test(sdk): pin order independence — permuted source sets serialize byte-identically"
```

---

## Task 9: Route `loadMemory` through a resolved collection

**Files:**
- Modify: `server/typescript/packages/sdk/src/memory.ts:105,122-143`
- Test: `server/typescript/packages/sdk/test/memory.test.ts`

**Interfaces:**
- Consumes: `Collection` (T7)
- Produces: `loadMemory(repoRoot: string, options?: LoadMemoryOptions & { files?: readonly string[] })` — when `files` is supplied it loads exactly those and skips all directory discovery; behavior with `files` absent is unchanged

- [ ] **Step 1: Write the failing test**

Append to `packages/sdk/test/memory.test.ts`:

```ts
describe("loadMemory with an explicit file set", () => {
  test("loads exactly the supplied files, ignoring any metaobjects/ dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "metaobjects-memory-files-"));
    try {
      mkdirSync(join(dir, "model"), { recursive: true });
      mkdirSync(join(dir, "metaobjects"), { recursive: true });
      writeFileSync(join(dir, "model/meta.a.json"), JSON.stringify({
        "metadata.root": { package: "acme", children: [
          { "object.entity": { name: "Order", children: [{ "field.string": { name: "id" } }] } }] },
      }), "utf8");
      writeFileSync(join(dir, "metaobjects/meta.decoy.json"), JSON.stringify({
        "metadata.root": { package: "acme", children: [
          { "object.entity": { name: "Decoy", children: [{ "field.string": { name: "id" } }] } }] },
      }), "utf8");
      const root = await loadMemory(dir, { files: [join(dir, "model/meta.a.json")] });
      const names = root.children().map((c) => c.name);
      expect(names).toContain("Order");
      expect(names).not.toContain("Decoy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/sdk/test/memory.test.ts`
Expected: FAIL — `Decoy` is present, because `loadMemory` still scans `metaobjects/`

- [ ] **Step 3: Implement**

In `memory.ts`, add `files?: readonly string[]` to `LoadMemoryOptions`, and in `loadMemory` replace the `collectMetadataPaths(repoRoot)` call with:

```ts
const paths = options?.files !== undefined
  ? [...options.files]
  : await collectMetadataPaths(repoRoot);
```

Leave `collectMetadataPaths` and `listMetadataFiles` untouched — they remain the no-`files` fallback and the back-compat path.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript && bun test packages/sdk/test/memory.test.ts`
Expected: PASS — including all pre-existing tests

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/sdk/src/memory.ts server/typescript/packages/sdk/test/memory.test.ts
git commit -m "feat(sdk): loadMemory accepts an explicit resolved file set"
```

---

## Task 10: Route the CLI read sites

Five of the nine hardcoded reads. `init.ts` is deliberately excluded — it writes the default.

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/gen.ts:55-72`
- Modify: `server/typescript/packages/cli/src/commands/docs.ts:292,529-530`
- Modify: `server/typescript/packages/cli/src/commands/export.ts:19`
- Modify: `server/typescript/packages/cli/src/index.ts:275`
- Test: `server/typescript/packages/cli/test/collection-routing.test.ts` (create)

**Interfaces:**
- Consumes: `resolveCollection` (T7), `loadMemory({ files })` (T9)

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/cli/test/collection-routing.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { genCommand } from "../src/commands/gen.js";

let root: string;
const write = (rel: string, body: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-cli-route-")); mkdirSync(join(root, ".git")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("gen routes metadata discovery through resolveCollection", () => {
  test("generates from a sources-declared tree with no metaobjects/ present", async () => {
    write("model/meta.a.json", JSON.stringify({
      "metadata.root": { package: "acme", children: [
        { "object.entity": { name: "Order", children: [
          { "field.string": { name: "id" } },
          { "identity.primary": { "@fields": ["id"] } },
          { "source.rdb": { "@table": "orders", "@kind": "table" } }] } }] },
    }));
    write("apps/ui/.metaobjects/config.json", JSON.stringify({
      schema_version: 1, sources: [{ path: "../../model" }],
    }));
    write("apps/ui/metaobjects.config.ts", [
      'import { defineConfig } from "@metaobjectsdev/cli";',
      'import { entityFile } from "@metaobjectsdev/codegen-ts/generators";',
      'export default defineConfig({ outDir: "./src/generated", dialect: "postgres",',
      '  dbImport: "../db", generators: [entityFile()] });',
    ].join("\n"));

    const code = await genCommand({ cwd: join(root, "apps/ui") } as never);
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/cli/test/collection-routing.test.ts`
Expected: FAIL — exit code 2, `no metaobjects/ found`

**Note for the implementer:** `genCommand`'s real parameter shape is in `packages/cli/src/commands/gen.ts`; adjust the call to match it rather than the `as never` placeholder above.

- [ ] **Step 3: Route gen.ts**

Replace the `loadMemory(projectRoot, …)` call and its error branch:

```ts
let collection;
try {
  collection = await resolveCollection(projectRoot);
} catch (err) {
  log.error((err as Error).message);
  return 2;
}

let metadata;
try {
  metadata = await loadMemory(collection.configDir, {
    files: collection.files,
    ...(forgeConfig.providers !== undefined ? { providers: forgeConfig.providers } : {}),
  });
} catch (err) {
  log.error(`failed to load metadata: ${(err as Error).message}`);
  return 2;
}
```

The `existsSync(join(projectRoot, DEFAULT_METADATA_DIR))` hint branch is deleted — `resolveCollection` now raises `ERR_COLLECTION_NOT_FOUND` with a better message, and the comment above that branch (about not swallowing genuine ParseErrors) is satisfied by construction since the two failure modes are now separate `try` blocks.

- [ ] **Step 4: Route the remaining four sites**

- `export.ts:19` — replace `join(projectRoot, DEFAULT_METADATA_DIR)` with `(await resolveCollection(projectRoot)).files`, passing them to the loader.
- `docs.ts:292` — replace the `existsSync` guard with a `resolveCollection` call inside a `try`, reporting its error message.
- `docs.ts:529-530` — `sourceDirs` becomes the collection's `configDir`-relative source dirs; derive `seenBasenames` from the resolved sources rather than the literal.
- `index.ts:275` — the "is this a MetaObjects project?" probe becomes `await resolveCollection(cwd).then(() => true).catch(() => false)`.

- [ ] **Step 5: Run the full CLI suite for back-compat**

Run: `cd server/typescript && bun test packages/cli`
Expected: PASS — every pre-existing test unchanged. A project with `metaobjects/` at the root and no `sources` must behave exactly as before.

- [ ] **Step 6: Run the golden-output gate**

Run: `cd server/typescript && bun test packages/codegen-ts`
Expected: PASS — generated output byte-identical. (`codegen-ts/test/golden/` lives outside the package under change and is the gate that catches accidental output drift.)

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/cli/src server/typescript/packages/cli/test/collection-routing.test.ts
git commit -m "feat(cli): route gen/docs/export and the project probe through resolveCollection"
```

---

## Task 11: `detect-stack` routing and the nested-symlink fix

Closes the divergence where `detect-stack` and the loader disagree about the same tree.

**Files:**
- Modify: `server/typescript/packages/cli/src/lib/detect-stack.ts:24,31-69`
- Test: `server/typescript/packages/cli/test/detect-stack.test.ts` (extend if present; create if not)

**Interfaces:**
- Consumes: `resolveCollection` (T7)
- Produces: `resolveStack(cwd, overrides)` unchanged in signature; `hasRequirementNodes` now scans the resolved collection's files

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStack } from "../src/lib/detect-stack.js";

let root: string;
const write = (rel: string, body: string) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), body, "utf8");
};
const REQ = JSON.stringify({
  "metadata.root": { package: "acme", children: [
    { "requirement.functional": { name: "FR1", "@level": 1, "@status": "live" } }] },
});

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "metaobjects-detect-")); mkdirSync(join(root, ".git")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("detect-stack honours sources", () => {
  test("finds requirement nodes in a sources-declared tree", async () => {
    write("model/meta.req.json", REQ);
    write("apps/ui/.metaobjects/config.json", JSON.stringify({
      schema_version: 1, sources: [{ path: "../../model" }],
    }));
    const stack = await resolveStack(join(root, "apps/ui"), { servers: [], clients: [] });
    expect(stack.concerns).toContain("requirements");
  });

  test("finds requirement nodes behind a NESTED symlinked directory", async () => {
    write("real/meta.req.json", REQ);
    write("metaobjects/meta.a.json", "{}");
    symlinkSync(join(root, "real"), join(root, "metaobjects/linked"), "dir");
    const stack = await resolveStack(root, { servers: [], clients: [] });
    expect(stack.concerns).toContain("requirements");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd server/typescript && bun test packages/cli/test/detect-stack.test.ts`
Expected: FAIL — both. The first because `sources` is ignored; the second because `Dirent.isDirectory()` is `false` for a symlinked directory, so the walk never descends.

- [ ] **Step 3: Implement**

Make `resolveStack` and `probe` async. Replace `hasRequirementNodes(cwd)` with a scan over `(await resolveCollection(cwd)).files` — reading each file and testing for the `REQUIREMENT_NODE_MARKER` substring — wrapped in a `try`/`catch` that returns `false`, preserving the existing "this is a cheap heuristic, never throws" contract. Delete the `METADATA_DIR` constant and the bespoke `readdirSync` walk entirely; the symlink bug disappears with the walk, because `resolveSources` uses `stat` (which follows).

Update `resolveStack`'s callers to `await` it.

- [ ] **Step 4: Run to verify they pass**

Run: `cd server/typescript && bun test packages/cli`
Expected: PASS — both new tests, and every pre-existing detect-stack and agent-context test

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/cli/src/lib/detect-stack.ts server/typescript/packages/cli/test/detect-stack.test.ts
git commit -m "fix(cli): detect-stack reads the resolved collection, fixing nested-symlink blindness"
```

---

## Task 12: Per-command scope for `migrate` and `verify --db`

Without this, load-everything converts a real adopter's worst hazard — a `--from-db` migrate proposing to drop tables it does not model — from a discipline into an automation.

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/migrate.ts:260` and the expected-schema construction
- Test: `server/typescript/packages/cli/test/migrate-scope.test.ts` (create)

**Interfaces:**
- Consumes: `Collection.migrateScope` (T7), `matchesScope` (T1)

- [ ] **Step 1: Write the failing test**

```ts
// server/typescript/packages/cli/test/migrate-scope.test.ts
import { describe, test, expect } from "bun:test";
import { compileScope, matchesScope } from "@metaobjectsdev/sdk";
import { scopeExpectedSchema } from "../src/commands/migrate.js";

describe("migrate scope", () => {
  test("objects outside migrateScope are excluded from the expected schema", () => {
    const expected = {
      tables: [
        { name: "jobs", fqn: "acme::platform::Job" },
        { name: "matches", fqn: "arena::Match" },
      ],
      views: [],
    };
    const scoped = scopeExpectedSchema(expected as never, compileScope({ include: ["acme::platform::**"] }));
    expect(scoped.tables.map((t) => t.name)).toEqual(["jobs"]);
  });

  test("an undefined scope leaves the expected schema untouched", () => {
    const expected = { tables: [{ name: "jobs", fqn: "acme::platform::Job" }], views: [] };
    expect(scopeExpectedSchema(expected as never, undefined)).toEqual(expected as never);
  });

  test("matchesScope drives the decision (no second pattern implementation)", () => {
    const c = compileScope({ include: ["acme::platform::**"] });
    expect(matchesScope("acme::platform::Job", c)).toBe(true);
    expect(matchesScope("arena::Match", c)).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript && bun test packages/cli/test/migrate-scope.test.ts`
Expected: FAIL — `scopeExpectedSchema` is not exported

- [ ] **Step 3: Implement**

Export from `migrate.ts`:

```ts
/**
 * Narrow an expected schema to the objects inside `scope`. Tables and views whose
 * declaring object falls outside are dropped BEFORE the diff, so the migration
 * neither creates nor drops them — they belong to another owner.
 */
export function scopeExpectedSchema(
  expected: ExpectedSchema,
  scope: CompiledScope | undefined,
): ExpectedSchema {
  if (scope === undefined) return expected;
  return {
    ...expected,
    tables: expected.tables.filter((t) => matchesScope(t.fqn, scope)),
    views: expected.views.filter((v) => matchesScope(v.fqn, scope)),
  };
}
```

Call it on the expected schema immediately before `diff()`, passing `collection.migrateScope`.

**Note for the implementer:** confirm the real `ExpectedSchema` shape and whether its table/view entries already carry the declaring object's FQN. If they do not, thread it through at construction — do **not** re-derive an FQN from the SQL name, which is lossy.

- [ ] **Step 4: Run to verify it passes**

Run: `cd server/typescript && bun test packages/cli/test/migrate-scope.test.ts`
Expected: PASS

- [ ] **Step 5: Run the migrate suites**

Run: `cd server/typescript && bun test packages/migrate-ts && bun test packages/cli/test`
Expected: PASS. **A project with no `migrate.scope` must emit byte-identical migrations** — that is the back-compat guarantee for this task.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/cli/src/commands/migrate.ts server/typescript/packages/cli/test/migrate-scope.test.ts
git commit -m "feat(cli): migrate.scope narrows the expected schema so unowned tables are never touched"
```

---

## Task 13: Dogfood against the in-repo examples tree

Proves reach and scope against a real metadata tree with zero new content.

**Files:**
- Test: `server/typescript/packages/sdk/test/dogfood-examples.test.ts` (create)

**Interfaces:**
- Consumes: `resolveCollection` (T7), `matchesScope` (T1)

- [ ] **Step 1: Inspect the tree and read its declared package**

Run: `ls examples/advanced-modeling/metaobjects && head -5 examples/advanced-modeling/metaobjects/meta.catalog.yaml`

Record the actual `package:` value — the test below must assert against the real package, not a guess.

- [ ] **Step 2: Write the test**

```ts
// server/typescript/packages/sdk/test/dogfood-examples.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCollection } from "../src/collection.js";
import { loadMemory } from "../src/memory.js";

const EXAMPLES = resolve(import.meta.dir, "../../../../../examples/advanced-modeling/metaobjects");

let consumer: string;
beforeEach(() => {
  consumer = mkdtempSync(join(tmpdir(), "metaobjects-dogfood-"));
  mkdirSync(join(consumer, ".git"));
  mkdirSync(join(consumer, "apps/ui/.metaobjects"), { recursive: true });
  writeFileSync(
    join(consumer, "apps/ui/.metaobjects/config.json"),
    JSON.stringify({ schema_version: 1, sources: [{ path: EXAMPLES }] }),
    "utf8",
  );
});
afterEach(() => { rmSync(consumer, { recursive: true, force: true }); });

describe("dogfood: a consumer reaches the in-repo examples tree", () => {
  test("resolves every metadata file in it", async () => {
    const c = await resolveCollection(join(consumer, "apps/ui"));
    expect(c.files.length).toBeGreaterThanOrEqual(3);
    expect(c.files.every((f) => f.startsWith(EXAMPLES))).toBe(true);
  });

  test("the resolved set loads without errors", async () => {
    const c = await resolveCollection(join(consumer, "apps/ui"));
    const root = await loadMemory(c.configDir, { files: c.files });
    expect(root.children().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run it**

Run: `cd server/typescript && bun test packages/sdk/test/dogfood-examples.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add server/typescript/packages/sdk/test/dogfood-examples.test.ts
git commit -m "test(sdk): dogfood reach+scope against the in-repo examples metadata tree"
```

---

## Task 14: Documentation

**Files:**
- Modify: `server/typescript/packages/cli/README.md`
- Modify: `CLAUDE.md` (the "File organization" and "Other conventions" sections)
- Create: `docs/features/metadata-sources.md`

- [ ] **Step 1: Write the adopter guide**

`docs/features/metadata-sources.md` covering: `sources` as a set with `metaobjects/` as its default; the `path` source kind (relative to the declaring config, read in place, never installed); `scope` with `*`/`**` semantics and include/exclude; nearest-ancestor discovery and the `.git` boundary; `migrate.scope` and the rule that a `migrate` block belongs where the ledger lives; and a **vendoring** section stating that airgapped builds are served by copying a dependency into a directory and pointing a `path` at it — no separate mechanism needed.

Include one worked polyglot example (generic names only — no real project names).

- [ ] **Step 2: Update the CLI README**

Document `sources`, `scope`, and `migrate.scope` in the config reference, next to the existing `targets` documentation.

- [ ] **Step 3: Update CLAUDE.md**

In "File organization", state that `metaobjects/` is the **default** value of `sources` and never a requirement. In "Other conventions", add one line: metadata location is resolved via `resolveCollection()`; no code path may hardcode the directory name except `meta init`, which scaffolds it.

- [ ] **Step 4: Leak scan and commit**

```bash
grep -rniE "party|/home/" docs/features/metadata-sources.md && echo LEAK || echo clean
git add docs/features/metadata-sources.md server/typescript/packages/cli/README.md CLAUDE.md
git commit -m "docs: metadata sources, scope, discovery, and the vendoring workflow"
```

---

## Task 15: Full-suite verification

- [ ] **Step 1: Build the workspace**

Run, from the repository root: `bun run --filter '*' build`
Expected: success

- [ ] **Step 2: Typecheck the workspace**

Run: `bun run --filter '*' typecheck`
Expected: no errors. (`bun test` transpiles per-file and does not typecheck, so this is the gate that catches type breakage.)

- [ ] **Step 3: Run the server suite**

Run: `cd server/typescript && bun test`
Expected: PASS

- [ ] **Step 4: Run the client suites**

Run each `client/web/packages/<pkg>` suite.
Expected: PASS

- [ ] **Step 5: Confirm no hardcoded reads remain**

Run: `git grep -n "DEFAULT_METADATA_DIR" -- 'server/typescript/packages/cli/src/**' 'server/typescript/packages/sdk/src/**'`
Expected: hits only in `memory.ts` (the constant's definition plus the no-`files` fallback), `sources.ts` (`DEFAULT_SOURCES`), `collection.ts` (the default check), and `init.ts` (scaffolding). **Any hit in `docs.ts`, `export.ts`, `gen.ts`, `index.ts`, or `detect-stack.ts` is an unfinished task.**

- [ ] **Step 6: Commit any fixes and push**

```bash
git add -- <explicit paths>   # never `git add -A`
git commit -m "chore: phase-1 source resolution full-suite verification"
```

---

## Self-Review Notes

**Spec coverage.** §4.1 set semantics → T4, T8. §4.2 source kinds → T4, T5. §4.3 scope at output → T1, T2. §4.4 scope attachment incl. per-command → T12. §4.5 precedence → *not implemented in phase 1*: local-vs-dependency precedence only becomes reachable once `package` sources exist, and phase 1 rejects them (T4). §4.6/4.6.0 one authority → T7, T10, T11. §4.6.1 discovery → T6. §4.6.2 schema ownership → T12 (the `migrate.scope` half; the "ledger marks the owner" rule is documentation, T14). §4.7 conformance → T2, T8. §4.9 naming → T5. §8 symlink divergence → T11. §8 dogfood → T13.

**Deliberately deferred to the ports plan:** C#, Java, Kotlin and Python implementations; the Python `metadata:`-string → set widening; Java's `scope` element alongside legacy `<filters>`; the four error codes in `errors.py` and `ErrorCode.java`; port runners for the scope-conformance corpus.

**Deliberately out of scope:** the first-party shared metadata collection (separate deliverable); named `collection` references (§6); `url` sources; everything in §10 (issues #299–#306).

**Three places the implementer must verify against real code rather than trusting this plan:** the canonical serializer's export name (T8 Step 2), `genCommand`'s parameter shape (T10 Step 2), and whether `ExpectedSchema` entries carry a declaring FQN (T12 Step 3). Each is flagged inline.
