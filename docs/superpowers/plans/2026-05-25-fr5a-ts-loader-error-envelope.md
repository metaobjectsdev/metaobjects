# FR5a-ts — Loader error envelope + source-on-node (TypeScript) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TypeScript loader implements [ADR-0009](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md): every `MetaData` node carries a `source` field; every loader error raises an envelope with `code`, `message`, and `source: ErrorSource`; the `warnings` channel exists on `LoadResult`. Foundation for FR5b–FR5e.

**Architecture:** Three new modules (`source.ts`, `json-path.ts`, `semantic-diff.ts`) under `server/typescript/packages/metadata/src/` define the cross-port-aligned types and helpers. `MetaData` (`src/shared/meta-data.ts`) gains a `source: ErrorSource` field defaulting to `{ format: "code" }`. The JSON parser (`parser-core.ts` + `parser-json.ts`) threads a JSONPath stack during its tree walk and populates `node.source = { format: "json", files: [filePath], jsonPath }` at every node construction. `ParseError` (`errors.ts`) is extended to carry the full envelope; the 46 error-raising sites populate `source` from `node.source` (or from a parser-local stack mid-parse). `LoadResult` gains a `warnings: LoaderWarning[]` field (empty in FR5a — duplicate-declaration warnings ship in FR5c). Canonical JSON serializer continues to omit `source` (verified by test).

**Tech Stack:** TypeScript ESM, Bun test runner, the existing `@metaobjectsdev/metadata` package, `noUncheckedIndexedAccess` enabled. No new runtime deps.

**Spec / ADR:**
- ADR: `spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md`
- Cross-port FR: `docs/superpowers/specs/2026-05-25-fr5a-json-shape-loader-errors.md`

**Scope:**
- TS port only — Java / Python / C# adopt FR5a independently in their own sessions
- T2 optional fields (`suggestions[]`, `fixture`, `node`) **deferred** — spec says optional
- Cross-port conformance harness extension (rewriting `expected-errors.json` to `{errors[], warnings[]}` shape) **deferred** — current `[{code}]` form is forward-compatible (extra fields tolerated); harness rewrite is a follow-on FR coordinated across ports
- Warning emission sites (`WARN_DUPLICATE_DECLARATION` in overlay merge) **deferred to FR5c** — the channel exists in this FR, no sites populate it yet

---

## File structure

### Phase 1 — Foundation modules

**Created:**
- `server/typescript/packages/metadata/src/source.ts` (~80 LOC) — `ErrorSource` discriminated union + `Contributor`, `NodeContext`, `LoaderError`, `LoaderWarning` types. Single source of truth for the envelope.
- `server/typescript/packages/metadata/src/json-path.ts` (~80 LOC) — `JsonPathBuilder` class. Push/pop stack of segments; emits canonical strings via `.toString()`. Pure data, no parser knowledge.
- `server/typescript/packages/metadata/src/semantic-diff.ts` (~60 LOC) — `semanticDiff(a, b): boolean` per ADR-0009 algorithm. Pure compare; sorts attrs lexicographically, walks children as ordered sequences, excludes `source` from comparison.
- `server/typescript/packages/metadata/test/source.test.ts` — unit tests for the source module (mostly TS-shape tests since the types are the API).
- `server/typescript/packages/metadata/test/json-path.test.ts` (~10 tests) — `JsonPathBuilder` edge cases: root, simple keys, array indices, special-character keys (quoted bracket form), nested children, push-pop balance.
- `server/typescript/packages/metadata/test/semantic-diff.test.ts` (~8 tests) — equality, attr difference, child difference, source-excluded-from-diff, nested-structure equality, attr key-order independence.

### Phase 2 — `MetaData.source` field

**Modified:**
- `server/typescript/packages/metadata/src/shared/meta-data.ts` — add `source: ErrorSource` field (default `{ format: "code" }`); expose readonly getter via the existing pattern; no setter (loader paths assign directly during construction in Phase 3, OR a single internal `setSource()` method gated by a `// @internal` JSDoc tag).

**Modified tests:**
- `server/typescript/packages/metadata/test/meta-data.test.ts` (if it exists; otherwise add `meta-data-source.test.ts`) — programmatic construction defaults to `{ format: "code" }`; assigning a source persists; canonical JSON serializer excludes `source`.

### Phase 3 — Parser source threading

**Modified:**
- `server/typescript/packages/metadata/src/parser-core.ts` — accept `filePath: string` (or `sourceId: string`) as a constructor / function argument; instantiate a `JsonPathBuilder` at the entry; push/pop segments as the walk descends/ascends; populate every constructed node's `source = { format: "json", files: [filePath], jsonPath: <current> }`.
- `server/typescript/packages/metadata/src/parser-json.ts` — already a thin facade; pass the source-id through.
- `server/typescript/packages/metadata/src/loader/meta-data-loader.ts` — pass `source.id` (the FileSource / InMemoryStringSource id) into the JSON parser entry.

**Added tests:**
- `server/typescript/packages/metadata/test/parser-source-population.test.ts` — load a metadata file from `InMemoryStringSource`; assert `root.source.format === "json"`, `files[0]` matches the source id, `jsonPath` is sensible; assert nested nodes carry correctly-indexed jsonPaths.

### Phase 4 — `ParseError` envelope refactor

**Modified:**
- `server/typescript/packages/metadata/src/errors.ts` — extend `ParseError` constructor. The new public shape: `new ParseError(message, { code, source })` where `source: ErrorSource`. Legacy fields (`path?: string`, the OLD `source?: string`) are removed — they were superseded by the envelope's `jsonPath` and `files`. Backwards compatibility: the package was at 0.6.0 minor; this is a 0.7.0 minor bump per pre-1.0 conventions, and `ParseError` is an internal+exported-but-rarely-imported surface. Note in CHANGELOG breaking section.
- The 46 `new ParseError(...)` call sites across:
  - `parser-core.ts` (13) — use the parser's local JSONPath builder to construct the envelope inline
  - `parser-yaml.ts` (3) — for now, construct `{ format: "yaml", files: [...], jsonPath: <current> }`; `yamlPosition` is FR5b territory (deferred)
  - `parser-json.ts` (1)
  - `attr-schema-validate.ts` (7) — use `node.source` (populated by Phase 3)
  - `validation-passes.ts` (18) — use `node.source` (populated by Phase 3)
  - `subtype-rules.ts` (1)
  - `persistence/source/validate-source-roles.ts` (2)
  - `loader/meta-data-loader.ts` (1) — top-level loader; usually `{ format: "code", caller: "MetaDataLoader" }` or thread source from the failed parse phase

**Modified tests:**
- Existing tests assert on `error.code` mostly — these continue to pass.
- Add a new envelope-shape test: load malformed JSON; the resulting `ParseError` has `source.format === "json"`, `source.files` is populated, `source.jsonPath` points at the offending node.

### Phase 5 — Warnings channel

**Modified:**
- `server/typescript/packages/metadata/src/loader/meta-data-loader.ts` — `LoadResult` gains `warnings: LoaderWarning[]`. Always returned (empty array in FR5a).
- The `LoadResult` type definition (likely in `meta-data-loader.ts` or a sibling) — add the new field.

**Modified tests:**
- One assertion in the existing loader tests confirms `result.warnings` is an empty array (FR5a doesn't populate warnings; FR5c will).

### Phase 6 — Polish

**Modified:**
- `CHANGELOG.md` `[Unreleased]` — add an `### Added` entry for the envelope + a `### Changed` entry for the `ParseError` constructor change (note backwards-incompatible if anyone constructed `ParseError` themselves).
- `server/typescript/packages/metadata/README.md` — document the new error envelope shape + `node.source` field.

---

## Phase 1 — Foundation modules

### Task 1.1 — Write `source.ts`

**Files:**
- Create: `server/typescript/packages/metadata/src/source.ts`

- [ ] **Step 1: Write the test file**

Create `server/typescript/packages/metadata/test/source.test.ts`:

```ts
// Type-shape tests for the FR5a-ts ErrorSource discriminated union.
// These are mostly TS-typecheck assertions — the module exports types and a
// couple of constructor helpers.
import { describe, test, expect } from "bun:test";
import {
  type ErrorSource,
  type LoaderError,
  type LoaderWarning,
  codeSource,
} from "../src/source.js";

describe("ErrorSource", () => {
  test("json variant: format + files + jsonPath", () => {
    const s: ErrorSource = {
      format: "json",
      files: ["metaobjects/meta.json"],
      jsonPath: "$.metadata.root",
    };
    expect(s.format).toBe("json");
    expect(s.files).toEqual(["metaobjects/meta.json"]);
    expect(s.jsonPath).toBe("$.metadata.root");
  });

  test("code variant: format + optional caller", () => {
    const s: ErrorSource = { format: "code", caller: "TestBuilder" };
    expect(s.format).toBe("code");
    if (s.format === "code") expect(s.caller).toBe("TestBuilder");
  });

  test("codeSource() helper builds the canonical synthetic envelope", () => {
    expect(codeSource()).toEqual({ format: "code" });
    expect(codeSource("MyFactory")).toEqual({ format: "code", caller: "MyFactory" });
  });
});

describe("LoaderError envelope shape", () => {
  test("required fields: code, message, source", () => {
    const e: LoaderError = {
      code: "ERR_UNKNOWN_TYPE",
      message: "unknown type",
      source: { format: "code" },
    };
    expect(e.code).toBe("ERR_UNKNOWN_TYPE");
  });
});

describe("LoaderWarning envelope shape", () => {
  test("uses the same shape as LoaderError but warn-prefixed code", () => {
    const w: LoaderWarning = {
      code: "WARN_DUPLICATE_DECLARATION",
      message: "duplicate",
      source: { format: "code" },
    };
    expect(w.code.startsWith("WARN_")).toBe(true);
  });
});
```

- [ ] **Step 2: Run; confirm module-not-found failures**

```bash
cd server/typescript && bun test packages/metadata/test/source.test.ts
```

Expected: FAIL — `Cannot find module '../src/source.js'`.

- [ ] **Step 3: Write `source.ts`**

```ts
// server/typescript/packages/metadata/src/source.ts
//
// FR5a — Loader error envelope + source-on-node (ADR-0009).
//
// Cross-port-aligned types: every metaobjects port emits the same envelope
// shape so a tool consuming errors from multiple language ports can compare
// them byte-identically.

/** Discriminated union over the provenance variants a metadata node or error
 *  can carry. See ADR-0009 §Decision for the canonical shape. */
export type ErrorSource =
  | { format: "json"; files: [string]; jsonPath: string }
  | { format: "yaml"; files: [string]; jsonPath: string;
      yamlPosition?: { line: number; col: number } }
  | { format: "merged"; files: string[]; jsonPath: string;
      contributors: Contributor[] }
  | { format: "resolved"; files: string[]; jsonPath?: string;
      referrer?: string; target?: string }
  | { format: "database"; dbLocation: { table: string; id: string };
      jsonPath?: string }
  | { format: "code"; caller?: string };

export interface Contributor {
  file: string;
  role: "overlay-base" | "overlay-extension" | "extends-base" | "extends-extension";
}

export interface NodeContext {
  type?: string;
  subtype?: string;
  name?: string;
  fqn?: string;
}

/** Envelope shape every loader error conforms to. */
export interface LoaderError {
  // REQUIRED — conformance-enforced.
  code: string;
  message: string;
  source: ErrorSource;
  // RECOMMENDED — optional per ADR-0009 §What ports are NOT required to do.
  suggestions?: string[];
  fixture?: string;
  node?: NodeContext;
}

/** Warning envelope — same shape as LoaderError but a `WARN_*` code. */
export interface LoaderWarning {
  code: string;
  message: string;
  source: ErrorSource;
  suggestions?: string[];
  fixture?: string;
  node?: NodeContext;
}

/** Canonical synthetic envelope for programmatic / test-constructed nodes.
 *  `caller` is an optional human label (e.g. "QueriesTest.makePost"). */
export function codeSource(caller?: string): ErrorSource {
  return caller ? { format: "code", caller } : { format: "code" };
}
```

- [ ] **Step 4: Run; confirm tests pass**

```bash
cd server/typescript && bun test packages/metadata/test/source.test.ts
```

Expected: PASS, 5 tests.

### Task 1.2 — Write `json-path.ts`

**Files:**
- Create: `server/typescript/packages/metadata/src/json-path.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/typescript/packages/metadata/test/json-path.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { JsonPathBuilder } from "../src/json-path.js";

describe("JsonPathBuilder", () => {
  test("root is '$' on an empty builder", () => {
    expect(new JsonPathBuilder().toString()).toBe("$");
  });

  test("simple keys use dot notation when they match identifier rule", () => {
    const b = new JsonPathBuilder();
    b.pushKey("metadata"); b.pushKey("root");
    expect(b.toString()).toBe("$.metadata.root");
  });

  test("special-character keys use bracket-quoted form", () => {
    const b = new JsonPathBuilder();
    b.pushKey("my-package");
    expect(b.toString()).toBe("$['my-package']");
  });

  test("digits-leading keys use bracket form", () => {
    const b = new JsonPathBuilder();
    b.pushKey("123foo");
    expect(b.toString()).toBe("$['123foo']");
  });

  test("array index uses [N] notation", () => {
    const b = new JsonPathBuilder();
    b.pushKey("children");
    b.pushIndex(2);
    expect(b.toString()).toBe("$.children[2]");
  });

  test("nested children/indexes compose correctly", () => {
    const b = new JsonPathBuilder();
    b.pushKey("metadata");
    b.pushKey("root");
    b.pushKey("children");
    b.pushIndex(0);
    b.pushKey("object.entity");
    expect(b.toString()).toBe("$.metadata.root.children[0]['object.entity']");
  });

  test("pop reverses push", () => {
    const b = new JsonPathBuilder();
    b.pushKey("a"); b.pushKey("b"); b.pop();
    expect(b.toString()).toBe("$.a");
    b.pop();
    expect(b.toString()).toBe("$");
  });

  test("at-prefixed attr key uses bracket-quoted form", () => {
    const b = new JsonPathBuilder();
    b.pushKey("@values");
    expect(b.toString()).toBe("$['@values']");
  });

  test("pop on empty builder is a no-op (defensive)", () => {
    const b = new JsonPathBuilder();
    b.pop();
    expect(b.toString()).toBe("$");
  });

  test("toString() does not mutate the builder", () => {
    const b = new JsonPathBuilder();
    b.pushKey("x");
    b.toString(); b.toString();
    expect(b.toString()).toBe("$.x");
  });
});
```

- [ ] **Step 2: Run; confirm failures**

```bash
cd server/typescript && bun test packages/metadata/test/json-path.test.ts
```

Expected: FAIL — `Cannot find module '../src/json-path.js'`.

- [ ] **Step 3: Write `json-path.ts`**

```ts
// server/typescript/packages/metadata/src/json-path.ts
//
// FR5a / ADR-0009 — Canonical JSONPath builder.
//
// Construction rules (cross-port-aligned):
//   - Root is `$`.
//   - Object keys matching /^[A-Za-z_][A-Za-z0-9_]*$/ use dot notation: `.foo`.
//   - All other keys use single-quoted bracket form: `['my-key']`, `['@attr']`.
//   - Array indices use bracket form: `[N]`.
//   - No trailing dots, no whitespace.

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Segment =
  | { kind: "key"; value: string }
  | { kind: "index"; value: number };

export class JsonPathBuilder {
  private readonly segments: Segment[] = [];

  pushKey(key: string): void {
    this.segments.push({ kind: "key", value: key });
  }

  pushIndex(idx: number): void {
    this.segments.push({ kind: "index", value: idx });
  }

  pop(): void {
    this.segments.pop();
  }

  toString(): string {
    let out = "$";
    for (const seg of this.segments) {
      if (seg.kind === "index") {
        out += `[${seg.value}]`;
      } else if (IDENT_RE.test(seg.value)) {
        out += `.${seg.value}`;
      } else {
        out += `['${seg.value.replace(/'/g, "\\'")}']`;
      }
    }
    return out;
  }
}
```

- [ ] **Step 4: Run; confirm tests pass**

```bash
cd server/typescript && bun test packages/metadata/test/json-path.test.ts
```

Expected: PASS, 10 tests.

### Task 1.3 — Write `semantic-diff.ts`

**Files:**
- Create: `server/typescript/packages/metadata/src/semantic-diff.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/typescript/packages/metadata/test/semantic-diff.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { semanticDiff } from "../src/semantic-diff.js";

// MetaData-shaped fixtures using a stripped representation: just attrs +
// children + reserved keys. The diff algorithm doesn't actually need the
// MetaData class — it operates on canonical-JSON-shaped trees.

describe("semanticDiff", () => {
  test("identical empty trees: no diff", () => {
    expect(semanticDiff({}, {})).toBe(false);
  });

  test("identical attrs in different key order: no diff", () => {
    expect(semanticDiff({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  });

  test("differing attr values: diff", () => {
    expect(semanticDiff({ a: 1 }, { a: 2 })).toBe(true);
  });

  test("differing child counts: diff", () => {
    expect(semanticDiff({ children: [{ a: 1 }] }, { children: [] })).toBe(true);
  });

  test("identical children in same order: no diff", () => {
    expect(semanticDiff(
      { children: [{ a: 1 }, { b: 2 }] },
      { children: [{ a: 1 }, { b: 2 }] },
    )).toBe(false);
  });

  test("source field excluded from diff", () => {
    expect(semanticDiff(
      { a: 1, source: { format: "json", files: ["x"], jsonPath: "$" } },
      { a: 1, source: { format: "code" } },
    )).toBe(false);
  });

  test("nested structure: no diff when deeply equal", () => {
    expect(semanticDiff(
      { x: { y: { z: 1 } } },
      { x: { y: { z: 1 } } },
    )).toBe(false);
  });

  test("nested structure: diff when leaf differs", () => {
    expect(semanticDiff(
      { x: { y: { z: 1 } } },
      { x: { y: { z: 2 } } },
    )).toBe(true);
  });
});
```

- [ ] **Step 2: Run; confirm failures**

- [ ] **Step 3: Write `semantic-diff.ts`**

```ts
// server/typescript/packages/metadata/src/semantic-diff.ts
//
// FR5a / ADR-0009 — Cross-port-aligned semantic-equality compare for metadata
// trees. Returns `true` if the two inputs differ in any semantically-meaningful
// way (excluding `source`, which is loader output).
//
// Algorithm (ADR-0009 §semantic_diff):
//   1. Sort attrs lexicographically; compare attr-by-attr; values by canonical
//      structural equality (key-order independent, whitespace-insensitive).
//   2. Children are compared as ordered sequences.
//   3. Reserved structural keys (name, package, extends, abstract, overlay,
//      isArray, value) participate like attrs.
//   4. `source` excluded from the diff.

type Tree = Record<string, unknown>;

const EXCLUDED = new Set(["source"]);

function isObject(v: unknown): v is Tree {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!equal(a[i], b[i])) return false;
    }
    return true;
  }
  if (isObject(a) && isObject(b)) {
    const aKeys = Object.keys(a).filter((k) => !EXCLUDED.has(k)).sort();
    const bKeys = Object.keys(b).filter((k) => !EXCLUDED.has(k)).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      if (aKeys[i] !== bKeys[i]) return false;
      if (!equal(a[aKeys[i]!], b[bKeys[i]!])) return false;
    }
    return true;
  }
  return false;
}

/** Returns `true` if the inputs differ in any semantically-meaningful way. */
export function semanticDiff(a: Tree, b: Tree): boolean {
  return !equal(a, b);
}
```

- [ ] **Step 4: Run; confirm tests pass**

```bash
cd server/typescript && bun test packages/metadata/test/semantic-diff.test.ts
```

Expected: PASS, 8 tests.

### Task 1.4 — Commit Phase 1

- [ ] **Step 1: Stage + commit**

```bash
git add \
  server/typescript/packages/metadata/src/source.ts \
  server/typescript/packages/metadata/src/json-path.ts \
  server/typescript/packages/metadata/src/semantic-diff.ts \
  server/typescript/packages/metadata/test/source.test.ts \
  server/typescript/packages/metadata/test/json-path.test.ts \
  server/typescript/packages/metadata/test/semantic-diff.test.ts

git commit -m "$(cat <<'EOF'
feat(metadata): FR5a-ts foundation modules — source, json-path, semantic-diff

Three new modules implementing the ADR-0009 substrate:

- source.ts: ErrorSource discriminated union, Contributor, NodeContext,
  LoaderError + LoaderWarning envelope types, codeSource() helper.
- json-path.ts: canonical JSONPath builder. Push/pop segments; emits
  byte-identical output across language ports via the canonical rules
  (dot for /^[A-Za-z_][A-Za-z0-9_]*$/, bracket for everything else,
  [N] for array indices, $ root).
- semantic-diff.ts: boolean diff per ADR-0009. Key-order independent
  attr compare, ordered-sequence child compare, source-excluded. FR5c
  will use this in overlay-merge duplicate detection.

23 new unit tests cover the three modules.

No load-pipeline integration yet — Phase 2 adds the `source` field to
MetaData; Phase 3 threads it through the JSON parser.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 2 — `MetaData.source` field

### Task 2.1 — Add `source` to `MetaData` base + tests

**Files:**
- Modify: `server/typescript/packages/metadata/src/shared/meta-data.ts`

- [ ] **Step 1: Write failing tests**

Append to `server/typescript/packages/metadata/test/meta-data.test.ts` (or create if it doesn't exist):

```ts
import { describe, test, expect } from "bun:test";
import { metaRoot, metaObject, metaField } from "./_meta-build.js";
import { FIELD_SUBTYPE_STRING, OBJECT_SUBTYPE_ENTITY } from "../src/index.js";

describe("MetaData.source (FR5a)", () => {
  test("programmatic construction defaults source to { format: 'code' }", () => {
    const f = metaField(FIELD_SUBTYPE_STRING, "name");
    expect(f.source).toEqual({ format: "code" });
  });

  test("source persists when assigned via setSource()", () => {
    const o = metaObject(OBJECT_SUBTYPE_ENTITY, "User");
    o.setSource({ format: "json", files: ["x.json"], jsonPath: "$.foo" });
    expect(o.source).toEqual({ format: "json", files: ["x.json"], jsonPath: "$.foo" });
  });

  test("source is excluded from canonical JSON serialization", () => {
    const { canonicalSerialize } = await import("../src/index.js");
    const root = metaRoot();
    const o = metaObject(OBJECT_SUBTYPE_ENTITY, "User");
    o.setSource({ format: "json", files: ["x.json"], jsonPath: "$" });
    root.addChild(o);
    const ser = canonicalSerialize(root);
    expect(JSON.stringify(ser)).not.toContain("source");
    expect(JSON.stringify(ser)).not.toContain("jsonPath");
  });
});
```

(If `canonicalSerialize` lives under a different name, find via `grep -rn "export.*canonicalSerialize" server/typescript/packages/metadata/src/`.)

- [ ] **Step 2: Run; confirm failures**

- [ ] **Step 3: Add `source` to `MetaData`**

In `server/typescript/packages/metadata/src/shared/meta-data.ts`, find the existing field declarations and add:

```ts
import type { ErrorSource } from "../source.js";

// Inside the class body, alongside other private/instance fields:

  /** ADR-0009 provenance. Always populated; defaults to `{ format: "code" }`
   *  for programmatic construction. Loader phases overwrite via setSource(). */
  private _source: ErrorSource = { format: "code" };

  get source(): ErrorSource {
    return this._source;
  }

  /** Loader-internal: assign provenance. Called by parser and merge phases. */
  setSource(s: ErrorSource): void {
    this._source = s;
  }
```

(Adjust the import path if `source.ts` lives at a different relative depth.)

- [ ] **Step 4: Verify canonical serializer doesn't accidentally serialize source**

Search for any `serializer-json.ts` / `object-serializer.ts` code that iterates fields:

```bash
grep -n "source\|_source" server/typescript/packages/metadata/src/serializer-json.ts server/typescript/packages/metadata/src/object-serializer.ts 2>/dev/null
```

If a serializer iterates owned fields, it should NOT include `_source` (which is a private field — it shouldn't be in the iteration anyway, but verify the existing serializer is opt-in / whitelist-based, not iterate-all).

- [ ] **Step 5: Run the tests**

```bash
cd server/typescript && bun test packages/metadata/test/meta-data.test.ts
```

Expected: PASS, 3 new tests + existing tests.

- [ ] **Step 6: Run the full metadata suite**

```bash
cd server/typescript && bun test packages/metadata/
```

Expected: green. The conformance corpus continues to pass (canonical-JSON round-trip unaffected because `source` is excluded).

### Task 2.2 — Commit Phase 2

- [ ] **Step 1: Stage + commit**

```bash
git add \
  server/typescript/packages/metadata/src/shared/meta-data.ts \
  server/typescript/packages/metadata/test/meta-data.test.ts

git commit -m "$(cat <<'EOF'
feat(metadata): FR5a-ts — MetaData carries a source provenance field

Every metadata node now has a `source: ErrorSource` field per ADR-0009.
Defaults to `{ format: "code" }` for programmatic construction (tests,
factories, in-code builders). Loader phases overwrite via setSource().

Phase 3 threads source through the JSON parser so nodes loaded from
disk get `{ format: "json", files: [...], jsonPath: "..." }` populated.

Canonical-JSON serializer continues to exclude `source` — provenance is
loader-derived state, not metadata. Conformance round-trip fixtures
unaffected.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 3 — Parser source threading

### Task 3.1 — Read the parser-core to find the right injection points

**Goal of this task:** understand the existing tree-walk shape before modifying it. Implementer reads + summarizes; no code changes.

- [ ] **Step 1: Read `parser-core.ts`**

```bash
wc -l server/typescript/packages/metadata/src/parser-core.ts
```

Then read the top 60 lines + the main tree-walk function (likely named something like `parseMetaTree`, `parseChildren`, or `parseNode`).

- [ ] **Step 2: Identify the JSONPath injection point**

The implementer must locate:
- The entry function the loader calls (probably `parseMetaTree(json, opts)` or similar)
- The recursive descent function(s) that walk children
- The point where a `MetaData` node is constructed (probably via a registry factory call)

Note these in the task report. The implementer chooses the smallest correct surface for threading — typically: pass a `JsonPathBuilder` (or `sourceCtx: { jsonPath: JsonPathBuilder; files: [string] }`) as a parameter to recursive helpers; push/pop around each descent.

- [ ] **Step 3: Identify the loader call site**

```bash
grep -n "parseMetaTree\|parseRoot\|parseFromJson" server/typescript/packages/metadata/src/loader/meta-data-loader.ts
```

Find where `MetaDataLoader.load()` invokes the parser. This is where `source.id` (the FileSource / InMemoryStringSource id) is available.

### Task 3.2 — Thread JSONPath + source-id through the parser

**Files:**
- Modify: `server/typescript/packages/metadata/src/parser-core.ts`
- Modify: `server/typescript/packages/metadata/src/parser-json.ts` (probably; thin facade)
- Modify: `server/typescript/packages/metadata/src/loader/meta-data-loader.ts` — pass source.id into the parser

- [ ] **Step 1: Write failing tests**

Create `server/typescript/packages/metadata/test/parser-source-population.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";

describe("FR5a — JSON parser populates node.source", () => {
  test("root node carries format=json + files=[sourceId] + jsonPath", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              { "object.entity": { name: "User", children: [{ "field.string": { name: "id" } }, { "identity.primary": { "@fields": "id" } }] } },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    expect(res.root.source.format).toBe("json");
    if (res.root.source.format === "json") {
      expect(res.root.source.files).toEqual(["meta.json"]);
      // The root's jsonPath should be the location of the metadata.root key.
      // Exact form is implementation-defined but should include "metadata.root".
      expect(res.root.source.jsonPath).toContain("metadata");
    }
  });

  test("nested object's source has correctly-indexed jsonPath", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [
              { "object.entity": { name: "User", children: [{ "field.string": { name: "id" } }, { "identity.primary": { "@fields": "id" } }] } },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    const user = res.root.objects().find((o) => o.name === "User");
    expect(user).toBeDefined();
    expect(user!.source.format).toBe("json");
    if (user!.source.format === "json") {
      expect(user!.source.jsonPath).toContain("children[0]");
      expect(user!.source.jsonPath).toContain("object.entity");
    }
  });

  test("multiple sources: each node's files[0] reflects its origin", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({ "metadata.root": { package: "acme", children: [{ "object.entity": { name: "A", children: [{ "field.string": { name: "x" } }, { "identity.primary": { "@fields": "x" } }] } }] } }),
        { id: "file-a.json", format: "json" },
      ),
      new InMemoryStringSource(
        JSON.stringify({ "metadata.root": { package: "acme", children: [{ "object.entity": { name: "B", children: [{ "field.string": { name: "y" } }, { "identity.primary": { "@fields": "y" } }] } }] } }),
        { id: "file-b.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    const a = res.root.objects().find((o) => o.name === "A");
    const b = res.root.objects().find((o) => o.name === "B");
    if (a && a.source.format === "json") expect(a.source.files).toEqual(["file-a.json"]);
    if (b && b.source.format === "json") expect(b.source.files).toEqual(["file-b.json"]);
  });
});
```

- [ ] **Step 2: Run; confirm failures**

```bash
cd server/typescript && bun test packages/metadata/test/parser-source-population.test.ts
```

Expected: fail — source still defaults to `{ format: "code" }` for nodes loaded from JSON.

- [ ] **Step 3: Modify the parser to thread JSONPath + sourceId**

This is the implementation step — the actual code shape depends on what Task 3.1 found. The implementer should:

1. Add a `SourceCtx` type at the top of `parser-core.ts`:
   ```ts
   import { JsonPathBuilder } from "./json-path.js";
   interface SourceCtx { sourceId: string; path: JsonPathBuilder; }
   ```
2. Make the recursive descent functions accept `ctx: SourceCtx`.
3. Push/pop around each descent into a child key or array index.
4. At every `MetaData` node construction, immediately call:
   ```ts
   node.setSource({ format: "json", files: [ctx.sourceId], jsonPath: ctx.path.toString() });
   ```
5. At the loader entry (`meta-data-loader.ts`), pass `source.id` from the FileSource / InMemoryStringSource as the `sourceId`.

The exact diff depends on the parser's existing shape. Keep the change minimal — don't refactor unrelated code.

- [ ] **Step 4: Run; confirm tests pass**

```bash
cd server/typescript && bun test packages/metadata/test/parser-source-population.test.ts
```

Expected: PASS, 3 tests.

- [ ] **Step 5: Run the full metadata test suite**

```bash
cd server/typescript && bun test packages/metadata/
```

Expected: green; no conformance regression (the canonical-JSON serializer still excludes source).

### Task 3.3 — Commit Phase 3

- [ ] **Step 1: Stage + commit**

```bash
git add \
  server/typescript/packages/metadata/src/parser-core.ts \
  server/typescript/packages/metadata/src/parser-json.ts \
  server/typescript/packages/metadata/src/loader/meta-data-loader.ts \
  server/typescript/packages/metadata/test/parser-source-population.test.ts

git commit -m "$(cat <<'EOF'
feat(metadata): FR5a-ts — JSON parser populates node.source

parser-core threads a JsonPathBuilder through its recursive descent.
Every constructed metadata node calls setSource({ format: "json",
files: [sourceId], jsonPath }) — where sourceId is the FileSource or
InMemoryStringSource id from the loader entry.

Phase 4 refactors ParseError to carry the same envelope shape and
populates source from node.source at the 46 error-raising sites.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 4 — `ParseError` envelope refactor

### Task 4.1 — Extend `ParseError` to carry the envelope

**Files:**
- Modify: `server/typescript/packages/metadata/src/errors.ts`

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/metadata/test/parse-error-envelope.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, ParseError } from "../src/index.js";

describe("FR5a — ParseError carries an ErrorSource envelope", () => {
  test("malformed JSON: error.source has format='json', files, jsonPath", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            children: [
              { "object.entity": { name: "User", children: [{ "field.unknownXyz": { name: "x" } }, { "identity.primary": { "@fields": "x" } }] } },
            ],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors.length).toBeGreaterThan(0);
    const err = res.errors[0]!;
    expect(err.code).toBeDefined();
    expect(err.source).toBeDefined();
    expect(err.source.format).toBe("json");
    if (err.source.format === "json") {
      expect(err.source.files).toEqual(["meta.json"]);
      expect(err.source.jsonPath).toContain("$");
    }
  });

  test("programmatic ParseError construction accepts ErrorSource", () => {
    const e = new ParseError("test", {
      code: "ERR_BAD_ATTR_VALUE",
      source: { format: "code", caller: "unit-test" },
    });
    expect(e.source.format).toBe("code");
  });
});
```

- [ ] **Step 2: Run; confirm failures**

Expected: failures — current `ParseError` constructor signature does not accept `source: ErrorSource`; it accepts the legacy `source?: string`.

- [ ] **Step 3: Refactor `ParseError`**

In `server/typescript/packages/metadata/src/errors.ts`, replace the existing `ParseError` class with:

```ts
import type { ErrorSource, LoaderError } from "./source.js";

// ... existing ERROR_CODES + ErrorCode type ...

export class ParseError extends Error implements LoaderError {
  readonly code: ErrorCode;
  readonly source: ErrorSource;
  // Future-compatible optional fields per ADR-0009 §RECOMMENDED:
  readonly suggestions?: string[];
  readonly fixture?: string;
  readonly node?: {
    type?: string;
    subtype?: string;
    name?: string;
    fqn?: string;
  };

  constructor(
    message: string,
    opts: { code: ErrorCode; source: ErrorSource; suggestions?: string[]; fixture?: string; node?: NonNullable<ParseError["node"]> },
  ) {
    super(message);
    this.name = "ParseError";
    this.code = opts.code;
    this.source = opts.source;
    if (opts.suggestions !== undefined) (this as { suggestions?: string[] }).suggestions = opts.suggestions;
    if (opts.fixture !== undefined) (this as { fixture?: string }).fixture = opts.fixture;
    if (opts.node !== undefined) (this as { node?: ParseError["node"] }).node = opts.node;
  }
}
```

Key changes from the pre-FR5a shape:
- `source` is required (was `source?: string`)
- `source: ErrorSource` (was `string`)
- `code` is required (was `code?: ErrorCode`)
- Legacy `path?: string` field dropped — superseded by `source.jsonPath`
- Optional `suggestions[]`, `fixture`, `node` fields per ADR-0009 (FR5a doesn't populate them; FR5b–FR5e may)

- [ ] **Step 4: Migrate the 46 `new ParseError(...)` call sites**

This is the bulk of the phase. Each site needs:
- A `source: ErrorSource` constructor argument
- Sites in `parser-core.ts` / `parser-yaml.ts` / `parser-json.ts` use the parser's local JsonPathBuilder
- Sites in `attr-schema-validate.ts` / `validation-passes.ts` / `subtype-rules.ts` / `validate-source-roles.ts` use `node.source` (populated by Phase 3)
- Sites in `loader/meta-data-loader.ts` use either the failed source's id (for parse failures) or `codeSource("MetaDataLoader")` (for synthesis errors)

Use grep to find all sites:

```bash
grep -rn "new ParseError" server/typescript/packages/metadata/src/ | grep -v dist
```

Then walk through each file, threading source. For sites where the context doesn't carry a node reference, fall back to `codeSource(callerLabel)`.

After every file is updated, run:

```bash
cd server/typescript && bun test packages/metadata/
```

Expected: all metadata tests green.

- [ ] **Step 5: Run the full server suite**

```bash
cd server/typescript && bun test
```

Expected: green. Any test asserting on the old `ParseError`-via-string-source field needs updating to the new envelope shape.

If any test breaks because it constructs `new ParseError(msg, { source: "x" })` (the old shape), update it to `new ParseError(msg, { code: "ERR_*", source: { format: "json", files: ["x"], jsonPath: "$" } })` or `codeSource("test")`.

### Task 4.2 — Commit Phase 4

- [ ] **Step 1: Stage + commit**

```bash
git add \
  server/typescript/packages/metadata/src/errors.ts \
  server/typescript/packages/metadata/src/parser-core.ts \
  server/typescript/packages/metadata/src/parser-json.ts \
  server/typescript/packages/metadata/src/core/parser-yaml.ts \
  server/typescript/packages/metadata/src/attr-schema-validate.ts \
  server/typescript/packages/metadata/src/loader/validation-passes.ts \
  server/typescript/packages/metadata/src/loader/meta-data-loader.ts \
  server/typescript/packages/metadata/src/subtype-rules.ts \
  server/typescript/packages/metadata/src/persistence/source/validate-source-roles.ts \
  server/typescript/packages/metadata/test/parse-error-envelope.test.ts

git commit -m "$(cat <<'EOF'
feat(metadata): FR5a-ts — ParseError carries the ADR-0009 envelope

ParseError refactored to implement LoaderError:

- code: ErrorCode      (required, was optional)
- source: ErrorSource  (required, was optional string)
- suggestions[]/fixture/node — optional per ADR-0009 (deferred FR5b-e)

Dropped the legacy `path?: string` field — superseded by `source.jsonPath`.

46 call sites updated across parser-core, parser-yaml, parser-json,
attr-schema-validate, validation-passes, meta-data-loader, subtype-rules,
validate-source-roles. Parse-phase sites use the parser's JsonPathBuilder;
validation-phase sites use node.source (populated in Phase 3).

The public ParseError constructor signature changes: was
`new ParseError(msg, { code?, source?, path? })`, now
`new ParseError(msg, { code, source })`. Tracked as a breaking change in
the 0.7.0 CHANGELOG.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 5 — Warnings channel

### Task 5.1 — Add `warnings: LoaderWarning[]` to `LoadResult`

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/meta-data-loader.ts`
- Modify: `server/typescript/packages/metadata/src/index.ts` (export LoaderWarning if not already)

- [ ] **Step 1: Locate the `LoadResult` definition**

```bash
grep -n "LoadResult\|export interface.*Result" server/typescript/packages/metadata/src/loader/meta-data-loader.ts
```

Read the existing type to confirm its current shape (likely `{ root: MetaRoot; errors: ParseError[] }`).

- [ ] **Step 2: Write the failing test**

Append to existing loader test file (or create `server/typescript/packages/metadata/test/loader-warnings.test.ts`):

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "../src/index.js";

describe("FR5a — LoadResult.warnings", () => {
  test("clean load returns warnings as an empty array", async () => {
    const res = await new MetaDataLoader().load([
      new InMemoryStringSource(
        JSON.stringify({
          "metadata.root": {
            package: "acme",
            children: [{ "object.entity": { name: "User", children: [{ "field.string": { name: "id" } }, { "identity.primary": { "@fields": "id" } }] } }],
          },
        }),
        { id: "meta.json", format: "json" },
      ),
    ]);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
    expect(Array.isArray(res.warnings)).toBe(true);
  });
});
```

- [ ] **Step 3: Add the field**

In `server/typescript/packages/metadata/src/loader/meta-data-loader.ts`:

1. Add `import type { LoaderWarning } from "../source.js";`
2. Update the `LoadResult` type to include `warnings: LoaderWarning[]`
3. Initialize `warnings: []` at the start of `load()` and return it in the result

```ts
interface LoadResult {
  root: MetaRoot;
  errors: ParseError[];
  warnings: LoaderWarning[];
}
```

(FR5a doesn't populate the warnings array — FR5c does, when overlay-merge detects duplicate declarations.)

- [ ] **Step 4: Run; confirm tests pass**

```bash
cd server/typescript && bun test packages/metadata/test/loader-warnings.test.ts
cd server/typescript && bun test packages/metadata/
```

Expected: green; the new test passes; existing loader tests pass (assuming they tolerate the extra field — they read by destructuring `{ root, errors }`, which still works).

### Task 5.2 — Commit Phase 5

- [ ] **Step 1: Stage + commit**

```bash
git add \
  server/typescript/packages/metadata/src/loader/meta-data-loader.ts \
  server/typescript/packages/metadata/src/index.ts \
  server/typescript/packages/metadata/test/loader-warnings.test.ts

git commit -m "$(cat <<'EOF'
feat(metadata): FR5a-ts — LoadResult.warnings channel (empty in FR5a)

LoadResult gains a warnings: LoaderWarning[] field per ADR-0009. The
channel exists; no sites populate it in FR5a (warnings are emitted
during overlay-merge's duplicate-declaration detection, which is FR5c).

A clean load returns an empty warnings array — never undefined; consumers
don't write nullish checks.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Phase 6 — Polish

### Task 6.1 — CHANGELOG entry

**Files:**
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Extend `[Unreleased]` section**

Add to the existing `### Added` block (or create one if not present):

```markdown
- **Loader error envelope + source-on-node** (`@metaobjectsdev/metadata`) —
  per [ADR-0009](spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md),
  every `MetaData` node now carries a `source: ErrorSource` provenance field
  (`{ format: "json", files: [...], jsonPath: "..." }` for loaded nodes;
  `{ format: "code" }` for programmatically constructed). `ParseError` now
  conforms to the cross-port `LoaderError` schema: required `code`, required
  `message`, required `source` envelope. New `LoadResult.warnings: LoaderWarning[]`
  channel (empty in 0.7.0; populated by future overlay-merge detection in FR5c).
  Foundation for FR5b (YAML positions), FR5c (multi-file merge attribution),
  FR5d (reference-resolution errors), FR5e (database-source errors).
```

And append to the `### Changed` block (the FR2 breaking entry):

```markdown
- **BREAKING (metadata):** `ParseError` constructor signature changed. Was
  `new ParseError(msg, { code?, source?: string, path? })`; now
  `new ParseError(msg, { code, source: ErrorSource })`. Direct construction
  outside the metadata package is rare (loader-internal API), but anyone
  catching + repackaging a `ParseError` reads `.source` as the new envelope
  type, not a string. Legacy `error.path` is gone — read `error.source.jsonPath`
  instead.
```

### Task 6.2 — Metadata README

**Files:**
- Modify: `server/typescript/packages/metadata/README.md`

- [ ] **Step 1: Add a "Loader errors" section**

Append (or insert near existing error-related content):

```markdown
## Loader errors (FR5a)

Every loader error conforms to the cross-port `LoaderError` envelope
(ADR-0009):

\`\`\`ts
interface LoaderError {
  code: string;            // ERR_UNKNOWN_TYPE, ERR_BAD_ATTR_VALUE, ...
  message: string;
  source: ErrorSource;     // always populated
}

type ErrorSource =
  | { format: "json"; files: [string]; jsonPath: string }
  | { format: "yaml"; files: [string]; jsonPath: string; yamlPosition?: { line, col } }
  | { format: "merged"; files: string[]; jsonPath: string; contributors: Contributor[] }
  | { format: "resolved"; files: string[]; jsonPath?: string; referrer?: string; target?: string }
  | { format: "database"; dbLocation: { table, id }; jsonPath?: string }
  | { format: "code"; caller?: string };
\`\`\`

Every `MetaData` node also carries a populated `source` field, so
post-load consumers (drift detection, MCP, debug tools) can answer
"where did this node come from?" without an extra lookup table.

See [ADR-0009](../../../spec/decisions/ADR-0009-loader-error-envelope-and-source-on-node.md)
for the full schema and the FR5 family for the per-error-class rollout
plan (5a JSON shape, 5b YAML positions, 5c multi-file merge attribution,
5d reference resolution, 5e database sources).
```

(Adjust the relative path to ADR-0009 based on the README's actual depth.)

### Task 6.3 — Commit Phase 6

- [ ] **Step 1: Stage + commit**

```bash
git add CHANGELOG.md server/typescript/packages/metadata/README.md
git commit -m "$(cat <<'EOF'
docs: FR5a-ts CHANGELOG + metadata README (Phase 6)

CHANGELOG.md [Unreleased] gains:
- Added: loader error envelope + source-on-node (ADR-0009 foundation).
- Changed: BREAKING — ParseError constructor signature.

metadata README gains a "Loader errors" section documenting the
LoaderError + ErrorSource shapes and pointing at ADR-0009 + the FR5
family.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification

- [ ] **Step 1: Full server suite**

```bash
cd server/typescript && bun test
```

Expected: green. Test count is `<baseline> + ~30` (23 from Phase 1 + 3 from Phase 2 + 3 from Phase 3 + 2 from Phase 4 + 1 from Phase 5).

- [ ] **Step 2: Workspace build**

```bash
cd /home/doug/Development/metaobjects && bun run --filter '*' build
```

Expected: all 14 packages exit 0.

- [ ] **Step 3: Inspect the commits**

```bash
git log --oneline -7
```

Expected (newest first):
```
<sha-6>  docs: FR5a-ts CHANGELOG + metadata README (Phase 6)
<sha-5>  feat(metadata): FR5a-ts — LoadResult.warnings channel (empty in FR5a)
<sha-4>  feat(metadata): FR5a-ts — ParseError carries the ADR-0009 envelope
<sha-3>  feat(metadata): FR5a-ts — JSON parser populates node.source
<sha-2>  feat(metadata): FR5a-ts — MetaData carries a source provenance field
<sha-1>  feat(metadata): FR5a-ts foundation modules — source, json-path, semantic-diff
<base>   (pre-FR5a main tip)
```

Merge to main via the standard `superpowers:finishing-a-development-branch` flow at the end of the subagent-driven session.

---

## Spec coverage self-review

| Spec requirement | Phase |
|---|---|
| **FR §1**: Add `source` to MetaData base | Phase 2 |
| **FR §2**: Thread source through JSON parse | Phase 3 |
| **FR §3**: Use `node.source` at non-parse error sites | Phase 4 |
| **FR §4**: Programmatic construction defaults | Phase 2 (`codeSource()` + constructor default) |
| **FR §5**: Update error-raising sites to emit full envelope | Phase 4 |
| **ADR-0009 §LoaderError envelope schema** | Phase 1 + Phase 4 |
| **ADR-0009 §Canonical JSONPath** | Phase 1 (`json-path.ts`) |
| **ADR-0009 §semantic_diff algorithm** | Phase 1 (`semantic-diff.ts`) |
| **ADR-0009 §Source-on-node** | Phase 2 |
| **ADR-0009 §Warnings channel** | Phase 5 |
| **ADR-0009 §Canonical-JSON serialization (source excluded)** | Phase 2 (test asserts), Phase 6 (doc note) |

**Deferred (out of scope for FR5a-ts, but planned):**
- **T2 optional fields** (`suggestions[]`, `fixture`, `node` populated in errors) — explicitly optional per ADR-0009; deferred to a follow-on FR if/when consumer demand surfaces.
- **Cross-port conformance harness extension** — rewriting all 24 `expected-errors.json` fixtures to the `{errors[], warnings[]}` shape with source envelopes; coordinated across ports (TS / Java / Python / C#). The current `[{code}]` array shape is forward-compatible with the new envelope (extra fields tolerated by the harness's `parseExpectedErrors`), so cross-port conformance stays green during the TS rollout.
- **YAML positions (`yamlPosition`)** — FR5b territory.
- **Overlay-merge `WARN_DUPLICATE_DECLARATION` emission** — FR5c territory; the channel exists in this FR, no sites populate it.
- **Reference-resolution `format: "resolved"` errors** — FR5d.
- **Database-source `format: "database"` errors** — FR5e (gated on FR-003).

**Intentional simplifications:**
- **`ParseError` constructor signature is a breaking change.** Pre-1.0 minor bump (0.6.0 → 0.7.0) accommodates per pre-1.0 conventions. Direct construction outside the metadata package is rare (loader-internal API); the CHANGELOG `### Changed` entry flags it.
- **YAML parser only gets a partial migration in Phase 4.** Sites construct `{ format: "yaml", files, jsonPath }` envelopes WITHOUT `yamlPosition`. The position field is reserved for FR5b. Existing YAML tests don't assert on position (it didn't exist), so no test changes needed.
- **Warnings emission deferred to FR5c.** The channel exists; FR5a populates an empty array on every load. The first warning (`WARN_DUPLICATE_DECLARATION`) lands when overlay-merge detection is wired in FR5c.

No other gaps identified.
