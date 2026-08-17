# FR-038 Slice 1 — `requirementTests()` generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Generate red test stubs from `requirement.*` nodes, fanned out per referenced metadata type, with all policy owned by the downstream application.

**Architecture:** A `requirementTests()` generator factory in `codegen-ts` walks `ctx.loadedRoot` for requirement nodes (the `Generator` contract is entity-shaped and cannot filter them), projects each to a stable shape, resolves its `@implementedBy` targets, groups them by referenced node type, and emits one stub per group through an app-supplied renderer. Every policy decision is a default with an override seam.

**Tech Stack:** TypeScript, Bun test, ts-poet (via `@metaobjectsdev/codegen-ts` re-export — never a bare `ts-poet` import, per the 0.21.6 split-tree fix).

## Global Constraints

- **Slice scope:** the generator mechanism only. The breaking vocabulary retirement (`@status` shrink, `@verifiedBy`/`@supersededBy` removal) and the dogfood renderers are SEPARATE plans. This slice is additive and must not change existing `meta gen` output for any model without requirements.
- **No `any`.** Use `unknown` and narrow (CLAUDE.md coding discipline).
- **Named constants for metamodel strings** — import from `@metaobjectsdev/metadata`, never inline `"requirement"` / `"functional"`.
- **Never `instanceof` a metadata node from another package** — use the `isMetaRoot`/`isMetaObject`/… guards (CLAUDE.md; the 0.22.0 fix).
- **ADR-0039:** resolving accessors are the default. Only use `own*()` with a comment naming the sanctioned case.
- **Tests must EXECUTE generated code, not grep it.** A stub that is supposed to fail must be run and observed failing.
- **Public repo:** no absolute home paths, no private project names, in code, tests, fixtures or commit messages.
- Run `cd server/typescript && bun test` scoped per package; never a bare `bun test` at the repo root.

---

### Task 1: Extract the claim resolver into `@metaobjectsdev/metadata`

`resolveClaimTarget` and `resolveMember` currently live in `cli/src/lib/requirement-check.ts`. `codegen-ts` cannot import from `cli`, and reimplementing the resolution would fork the ADR-0042 package-local binding contract. Pure refactor: identical behaviour, new home, `cli` delegates.

**Files:**
- Create: `server/typescript/packages/metadata/src/core/requirement/resolve-claim.ts`
- Modify: `server/typescript/packages/metadata/src/index.ts` (export)
- Modify: `server/typescript/packages/cli/src/lib/requirement-check.ts` (delete the two local fns, import instead)
- Test: `server/typescript/packages/metadata/test/resolve-claim.test.ts`

**Interfaces:**
- Produces: `resolveClaim(root: MetaData, ref: string, referrerPkg: string): MetaData | undefined` — resolves a full `@implementedBy` reference including dotted member segments (`Council.slug.view`).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, resolveClaim } from "../src/index.js";

const MODEL = {
  "metadata.root": {
    package: "acme::probe",
    children: [
      { "object.entity": { name: "Council", children: [
        { "field.string": { name: "slug" } },
        { "source.rdb": { "@table": "councils" } },
      ]}},
    ],
  },
};

async function load() {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  if (r.errors.length) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}

describe("resolveClaim", () => {
  test("resolves an object by bare name", async () => {
    const root = await load();
    expect(resolveClaim(root, "Council", "acme::probe")?.name).toBe("Council");
  });

  test("resolves a dotted member segment to the FIELD node", async () => {
    const root = await load();
    const n = resolveClaim(root, "Council.slug", "acme::probe");
    expect(n?.name).toBe("slug");
    expect(n?.type).toBe("field");
  });

  test("returns undefined for an unresolvable reference", async () => {
    const root = await load();
    expect(resolveClaim(root, "Council.nope", "acme::probe")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/metadata && bun test test/resolve-claim.test.ts`
Expected: FAIL — `resolveClaim` is not exported.

- [ ] **Step 3: Write the implementation**

Move the two functions verbatim from `cli/src/lib/requirement-check.ts` (they are at lines ~150-200) into the new file, joined by a public entry point. Keep the existing doc comments — they record why objects resolve first and why requirements are excluded.

```ts
// resolve-claim.ts — resolve an @implementedBy reference to the node it names.
// Moved from cli/requirement-check.ts so codegen-ts can share ONE resolver: a
// second implementation would fork the ADR-0042 package-local binding contract.
import { TYPE_OBJECT, TYPE_REQUIREMENT } from "../../shared/base-types.js";
import { PACKAGE_SEPARATOR } from "../../shared/structural.js";
import { resolveObjectRef } from "../../naming-refs.js";
import type { MetaData } from "../../shared/meta-data.js";

function resolveClaimTarget(root: MetaData, owner: string, referrerPkg: string): MetaData | undefined {
  /* verbatim body from requirement-check.ts */
}

function resolveMember(obj: MetaData, path: string[]): MetaData | undefined {
  /* verbatim body from requirement-check.ts */
}

/** Resolve a full `@implementedBy` reference, including dotted member segments. */
export function resolveClaim(root: MetaData, ref: string, referrerPkg: string): MetaData | undefined {
  const segs = ref.split(".");
  const owner = resolveClaimTarget(root, segs[0]!, referrerPkg);
  if (owner === undefined || segs.length === 1) return owner;
  return resolveMember(owner, segs.slice(1));
}
```

Export from `metadata/src/index.ts`:

```ts
export { resolveClaim } from "./core/requirement/resolve-claim.js";
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/typescript/packages/metadata && bun test test/resolve-claim.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Make `cli` delegate, and prove no regression**

Delete the two local functions from `requirement-check.ts`; import `resolveClaim` and call it where the local pair was called. The CLI's existing requirement tests are the regression gate — they must pass unchanged.

Run: `cd server/typescript/packages/cli && bun test`
Expected: PASS, no changed assertions.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/metadata/src/core/requirement/resolve-claim.ts \
        server/typescript/packages/metadata/src/index.ts \
        server/typescript/packages/metadata/test/resolve-claim.test.ts \
        server/typescript/packages/cli/src/lib/requirement-check.ts
git commit -m "refactor(metadata): extract resolveClaim so codegen can share one resolver"
```

---

### Task 2: Requirement walk + projected view

The projected shape is what app filters bind to. Handing over the raw node would export the ADR-0039 own-vs-resolving trap to every adopter.

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/requirement-walk.ts`
- Test: `server/typescript/packages/codegen-ts/test/requirement-walk.test.ts`

**Interfaces:**
- Consumes: `resolveClaim` (Task 1).
- Produces:
  - `interface RequirementView { subType: string; level: number | undefined; status: string | undefined; path: string; implementedByTypes: string[] }`
  - `interface WalkedRequirement { node: MetaRequirement; view: RequirementView; targets: { ref: string; node: MetaData; concern: string }[] }`
  - `walkRequirements(root: MetaData): WalkedRequirement[]` — depth-first, nested requirements included, dotted `path` built from ancestor names.
  - `concernOf(node: MetaData): string` — `` `${node.type}.${node.subType}` ``.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { walkRequirements } from "../src/requirement-walk.js";

const MODEL = {
  "metadata.root": {
    package: "acme::probe",
    children: [
      { "object.entity": { name: "Council", children: [
        { "field.string": { name: "slug", children: [ { "view.text": { name: "display" } } ] } },
        { "source.rdb": { "@table": "councils" } },
      ]}},
      { "requirement.functional": {
        name: "links", "@level": 3, "@status": "live",
        "@statement": "Links are shareable.", "@violation": "an opaque id in the URL",
        children: [
          { "requirement.functional": {
            name: "slugField", "@level": 4, "@status": "live",
            "@statement": "A council has a human-readable slug.",
            "@violation": "a council with no slug",
            "@implementedBy": ["Council", "Council.slug", "Council.slug.display"],
          }},
        ],
      }},
    ],
  },
};

async function load() {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  if (r.errors.length) throw new Error(r.errors.map((e) => e.message).join("\n"));
  return r.root;
}

describe("walkRequirements", () => {
  test("walks nested requirements and builds dotted paths", async () => {
    const walked = await load().then(walkRequirements);
    expect(walked.map((w) => w.view.path)).toEqual(["links", "links.slugField"]);
  });

  test("projects level, status and subType", async () => {
    const walked = await load().then(walkRequirements);
    const child = walked.find((w) => w.view.path === "links.slugField")!;
    expect(child.view.level).toBe(4);
    expect(child.view.status).toBe("live");
    expect(child.view.subType).toBe("functional");
  });

  test("resolves targets and labels each with its concern", async () => {
    const walked = await load().then(walkRequirements);
    const child = walked.find((w) => w.view.path === "links.slugField")!;
    expect(child.targets.map((t) => t.concern).sort()).toEqual([
      "field.string", "object.entity", "view.text",
    ]);
  });

  test("implementedByTypes is DISTINCT concerns, not one per target", async () => {
    // De-blinding: a model whose targets are all one type cannot tell the
    // per-type rule from the per-node rule apart. This one spans three.
    const walked = await load().then(walkRequirements);
    const child = walked.find((w) => w.view.path === "links.slugField")!;
    expect(child.view.implementedByTypes.sort()).toEqual([
      "field.string", "object.entity", "view.text",
    ]);
  });

  test("an L3 requirement carries no targets (link floor forbids implementedBy)", async () => {
    const walked = await load().then(walkRequirements);
    expect(walked.find((w) => w.view.path === "links")!.targets).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-walk.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
import {
  TYPE_REQUIREMENT, resolveClaim, type MetaData,
} from "@metaobjectsdev/metadata";
import type { MetaRequirement } from "@metaobjectsdev/metadata";

export interface RequirementView {
  subType: string;
  level: number | undefined;
  status: string | undefined;
  path: string;
  implementedByTypes: string[];
}

export interface ResolvedTarget { ref: string; node: MetaData; concern: string }

export interface WalkedRequirement {
  node: MetaRequirement;
  view: RequirementView;
  targets: ResolvedTarget[];
}

/** `<type>.<subType>` — the key a renderer map is looked up by. */
export function concernOf(node: MetaData): string {
  return `${node.type}.${node.subType}`;
}

export function walkRequirements(root: MetaData): WalkedRequirement[] {
  const out: WalkedRequirement[] = [];
  const visit = (node: MetaData, prefix: string): void => {
    if (node.type !== TYPE_REQUIREMENT) return;
    const path = prefix === "" ? node.name : `${prefix}.${node.name}`;
    const req = node as MetaRequirement;
    const pkg = node.package ?? "";
    const targets: ResolvedTarget[] = [];
    for (const ref of req.implementedBy()) {
      const t = resolveClaim(root, ref, pkg);
      if (t !== undefined) targets.push({ ref, node: t, concern: concernOf(t) });
    }
    out.push({
      node: req,
      view: {
        subType: node.subType,
        level: req.level(),
        status: req.status(),
        path,
        implementedByTypes: [...new Set(targets.map((t) => t.concern))],
      },
      targets,
    });
    for (const child of node.children()) visit(child, path);
  };
  for (const child of root.children()) visit(child, "");
  return out;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-walk.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/requirement-walk.ts \
        server/typescript/packages/codegen-ts/test/requirement-walk.test.ts
git commit -m "feat(codegen-ts): requirement walk with projected filter view"
```

---

### Task 3: Fan-out grouping, with the no-target degradation

Per-type fan-out. **A requirement with no resolved targets still emits ONE stub** — otherwise every L1–L3 requirement is silently untestable, since the link floor forbids `@implementedBy` below L4 and an app may legitimately want L3 covered.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/requirement-walk.ts`
- Test: `server/typescript/packages/codegen-ts/test/requirement-walk.test.ts`

**Interfaces:**
- Produces: `const NO_CONCERN = "*"`; `groupByConcern(w: WalkedRequirement): Map<string, ResolvedTarget[]>` — one entry per distinct concern, or a single `NO_CONCERN` entry with `[]` when there are no targets.

- [ ] **Step 1: Write the failing test**

```ts
import { groupByConcern, NO_CONCERN } from "../src/requirement-walk.js";

test("groups targets by distinct concern", async () => {
  const walked = await load().then(walkRequirements);
  const g = groupByConcern(walked.find((w) => w.view.path === "links.slugField")!);
  expect([...g.keys()].sort()).toEqual(["field.string", "object.entity", "view.text"]);
});

test("a requirement with no targets still yields exactly one group", async () => {
  const walked = await load().then(walkRequirements);
  const g = groupByConcern(walked.find((w) => w.view.path === "links")!);
  expect([...g.keys()]).toEqual([NO_CONCERN]);
  expect(g.get(NO_CONCERN)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-walk.test.ts`
Expected: FAIL — `groupByConcern` not exported.

- [ ] **Step 3: Implement**

```ts
export const NO_CONCERN = "*";

export function groupByConcern(w: WalkedRequirement): Map<string, ResolvedTarget[]> {
  const g = new Map<string, ResolvedTarget[]>();
  for (const t of w.targets) {
    const list = g.get(t.concern);
    if (list === undefined) g.set(t.concern, [t]); else list.push(t);
  }
  // No targets is NOT "no tests": the link floor forbids @implementedBy below L4,
  // so an app covering L3 would otherwise get silence. One stub, no concern suffix.
  if (g.size === 0) g.set(NO_CONCERN, []);
  return g;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-walk.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/requirement-walk.ts \
        server/typescript/packages/codegen-ts/test/requirement-walk.test.ts
git commit -m "feat(codegen-ts): concern grouping with no-target degradation"
```

---

### Task 4: Default renderer — red-stub semantics by status

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/templates/requirement-test.ts`
- Test: `server/typescript/packages/codegen-ts/test/requirement-test-render.test.ts`

**Interfaces:**
- Produces: `renderRequirementTest(args: RequirementTestArgs): string`, where
  `RequirementTestArgs = { view: RequirementView; concern: string; statement: string; violation: string; targets: ResolvedTarget[]; disposition?: string; trackedBy?: string[] }`

Semantics (spec §4): `live`/`partial` emit a **failing** assertion carrying the statement; `planned` emits a **skipped** test. An empty green body is forbidden — it would assert the opposite of the claim.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { renderRequirementTest } from "../src/templates/requirement-test.js";

const base = {
  view: { subType: "functional", level: 4, status: "live", path: "links.slugField", implementedByTypes: [] },
  concern: "object.entity",
  statement: "A council has a human-readable slug.",
  violation: "a council with no slug",
  targets: [],
};

describe("renderRequirementTest", () => {
  test("live emits a FAILING assertion, never an empty body", () => {
    const src = renderRequirementTest(base);
    expect(src).toContain("expect.unreachable");
    expect(src).not.toContain("test.skip");
  });

  test("planned emits a skipped test", () => {
    const src = renderRequirementTest({ ...base, view: { ...base.view, status: "planned" } });
    expect(src).toContain("test.skip");
  });

  test("the statement and violation are in the doc comment", () => {
    const src = renderRequirementTest(base);
    expect(src).toContain("A council has a human-readable slug.");
    expect(src).toContain("a council with no slug");
  });

  test("carries the generated header so the runner may overwrite it", () => {
    expect(renderRequirementTest(base)).toContain("@generated");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-test-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { GENERATED_HEADER } from "../constants.js";
import type { RequirementView, ResolvedTarget } from "../requirement-walk.js";

export interface RequirementTestArgs {
  view: RequirementView;
  concern: string;
  statement: string;
  violation: string;
  targets: ResolvedTarget[];
  disposition?: string;
  trackedBy?: string[];
}

const STATUS_PLANNED = "planned";

export function renderRequirementTest(a: RequirementTestArgs): string {
  const skipped = a.view.status === STATUS_PLANNED;
  const fn = skipped ? "test.skip" : "test";
  const claims = a.targets.length
    ? a.targets.map((t) => ` *   - ${t.ref} (${t.concern})`).join("\n")
    : " *   (none — this requirement names no model nodes)";
  const gap = a.disposition !== undefined || (a.trackedBy?.length ?? 0) > 0
    ? `\n * Known gap: ${a.disposition ?? "undecided"}${(a.trackedBy?.length ?? 0) > 0 ? ` (${a.trackedBy!.join(", ")})` : ""}`
    : "";
  // A `live` stub asserts FAILURE until filled in. An empty body would pass, and a
  // passing empty test asserts the opposite of the claim (FR-038 §4).
  const body = skipped
    ? `    // Intended, not built. Fill in when this becomes live.`
    : `    expect.unreachable("unimplemented requirement stub: ${a.view.path}");`;
  return `${GENERATED_HEADER}
import { test, expect } from "bun:test";

/**
 * ${a.statement}
 *
 * Violated by: ${a.violation}${gap}
 *
 * Claims:
${claims}
 */
${fn}("${a.view.path} [${a.concern}]", () => {
${body}
});
`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-test-render.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/templates/requirement-test.ts \
        server/typescript/packages/codegen-ts/test/requirement-test-render.test.ts
git commit -m "feat(codegen-ts): default requirement-test renderer with red-stub semantics"
```

---

### Task 5: The `requirementTests()` factory with its override seams

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/generators/requirement-tests.ts`
- Modify: `server/typescript/packages/codegen-ts/src/generators/index.ts` (export)
- Modify: `server/typescript/packages/codegen-ts/src/index.ts` (export the primitives — walk, group, concernOf, renderer)
- Test: `server/typescript/packages/codegen-ts/test/requirement-tests-generator.test.ts`

**Interfaces:**
- Consumes: `walkRequirements`, `groupByConcern`, `NO_CONCERN`, `renderRequirementTest`.
- Produces: `requirementTests(opts: RequirementTestsOpts): Generator` where

```ts
export interface RequirementTestsOpts {
  name?: string;
  filter?: (r: RequirementView) => boolean;
  renderers?: Record<string, (a: RequirementTestArgs) => string>;
  resolveRenderer?: (concern: string) => ((a: RequirementTestArgs) => string) | undefined;
  path?: (view: RequirementView, concern: string) => string;
  target?: string;
}
```

Renderer lookup order: `resolveRenderer` → exact `concern` → `<type>.*` → `*` → the default renderer. Default `filter` is functional at or above the link floor. Default `path` is `requirements/<path>.<concern>.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { requirementTests } from "../src/generators/requirement-tests.js";

/* MODEL as in Task 2 */

async function emit(opts = {}) {
  const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  const gen = requirementTests(opts);
  return gen.generate({
    entities: [], loadedRoot: r.root as never, matches: () => true,
    config: {} as never, warn: () => {},
  } as never);
}

describe("requirementTests", () => {
  test("emits one file per distinct concern, not one per target", async () => {
    const files = await emit();
    expect(files.map((f) => f.path).sort()).toEqual([
      "requirements/links.slugField.field.string.test.ts",
      "requirements/links.slugField.object.entity.test.ts",
      "requirements/links.slugField.view.text.test.ts",
    ]);
  });

  test("the default filter excludes L3 (below the link floor)", async () => {
    const files = await emit();
    expect(files.some((f) => f.path.includes("links.test"))).toBe(false);
  });

  test("a widened filter includes L3 as a single no-concern stub", async () => {
    const files = await emit({ filter: () => true });
    expect(files.some((f) => f.path === "requirements/links.test.ts")).toBe(true);
  });

  test("a custom renderer wins over the default", async () => {
    const files = await emit({ renderers: { "object.entity": () => "CUSTOM" } });
    const f = files.find((x) => x.path.includes("object.entity"))!;
    expect(f.content).toBe("CUSTOM");
  });

  test("a wildcard renderer matches by type", async () => {
    const files = await emit({ renderers: { "view.*": () => "WILDCARD" } });
    expect(files.find((x) => x.path.includes("view.text"))!.content).toBe("WILDCARD");
  });

  test("a custom path fn wins", async () => {
    const files = await emit({ path: (v, c) => `t/${v.path}__${c}.spec.ts` });
    expect(files.every((f) => f.path.startsWith("t/"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-tests-generator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
import { REQUIREMENT_SUBTYPE_FUNCTIONAL, REQUIREMENT_LINK_FLOOR_LEVEL, REQUIREMENT_ATTR_STATEMENT, REQUIREMENT_ATTR_VIOLATION } from "@metaobjectsdev/metadata";
import type { Generator } from "../generator.js";
import { walkRequirements, groupByConcern, NO_CONCERN, type RequirementView } from "../requirement-walk.js";
import { renderRequirementTest, type RequirementTestArgs } from "../templates/requirement-test.js";

export type RequirementTestRenderer = (a: RequirementTestArgs) => string;

export interface RequirementTestsOpts {
  name?: string;
  filter?: (r: RequirementView) => boolean;
  renderers?: Record<string, RequirementTestRenderer>;
  resolveRenderer?: (concern: string) => RequirementTestRenderer | undefined;
  path?: (view: RequirementView, concern: string) => string;
  target?: string;
}

/** RECOMMENDATION, not a rule — the app owns policy (FR-038 §5). */
const defaultFilter = (r: RequirementView): boolean =>
  r.subType === REQUIREMENT_SUBTYPE_FUNCTIONAL &&
  (r.level ?? 0) >= REQUIREMENT_LINK_FLOOR_LEVEL;

const defaultPath = (v: RequirementView, concern: string): string =>
  concern === NO_CONCERN
    ? `requirements/${v.path}.test.ts`
    : `requirements/${v.path}.${concern}.test.ts`;

function pick(concern: string, opts: RequirementTestsOpts): RequirementTestRenderer {
  const viaFn = opts.resolveRenderer?.(concern);
  if (viaFn !== undefined) return viaFn;
  const map = opts.renderers ?? {};
  const typeOnly = `${concern.split(".")[0]}.*`;
  return map[concern] ?? map[typeOnly] ?? map["*"] ?? renderRequirementTest;
}

export function requirementTests(opts: RequirementTestsOpts = {}): Generator {
  const filter = opts.filter ?? defaultFilter;
  const toPath = opts.path ?? defaultPath;
  const generator: Generator = {
    name: opts.name ?? "requirement-tests",
    generate: (ctx) => {
      const out = [];
      for (const w of walkRequirements(ctx.loadedRoot)) {
        if (!filter(w.view)) continue;
        for (const [concern, targets] of groupByConcern(w)) {
          const args: RequirementTestArgs = {
            view: w.view, concern, targets,
            statement: String(w.node.attr(REQUIREMENT_ATTR_STATEMENT) ?? ""),
            violation: String(w.node.attr(REQUIREMENT_ATTR_VIOLATION) ?? ""),
          };
          out.push({ path: toPath(w.view, concern), content: pick(concern, opts)(args) });
        }
      }
      return out;
    },
  };
  if (opts.target !== undefined) generator.target = opts.target;
  return generator;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-tests-generator.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/generators/requirement-tests.ts \
        server/typescript/packages/codegen-ts/src/generators/index.ts \
        server/typescript/packages/codegen-ts/src/index.ts \
        server/typescript/packages/codegen-ts/test/requirement-tests-generator.test.ts
git commit -m "feat(codegen-ts): requirementTests() generator with app-owned policy seams"
```

---

### Task 6: Execute the generated stub — the gate that actually matters

Text assertions cannot tell a failing stub from a passing one. This repo has been bitten precisely here. The stub must be **written to disk and run**.

**Files:**
- Test: `server/typescript/packages/codegen-ts/test/requirement-stub-executes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderRequirementTest } from "../src/templates/requirement-test.js";

const view = { subType: "functional", level: 4, path: "req.probe", implementedByTypes: [] };

function runStub(src: string): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "req-stub-"));
  const file = join(dir, "stub.test.ts");
  writeFileSync(file, src);
  const r = Bun.spawnSync(["bun", "test", file], { cwd: dir });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

describe("generated stubs actually behave", () => {
  test("a LIVE stub FAILS when run", () => {
    const { code } = runStub(renderRequirementTest({
      view: { ...view, status: "live" }, concern: "object.entity",
      statement: "s", violation: "v", targets: [],
    }));
    expect(code).not.toBe(0);   // an empty-but-green stub would assert the opposite of the claim
  });

  test("a PLANNED stub is skipped, not passed", () => {
    const { out } = runStub(renderRequirementTest({
      view: { ...view, status: "planned" }, concern: "object.entity",
      statement: "s", violation: "v", targets: [],
    }));
    expect(out).toContain("skip");
  });

  test("PROOF THE GATE CAN FAIL: replacing the body with a real assertion passes", () => {
    const filled = renderRequirementTest({
      view: { ...view, status: "live" }, concern: "object.entity",
      statement: "s", violation: "v", targets: [],
    }).replace(/expect\.unreachable\([^)]*\);/, "expect(1).toBe(1);");
    expect(runStub(filled).code).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-stub-executes.test.ts`
Expected: FAIL until Task 4's renderer emits `expect.unreachable` for live and `test.skip` for planned.

- [ ] **Step 3: No new implementation** — this task gates Task 4. If it fails, fix the renderer.

- [ ] **Step 4: Run to verify pass**

Run: `cd server/typescript/packages/codegen-ts && bun test test/requirement-stub-executes.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/test/requirement-stub-executes.test.ts
git commit -m "test(codegen-ts): execute generated stubs — live fails, planned skips, filled passes"
```

---

### Task 7: Uncovered-requirement warning

Policy lives in the filter, so a requirement matched by nothing is indistinguishable from a deliberate exclusion unless we say so. One self-extinguishing warning, never failing.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/generators/requirement-tests.ts`
- Test: `server/typescript/packages/codegen-ts/test/requirement-tests-generator.test.ts`

**Interfaces:**
- `RequirementTestsOpts` gains `warnUncovered?: boolean` (default `true`).

- [ ] **Step 1: Write the failing test**

```ts
test("warns once, naming requirements no filter covered", async () => {
  const seen: string[] = [];
  const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  requirementTests({}).generate({
    entities: [], loadedRoot: r.root as never, matches: () => true,
    config: {} as never, warn: (m: string) => seen.push(m),
  } as never);
  expect(seen.length).toBe(1);
  expect(seen[0]).toContain("links");
});

test("the warning is suppressible", async () => {
  const seen: string[] = [];
  const r = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  requirementTests({ warnUncovered: false }).generate({
    entities: [], loadedRoot: r.root as never, matches: () => true,
    config: {} as never, warn: (m: string) => seen.push(m),
  } as never);
  expect(seen).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Expected: FAIL — no warning emitted.

- [ ] **Step 3: Implement** — collect skipped paths in the loop, then after it:

```ts
if ((opts.warnUncovered ?? true) && uncovered.length > 0) {
  ctx.warn(
    `requirement-tests: ${uncovered.length} requirement(s) matched no filter and get no stub: ` +
    `${uncovered.join(", ")}. This is a policy choice — set warnUncovered: false to silence it.`,
  );
}
```

- [ ] **Step 4: Run to verify pass** — 8 tests in the generator suite.

- [ ] **Step 5: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/generators/requirement-tests.ts \
        server/typescript/packages/codegen-ts/test/requirement-tests-generator.test.ts
git commit -m "feat(codegen-ts): warn once on requirements no generator covers"
```

---

## Deferred to later plans (explicitly NOT this slice)

- **Deletion integrity** (spec §8): refuse-on-filled-stub needs a runner change (the runner writes, it does not reconcile deletions). Separate plan — it touches `runner.ts`, which every generator shares.
- **Vocabulary retirement** (spec §4): breaking, five ports, byte-gated manifest, migration guide. Rides a coordinated pre-1.0 breaking slot with FR-037.
- **Dogfood renderers** (spec §9): depends on this slice landing.
- **`meta init` scaffolding** of an owned `codegen/generators/requirement-tests.ts`.
- **Non-TS ports.**

## Self-review

- **Spec coverage:** §2 inversion → Tasks 2–5. §4 emission table → Task 4 (vocabulary retirement deferred, noted). §5 policy/filter/warning → Tasks 5, 7. §6 contract + seams → Task 5 (`filter`, `renderers`, `resolveRenderer`, `path`, `target`; `groupBy` seam deferred with a note). §7 fan-out + naming → Tasks 2, 3, 5. §8 deletion → deferred, stated. §9 dogfood → deferred. §12 verification → Task 6.
- **Gap accepted:** the `groupBy` seam from §6's table is not in Task 5's options — `groupByConcern` is exported as a primitive so an app can compose its own generator, which serves the same need without a second seam to maintain. Recorded rather than silently dropped.
- **Type consistency:** `RequirementView`, `ResolvedTarget`, `WalkedRequirement`, `RequirementTestArgs`, `RequirementTestRenderer` used identically across Tasks 2–7. `NO_CONCERN` is `"*"` in both the grouping and the renderer-lookup fallback — deliberate: a no-target requirement falls through to the same catch-all renderer.
- **Placeholders:** none.
