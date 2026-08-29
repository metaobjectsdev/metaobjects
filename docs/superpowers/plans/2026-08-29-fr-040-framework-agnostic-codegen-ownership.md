# FR-040 — Framework-Agnostic Codegen Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the published "you own the codegen" doctrine true all the way down — extend the ownable generator set to the UI tier, make the emit composable rather than fork-only, and route framework-mismatch symptoms to the doctrine.

**Architecture:** Every generator in this repo is already a **thin generator** (54–70 lines: filter, output path, target) plus a **fat renderer** (`render*File(entity, ctx) → string`). `codegen-ts` already exports its renderer (`renderRoutesFile`) publicly; the UI packages do not. This plan applies the existing pattern outward: export the UI renderers, add per-package reference templates that compose them, generalize the template reader so any package can host its own, and add a `meta eject` command plus the skill text that makes an agent reach for all of it.

**Tech Stack:** TypeScript (ESM only), Bun test runner, ts-poet emit, `@metaobjectsdev/codegen-ts` plugin interface.

**Spec:** `docs/superpowers/specs/2026-08-29-fr-040-framework-agnostic-codegen-ownership-design.md`

## Global Constraints

- **Public repository.** No private/other-project names, and no absolute paths rooted in a developer's home directory, in any committed file — commit messages included. Use `<repo-root>` / `<consumer-repo>` placeholders.
- **No framework knowledge in a shipped package.** No file under `server/typescript/packages/` or `client/web/packages/` may name Next.js, Nuxt, Svelte or Qwik as a supported target. Framework names appear only as *examples inside a category* in skill/docs prose (spec §4.3 point 3).
- **ESM only.** No CommonJS. Relative imports inside package source carry `.js` extensions.
- **Named constants for metamodel strings** — import from `packages/metadata/src/constants.ts`, never inline `"field"` / `"object"`.
- **No `any`.** Use `unknown` and narrow.
- **ADR-0039 own-accessor discipline.** Read node properties through resolving accessors (`attr()`, `children()`); every `own*()` call carries a comment naming its sanctioned case.
- **Reference templates import only their own package's public engine** — never a `src/templates/*` deep path, never the deprecated `@metaobjectsdev/codegen-ts/generators` export.
- **Test scoping.** Run `cd server/typescript/packages/<pkg> && bun test`. Never a bare `bun test` at the repo root (it walks `java/`, `python/`, `csharp/`).

---

### Task 1: Export the UI render layer

Makes the emit composable. Without this a reference template cannot call the engine and would have to fork 595 lines. `codegen-ts` already does this with `renderRoutesFile` — this applies the same pattern to the two UI packages.

**Files:**
- Modify: `server/typescript/packages/codegen-ts-react/src/index.ts`
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/index.ts`
- Test: `server/typescript/packages/codegen-ts-react/test/public-render-api.test.ts` (create)
- Test: `server/typescript/packages/codegen-ts-tanstack/test/public-render-api.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: from `@metaobjectsdev/codegen-ts-react` — `renderFormFile(entity: MetaObject, ctx: RenderContext): string`. From `@metaobjectsdev/codegen-ts-tanstack` — `renderHooksFile(entity, ctx): string`, `renderColumnsFile(entity, ctx): string`, `renderGridHookFile(entity, ctx): string`. All four already exist with these exact signatures; this task only makes them public.

- [ ] **Step 1: Write the failing test for the react package**

Create `server/typescript/packages/codegen-ts-react/test/public-render-api.test.ts`:

```ts
// FR-040 §4.2(b) — the render layer is public API so an OWNED generator can compose
// the engine and replace only the framework-coupled step, instead of forking it.
import { describe, test, expect } from "bun:test";
import * as pkg from "../src/index.js";

describe("codegen-ts-react public render API", () => {
  test("exports renderFormFile", () => {
    expect(typeof (pkg as Record<string, unknown>).renderFormFile).toBe("function");
  });

  test("renderFormFile takes (entity, ctx)", () => {
    expect((pkg.renderFormFile as (...a: unknown[]) => unknown).length).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript/packages/codegen-ts-react && bun test test/public-render-api.test.ts`
Expected: FAIL — `expected "undefined" to be "function"`.

- [ ] **Step 3: Add the export**

In `server/typescript/packages/codegen-ts-react/src/index.ts`, append:

```ts
// FR-040 §4.2(b) — public so an owned generator composes the engine rather than
// forking it. Signature is stable API: (entity, ctx) => string.
export { renderFormFile } from "./templates/form-file.js";
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd server/typescript/packages/codegen-ts-react && bun test test/public-render-api.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing test for the tanstack package**

Create `server/typescript/packages/codegen-ts-tanstack/test/public-render-api.test.ts`:

```ts
// FR-040 §4.2(b) — see the codegen-ts-react sibling for the rationale.
import { describe, test, expect } from "bun:test";
import * as pkg from "../src/index.js";

const RENDERERS = ["renderHooksFile", "renderColumnsFile", "renderGridHookFile"] as const;

describe("codegen-ts-tanstack public render API", () => {
  for (const name of RENDERERS) {
    test(`exports ${name} taking (entity, ctx)`, () => {
      const fn = (pkg as Record<string, unknown>)[name];
      expect(typeof fn).toBe("function");
      expect((fn as (...a: unknown[]) => unknown).length).toBe(2);
    });
  }
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `cd server/typescript/packages/codegen-ts-tanstack && bun test test/public-render-api.test.ts`
Expected: FAIL on all three.

- [ ] **Step 7: Add the exports**

In `server/typescript/packages/codegen-ts-tanstack/src/index.ts`, append:

```ts
// FR-040 §4.2(b) — public so an owned generator composes the engine rather than
// forking it. Signatures are stable API: (entity, ctx) => string.
export { renderHooksFile } from "./templates/hooks-file.js";
export { renderColumnsFile } from "./templates/columns-file.js";
export { renderGridHookFile } from "./templates/grid-hook-file.js";
```

- [ ] **Step 8: Run both packages' full suites**

Run: `cd server/typescript/packages/codegen-ts-react && bun test && cd ../codegen-ts-tanstack && bun test`
Expected: PASS, no regressions.

- [ ] **Step 9: Typecheck**

Run: `cd server/typescript && bun run --filter '@metaobjectsdev/codegen-ts-react' typecheck && bun run --filter '@metaobjectsdev/codegen-ts-tanstack' typecheck`
Expected: exit 0.

- [ ] **Step 10: Commit**

```bash
git add server/typescript/packages/codegen-ts-react/src/index.ts \
        server/typescript/packages/codegen-ts-react/test/public-render-api.test.ts \
        server/typescript/packages/codegen-ts-tanstack/src/index.ts \
        server/typescript/packages/codegen-ts-tanstack/test/public-render-api.test.ts
git commit -m "feat(codegen): export the UI render layer as public API (FR-040 §4.2b)

An owned generator can now compose renderFormFile / renderHooksFile /
renderColumnsFile / renderGridHookFile and replace only the step its
framework disagrees about, instead of copying 595 lines of package
internals out. codegen-ts already exported renderRoutesFile; this
applies the same pattern to the UI packages."
```

---

### Task 2: Generalize the reference-template reader so any package can host templates

Today `resolveReferenceRoot()` walks up from `codegen-ts`'s own module URL, so only `codegen-ts` can own reference assets. The UI packages need the same capability without duplicating the resolver.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/reference-templates.ts`
- Modify: `server/typescript/packages/codegen-ts/src/index.ts`
- Test: `server/typescript/packages/codegen-ts/test/reference-templates.test.ts:11-30` (extend)

**Interfaces:**
- Consumes: nothing.
- Produces: `makeReferenceReader(moduleUrl: string, names: readonly string[]): { resolveReferenceRoot(): string; readReferenceTemplate(name: string): string }`, exported from `@metaobjectsdev/codegen-ts`. The existing `resolveReferenceRoot` / `readReferenceTemplate` / `REFERENCE_GENERATOR_NAMES` exports keep their current signatures and behaviour (Task 5 and `meta init` depend on them).

- [ ] **Step 1: Write the failing test**

Append to `server/typescript/packages/codegen-ts/test/reference-templates.test.ts`:

```ts
describe("makeReferenceReader — per-package template hosting", () => {
  test("resolves a reference root relative to the CALLING module's url", () => {
    // Given this package's own module url, the reader finds this package's templates.
    const reader = makeReferenceReader(import.meta.url, ["entity"]);
    expect(existsSync(join(reader.resolveReferenceRoot(), "entity.ts"))).toBe(true);
  });

  test("reads a named template through the reader", () => {
    const reader = makeReferenceReader(import.meta.url, ["entity"]);
    expect(reader.readReferenceTemplate("entity")).toContain("REFERENCE TEMPLATE");
  });

  test("throws a named error when the package hosts no reference dir", () => {
    const reader = makeReferenceReader("file:///nonexistent/pkg/dist/index.js", ["entity"]);
    expect(() => reader.resolveReferenceRoot()).toThrow(/reference templates not found/);
  });
});
```

Add `makeReferenceReader` to the existing import block at the top of the file.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript/packages/codegen-ts && bun test test/reference-templates.test.ts`
Expected: FAIL — `makeReferenceReader is not a function`.

- [ ] **Step 3: Implement the factory**

Replace the body of `server/typescript/packages/codegen-ts/src/reference-templates.ts` below the imports with:

```ts
/** Basenames (no extension) of the copyable reference generators shipped in `src/reference/`. */
export const REFERENCE_GENERATOR_NAMES = ["entity", "queries", "routes", "routes-hono", "barrel"] as const;
export type ReferenceGeneratorName = (typeof REFERENCE_GENERATOR_NAMES)[number];

/** A directory is a reference root iff it holds the first template the reader was told to expect. */
function isReferenceRoot(dir: string, sentinel: string): boolean {
  return existsSync(join(dir, `${sentinel}.ts`));
}

/**
 * FR-040 §4.1 — build a reference-template reader for ONE package. `moduleUrl` is the
 * calling module's `import.meta.url`, so each package resolves its OWN `src/reference/`.
 * `names[0]` is the sentinel that identifies the directory.
 *
 * Works in dev (module runs from `src/`, templates at `./reference/`) and in a published
 * install (module runs from `dist/`, templates at `../src/reference/`, since `src/` ships
 * alongside `dist/`). Walks up checking both layouts at each level.
 */
export function makeReferenceReader(moduleUrl: string, names: readonly string[]) {
  const sentinel = names[0];
  if (!sentinel) throw new Error("makeReferenceReader: `names` must not be empty.");

  function resolveReferenceRoot(): string {
    let dir = dirname(fileURLToPath(moduleUrl));
    for (let i = 0; i < 8; i++) {
      for (const candidate of [join(dir, "reference"), join(dir, "src", "reference")]) {
        if (isReferenceRoot(candidate, sentinel)) return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(
      "reference templates not found — looked for `reference/` and `src/reference/` " +
        `walking up from ${dir}.`,
    );
  }

  return {
    resolveReferenceRoot,
    readReferenceTemplate: (name: string): string =>
      readFileSync(join(resolveReferenceRoot(), `${name}.ts`), "utf8"),
  };
}

// This package's own reader — the back-compatible named exports `meta init` uses.
const ownReader = makeReferenceReader(import.meta.url, REFERENCE_GENERATOR_NAMES);

/** Resolve the `src/reference/` directory holding this package's reference generators. */
export function resolveReferenceRoot(): string {
  return ownReader.resolveReferenceRoot();
}

/** Read the raw source of one reference generator (e.g. `"entity"` → the text of `entity.ts`). */
export function readReferenceTemplate(name: ReferenceGeneratorName): string {
  return ownReader.readReferenceTemplate(name);
}
```

Note `REFERENCE_GENERATOR_NAMES` now includes `"routes-hono"` — Task 4 creates that asset. Keep `"entity"` first; it is the sentinel.

- [ ] **Step 4: Export the factory**

In `server/typescript/packages/codegen-ts/src/index.ts`, find the existing `reference-templates.js` export line and extend it to include `makeReferenceReader`.

- [ ] **Step 5: Update the existing four-name assertion**

The existing test asserts exactly four names. Change it to reflect the new set and say why:

```ts
  test("exposes the copyable generator names, entity first (reader sentinel)", () => {
    expect([...REFERENCE_GENERATOR_NAMES]).toEqual([
      "entity", "queries", "routes", "routes-hono", "barrel",
    ]);
  });
```

- [ ] **Step 6: Run tests — routes-hono will fail until Task 4**

Run: `cd server/typescript/packages/codegen-ts && bun test test/reference-templates.test.ts`
Expected: the `makeReferenceReader` tests PASS; the loop reading every name FAILS on `routes-hono` (no asset yet). This is the correct intermediate state — Task 4 creates it. Do not weaken the test to hide it.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/reference-templates.ts \
        server/typescript/packages/codegen-ts/src/index.ts \
        server/typescript/packages/codegen-ts/test/reference-templates.test.ts
git commit -m "feat(codegen): per-package reference-template reader (FR-040 4.1)

makeReferenceReader(moduleUrl, names) resolves a package's OWN
src/reference/, so the UI packages can host copyable templates without
duplicating the resolver. The existing named exports keep their
signatures; meta init is unaffected.

routes-hono is added to the name list here and its asset lands in the
next commit, so this commit's template-reading test is red on that name
by design."
```

---

### Task 3: Add the `routes-hono` reference template

Ships the asset Task 2 named. `routesFileHono` is a `codegen-ts` generator, so its template lives in `codegen-ts`.

**Files:**
- Create: `server/typescript/packages/codegen-ts/src/reference/routes-hono.ts`
- Test: `server/typescript/packages/codegen-ts/test/reference-templates.test.ts` (already covers it via the name loop)

**Interfaces:**
- Consumes: `makeReferenceReader` / `REFERENCE_GENERATOR_NAMES` (Task 2).
- Produces: a copyable `routesFileHono()` generator factory in the consumer's repo.

- [ ] **Step 1: Read the existing template to match its shape exactly**

Run: `cat server/typescript/packages/codegen-ts/src/reference/routes.ts`
Note the header block format (`use-when:` / `emits:` / `customize:` / `composes-with:`), the RUNTIME warning, and how it wraps `renderRoutesFile`.

- [ ] **Step 2: Read the package generator being templated**

Run: `cat server/typescript/packages/codegen-ts/src/generators/routes-file-hono.ts`
The reference template must reproduce this generator's filter and output-path logic, importing only from `@metaobjectsdev/codegen-ts`.

- [ ] **Step 3: Write the template**

Create `server/typescript/packages/codegen-ts/src/reference/routes-hono.ts`, mirroring `routes.ts`'s structure. Header block:

```ts
// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/routes-hono.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { routesFileHono } from "./codegen/generators/routes-hono.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`.
// targets:       Hono. The emitted file imports `mountCrudRoutes` from
//                `@metaobjectsdev/runtime-ts/hono` and takes its persistence client as
//                INJECTED DEPS (`register<Entity>Routes(app, { db })`) rather than a
//                module-singleton import — which is what makes it portable to any host
//                that can hand Hono a request. If your framework is not Hono, THIS is the
//                file to retarget: swap the mount helper and the exported signature; the
//                metadata walk above it is framework-neutral and stays as-is.
// use-when:      you want generated Hono CRUD routes per entity.
// emits:         <target>/<Entity>.routes.hono.ts — full CRUD for write-through entities,
//                read-only (GET list + GET :id) for projections. Skipped for any sourceless
//                object and for TPH subtypes.
// customize:     this generator is YOURS — edit it freely. For the emitted route
//                composition, call `renderRoutesFileHono` (exported from the engine) and
//                wrap its result, or replace the call entirely.
// composes-with: entity.ts (imports the table/schemas/allowlists), queries.ts.
```

Then the implementation, delegating to the engine exactly as `routes.ts` delegates to `renderRoutesFile`.

- [ ] **Step 4: Export the renderer the template composes**

`renderRoutesFileHono(entity, ctx)` exists at `src/templates/routes-file-hono.ts:34` but is
**not** exported from `src/index.ts` today — only `renderRoutesFile` is. The template cannot
compose what it cannot import, so add it beside its sibling:

```ts
export { renderRoutesFileHono } from "./templates/routes-file-hono.js";
```

Confirm with: `grep -n "renderRoutesFileHono" server/typescript/packages/codegen-ts/src/index.ts`

- [ ] **Step 5: Run the reference-template tests**

Run: `cd server/typescript/packages/codegen-ts && bun test test/reference-templates.test.ts`
Expected: PASS — all five names now resolve, and `routes-hono.ts` contains `REFERENCE TEMPLATE`, imports `from "@metaobjectsdev/codegen-ts"`, and does not contain `@metaobjectsdev/codegen-ts/generators`.

- [ ] **Step 6: Prove the template actually compiles as a consumer copy**

The reference dir is excluded from tsc, so a broken template ships silently. Add to `server/typescript/packages/codegen-ts/test/reference-templates.test.ts`:

```ts
test("every reference template parses as a module and declares its target", () => {
  for (const name of REFERENCE_GENERATOR_NAMES) {
    const src = readReferenceTemplate(name);
    // A template with no `targets:` line leaves an adopter guessing what it is coupled to.
    expect(src).toContain("// targets:");
    expect(() => new Function(`return 0; /* ${name} */`)).not.toThrow();
  }
});
```

Note: this asserts the header contract Task 6 completes for the other four templates, so it fails for them now. Run it, confirm it fails on `entity`/`queries`/`routes`/`barrel`, and **skip it with `test.skip` plus a `// unskip in Task 6` comment** rather than weakening it.

- [ ] **Step 7: Run the full package suite**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/reference/routes-hono.ts \
        server/typescript/packages/codegen-ts/test/reference-templates.test.ts \
        server/typescript/packages/codegen-ts/src/index.ts
git commit -m "feat(codegen): routes-hono reference template (FR-040 4.1)

The deps-injected Hono routes generator is now copy-and-ownable like the
Fastify one. Its header carries the new targets: line naming exactly
which part is framework-coupled and what to swap."
```

---

### Task 4: Add UI-tier reference templates

The structural fix: the tier where frameworks actually diverge becomes ownable.

**Files:**
- Create: `server/typescript/packages/codegen-ts-react/src/reference/form.ts`
- Create: `server/typescript/packages/codegen-ts-react/src/reference-templates.ts`
- Modify: `server/typescript/packages/codegen-ts-react/src/index.ts`
- Modify: `server/typescript/packages/codegen-ts-react/tsconfig.json`
- Create: `server/typescript/packages/codegen-ts-tanstack/src/reference/{hooks,grid,grid-hook}.ts`
- Create: `server/typescript/packages/codegen-ts-tanstack/src/reference-templates.ts`
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/index.ts`
- Modify: `server/typescript/packages/codegen-ts-tanstack/tsconfig.json`
- Test: `server/typescript/packages/codegen-ts-react/test/reference-templates.test.ts` (create)
- Test: `server/typescript/packages/codegen-ts-tanstack/test/reference-templates.test.ts` (create)

**Interfaces:**
- Consumes: `makeReferenceReader` (Task 2); `renderFormFile` / `renderHooksFile` / `renderColumnsFile` / `renderGridHookFile` (Task 1).
- Produces: from `@metaobjectsdev/codegen-ts-react` — `REFERENCE_GENERATOR_NAMES = ["form"]`, `readReferenceTemplate(name)`, `resolveReferenceRoot()`. From `@metaobjectsdev/codegen-ts-tanstack` — the same three with `REFERENCE_GENERATOR_NAMES = ["hooks", "grid", "grid-hook"]`. Task 5 discovers templates through these.

- [ ] **Step 1: Write the failing test for the react package**

Create `server/typescript/packages/codegen-ts-react/test/reference-templates.test.ts`:

```ts
// FR-040 §4.1 — the UI tier is where frameworks diverge most, so it must be ownable.
import { describe, test, expect } from "bun:test";
import { REFERENCE_GENERATOR_NAMES, readReferenceTemplate, resolveReferenceRoot } from "../src/index.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("codegen-ts-react reference templates", () => {
  test("exposes the form template", () => {
    expect([...REFERENCE_GENERATOR_NAMES]).toEqual(["form"]);
  });

  test("the asset exists on disk", () => {
    expect(existsSync(join(resolveReferenceRoot(), "form.ts"))).toBe(true);
  });

  test("imports only this package's public engine, declares its target", () => {
    const src = readReferenceTemplate("form");
    expect(src).toContain("REFERENCE TEMPLATE");
    expect(src).toContain("// targets:");
    expect(src).toContain('from "@metaobjectsdev/codegen-ts-react"');
    // Never a deep path into package internals — that is the fork this FR removes.
    expect(src).not.toContain("src/templates");
    expect(src).not.toContain("./templates/");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript/packages/codegen-ts-react && bun test test/reference-templates.test.ts`
Expected: FAIL — `REFERENCE_GENERATOR_NAMES` is not exported.

- [ ] **Step 3: Add the react package's reader**

Create `server/typescript/packages/codegen-ts-react/src/reference-templates.ts`:

```ts
// FR-040 §4.1 — this package hosts its own copyable reference generators in
// `src/reference/`, read through the shared factory so the resolver is not duplicated.
import { makeReferenceReader } from "@metaobjectsdev/codegen-ts";

export const REFERENCE_GENERATOR_NAMES = ["form"] as const;
export type ReferenceGeneratorName = (typeof REFERENCE_GENERATOR_NAMES)[number];

const reader = makeReferenceReader(import.meta.url, REFERENCE_GENERATOR_NAMES);

export function resolveReferenceRoot(): string {
  return reader.resolveReferenceRoot();
}

export function readReferenceTemplate(name: ReferenceGeneratorName): string {
  return reader.readReferenceTemplate(name);
}
```

Re-export all three from `src/index.ts`.

- [ ] **Step 4: Write the form reference template**

Create `server/typescript/packages/codegen-ts-react/src/reference/form.ts`. Reproduce `src/form-file.ts`'s filter and output-path logic verbatim (read it first — it carries TPH and projection guards that must not be lost), importing only from `@metaobjectsdev/codegen-ts` and `@metaobjectsdev/codegen-ts-react`. Header:

```ts
// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/form.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { formFile } from "./codegen/generators/form.js";
//
// RUNTIME: this file executes under whatever runs `meta gen` — NODE, even in a Bun
// project. Do not reach for `Bun.*` globals here.
// targets:       React with react-hook-form. The emitted component calls `useEntityForm`
//                from `@metaobjectsdev/react`, so it is a CLIENT component.
//                If your framework compiles server and client from one tree and resolves
//                each half under different conditions, the emitted file may need a marker
//                directive — prepend it to `renderFormFile`'s result below. That is a
//                one-line change in THIS file and is the intended way to do it.
// use-when:      you want a generated form per writable entity.
// emits:         <target>/<Entity>.form.tsx
// customize:     this generator is YOURS. `renderFormFile` (exported from
//                @metaobjectsdev/codegen-ts-react) produces the component body — wrap it,
//                prepend to it, or replace the call entirely with your own renderer.
// composes-with: entity.ts (imports the schemas the form validates against).
```

The `generate` body demonstrates the composition seam explicitly:

```ts
    generate: perEntity((entity, ctx) => {
      if (!ctx.renderContext) {
        throw new Error("form-file: renderContext is required (provided by runGen)");
      }
      // The framework-coupled seam. Prepend a directive here if your toolchain needs one.
      const body = renderFormFile(entity, ctx.renderContext);
      return {
        path: entityOutputPath(ctx.config.outputLayout ?? "flat", entity.package, `${entity.name}.form.tsx`),
        content: body,
      };
    }),
```

- [ ] **Step 5: Exclude the reference dir from tsc**

In `server/typescript/packages/codegen-ts-react/tsconfig.json`, add `"src/reference"` to the `exclude` array, matching `codegen-ts`'s tsconfig. The assets are scaffold source, not package source, and already ship via `files: ["src"]`.

- [ ] **Step 6: Run the react tests**

Run: `cd server/typescript/packages/codegen-ts-react && bun test`
Expected: PASS.

- [ ] **Step 7: Repeat for the tanstack package**

Same five moves: `src/reference-templates.ts` with `REFERENCE_GENERATOR_NAMES = ["hooks", "grid", "grid-hook"] as const`; three assets in `src/reference/` mirroring `tanstack-query.ts`, `tanstack-grid.ts`, `tanstack-grid-hook.ts` and composing `renderHooksFile` / `renderColumnsFile` / `renderGridHookFile`; re-export from `src/index.ts`; add `"src/reference"` to tsconfig `exclude`; and the sibling test file asserting `["hooks","grid","grid-hook"]`, the `// targets:` line, `from "@metaobjectsdev/codegen-ts-tanstack"`, and no `./templates/` deep path.

The `hooks` template's `targets:` line must name the client-component coupling (the emitted hooks call `useEntityFetcher()` from `@metaobjectsdev/tanstack`) using the same category-not-framework wording as the form template.

- [ ] **Step 8: Run both suites and typecheck**

Run: `cd server/typescript/packages/codegen-ts-react && bun test && cd ../codegen-ts-tanstack && bun test`
Run: `cd server/typescript && bun run --filter '@metaobjectsdev/codegen-ts-react' typecheck && bun run --filter '@metaobjectsdev/codegen-ts-tanstack' typecheck`
Expected: PASS, exit 0.

- [ ] **Step 9: Commit**

```bash
git add server/typescript/packages/codegen-ts-react/src \
        server/typescript/packages/codegen-ts-react/test/reference-templates.test.ts \
        server/typescript/packages/codegen-ts-react/tsconfig.json \
        server/typescript/packages/codegen-ts-tanstack/src \
        server/typescript/packages/codegen-ts-tanstack/test/reference-templates.test.ts \
        server/typescript/packages/codegen-ts-tanstack/tsconfig.json
git commit -m "feat(codegen): UI-tier reference templates (FR-040 4.1)

form, hooks, grid and grid-hook are now copy-and-ownable. The ownable set
previously stopped at the server tier — the most portable output the
project emits — while the UI tier, where frameworks genuinely disagree,
could only be imported from its package.

Each template composes its package's public renderer and marks the
framework-coupled seam, so retargeting is a one-line change in a file the
adopter owns rather than a fork of the render pipeline."
```

---

### Task 5: `meta eject <generator>`

Makes ownership available after `init`, for any generator in any package — including ones added later.

**Files:**
- Create: `server/typescript/packages/cli/src/commands/eject.ts`
- Modify: `server/typescript/packages/cli/src/index.ts` (command registration — read the file to match how `gen`/`init` register)
- Test: `server/typescript/packages/cli/test/eject.test.ts` (create)

**Interfaces:**
- Consumes: `readReferenceTemplate` / `REFERENCE_GENERATOR_NAMES` from all three packages (Tasks 2–4).
- Produces: `ejectGenerator(opts: { cwd: string; name: string; force?: boolean }): Promise<{ path: string; importLine: string; status: "created" | "preserved" }>`.

- [ ] **Step 1: Write the failing test**

Create `server/typescript/packages/cli/test/eject.test.ts`:

```ts
// FR-040 §4.2(a) — eject copies a reference template into the consumer's repo so they
// own it, for any generator in any package, at any time after init.
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ejectGenerator } from "../src/commands/eject.js";

let cwd: string;
beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), "mo-eject-")); });
afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

describe("meta eject", () => {
  test("writes a UI-tier template and reports the local import line", async () => {
    const r = await ejectGenerator({ cwd, name: "form" });
    expect(r.status).toBe("created");
    const src = await readFile(join(cwd, "codegen/generators/form.ts"), "utf8");
    expect(src).toContain("REFERENCE TEMPLATE");
    expect(r.importLine).toContain('from "./codegen/generators/form.js"');
  });

  test("ejects a server-tier template from codegen-ts too", async () => {
    const r = await ejectGenerator({ cwd, name: "routes-hono" });
    expect(r.status).toBe("created");
    expect(await readFile(join(cwd, "codegen/generators/routes-hono.ts"), "utf8"))
      .toContain("// targets:");
  });

  test("never clobbers a hand-edited generator", async () => {
    await mkdir(join(cwd, "codegen/generators"), { recursive: true });
    await writeFile(join(cwd, "codegen/generators/form.ts"), "// MINE\n", "utf8");
    const r = await ejectGenerator({ cwd, name: "form" });
    expect(r.status).toBe("preserved");
    expect(await readFile(join(cwd, "codegen/generators/form.ts"), "utf8")).toBe("// MINE\n");
  });

  test("an unknown name errors and lists what IS ejectable", async () => {
    await expect(ejectGenerator({ cwd, name: "nope" })).rejects.toThrow(/form|hooks|entity/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd server/typescript/packages/cli && bun test test/eject.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

Create `server/typescript/packages/cli/src/commands/eject.ts`. Build one registry mapping a template name to its owning package's reader:

```ts
// FR-040 §4.2(a). One registry, three readers — a package that gains templates later
// registers here and eject picks it up with no other change.
import * as coreTpl from "@metaobjectsdev/codegen-ts";
import * as reactTpl from "@metaobjectsdev/codegen-ts-react";
import * as tanstackTpl from "@metaobjectsdev/codegen-ts-tanstack";

interface TemplateSource {
  names: readonly string[];
  read: (name: string) => string;
}

const SOURCES: TemplateSource[] = [
  { names: coreTpl.REFERENCE_GENERATOR_NAMES, read: (n) => coreTpl.readReferenceTemplate(n as never) },
  { names: reactTpl.REFERENCE_GENERATOR_NAMES, read: (n) => reactTpl.readReferenceTemplate(n as never) },
  { names: tanstackTpl.REFERENCE_GENERATOR_NAMES, read: (n) => tanstackTpl.readReferenceTemplate(n as never) },
];
```

`ejectGenerator` resolves `name` across `SOURCES`, throws listing every available name when unmatched, writes to `codegen/generators/<name>.ts` only when absent (returning `"preserved"` otherwise), and returns the `importLine` the consumer pastes into `metaobjects.config.ts`. Register the command so `meta eject <name>` and `meta eject --list` work; match the existing command-registration and output conventions in the CLI (read `src/commands/init.ts`'s result reporting first).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server/typescript/packages/cli && bun test test/eject.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Verify against a real scratch project**

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null
node <repo-root>/server/typescript/packages/cli/dist/index.js eject --list
```
Expected: lists `entity, queries, routes, routes-hono, barrel, form, hooks, grid, grid-hook`.

- [ ] **Step 6: Run the CLI suite**

Run: `cd server/typescript/packages/cli && bun test`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/cli/src/commands/eject.ts \
        server/typescript/packages/cli/src/index.ts \
        server/typescript/packages/cli/test/eject.test.ts
git commit -m "feat(cli): meta eject <generator> (FR-040 4.2a)

Copies any reference template into codegen/generators/ and reports the
local import line. Resolves across all three template-hosting packages,
so a package that gains templates later needs no eject change. Never
clobbers an existing file."
```

---

### Task 6: The `targets:` header contract on the original four templates

Completes the header contract Task 3 asserted and Task 3 Step 6 skipped.

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/reference/{entity,queries,routes,barrel}.ts`
- Modify: `server/typescript/packages/codegen-ts/test/reference-templates.test.ts` (unskip)

**Interfaces:**
- Consumes: the skipped test from Task 3 Step 6.
- Produces: nothing new; every reference template now declares `// targets:`.

- [ ] **Step 1: Unskip the header-contract test**

Change `test.skip` back to `test` in `reference-templates.test.ts` and delete the `// unskip in Task 6` comment.

- [ ] **Step 2: Run it to confirm it fails on the four**

Run: `cd server/typescript/packages/codegen-ts && bun test test/reference-templates.test.ts`
Expected: FAIL on `entity`, `queries`, `routes`, `barrel`.

- [ ] **Step 3: Add a `targets:` line to each**

Insert directly above the existing `// use-when:` line in each file. Each states what the emit is coupled to and which single call to swap:

- `entity.ts` — `// targets:  Drizzle ORM + Zod. The emitted module is a Drizzle table plus Zod insert/update schemas; the column mapping follows `dialect`. To emit for a different ORM or validator, replace the `renderEntityFile` call — the metadata walk that feeds it is ORM-neutral.`
- `queries.ts` — `// targets:  Drizzle. Emitted helpers take `db` as a PARAMETER rather than importing a module singleton, so they compose with any caller that already holds a connection — including a server-rendered component. Swap `renderQueriesFile` to emit for another query builder.`
- `routes.ts` — `// targets:  Fastify. The emitted file imports `mountCrudRoutes` from `@metaobjectsdev/runtime-ts/drizzle-fastify` and binds a module-singleton `db`. THIS is the file to retarget for another HTTP framework; see also the routes-hono template, whose deps-injected shape ports more easily to hosts that hand you a request.`
- `barrel.ts` — `// targets:  nothing framework-specific — it re-exports whatever the other generators emitted. `extStyle` decides whether the re-export specifiers carry a `.js` extension.`

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server/typescript/packages/codegen-ts && bun test test/reference-templates.test.ts`
Expected: PASS for all five names.

- [ ] **Step 5: Run the full package suite**

Run: `cd server/typescript/packages/codegen-ts && bun test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/typescript/packages/codegen-ts/src/reference \
        server/typescript/packages/codegen-ts/test/reference-templates.test.ts
git commit -m "docs(codegen): every reference template declares its targets: (FR-040 4.2)

The header block is the text an adopter's agent reads when a build breaks
in their own repo. Each template now states what its emit is coupled to
and which single call to swap, and a test enforces the line's presence so
a future template cannot ship without it."
```

---

### Task 7: The "Your framework isn't the default" skill section

Routes a symptom to the doctrine. Without this the previous six tasks exist and are not found.

**Files:**
- Modify: `agent-context/skills/metaobjects-codegen/SKILL.md` (insert after the "Write your own generators" section, before "### Never read metadata through an `own*()` accessor")
- Modify: `agent-context/skills/metaobjects-codegen/references/typescript.md`
- Test: `server/typescript/packages/sdk/test/` — locate the agent-context conformance test (`grep -rl "agent-context-conformance" server/typescript/packages`) and refresh fixtures per its instructions.

**Interfaces:**
- Consumes: `meta eject` (Task 5), the `targets:` contract (Task 6).
- Produces: skill prose only.

- [ ] **Step 1: Read the insertion point**

Run: `sed -n '145,195p' agent-context/skills/metaobjects-codegen/SKILL.md`
The new section follows the existing ownership argument and must not restate it.

- [ ] **Step 2: Write the section**

Insert into `SKILL.md`, worded as a decision procedure. **No framework may be named as a supported target**; framework names appear only as examples inside a category:

```markdown
## Your framework isn't the default — the retargeting procedure

The shipped reference templates emit for **Fastify on Node** (plus a Hono variant) with
Drizzle and Zod. If that is not your stack, retargeting is the **normal first move** — not
a workaround and not a sign of a bug. Each template's header carries a `targets:` line
naming exactly what its emit is coupled to and which call to swap.

Work the list in order; the first two cost nothing.

**1. Check the target-shaped config first.** Several apparent codegen failures are one
config value in `metaobjects.config.ts`:

- **`extStyle`** — `"js"` emits `./Entity.js` specifiers, correct for Node ESM and a plain
  `tsc` with `nodenext`. **Set `"none"` for any bundler-resolution toolchain** (Vite,
  Turbopack, webpack, esbuild, Rollup): most bundlers do not perform the TypeScript
  `.js`→`.ts` rewrite, so extensioned specifiers fail to resolve — including between two
  generated files, which makes the whole generated tree unresolvable.
- **`outDir`** / **`targets`** — where output lands, per generator.
- **`apiPrefix`**, **`dialect`** — route mounting and column mapping.

**2. Ask whether your framework splits the module graph.** Some frameworks compile server
and client from one source tree and resolve each half under *different export conditions*
(React Server Components, Angular universal, Qwik). Where they do:

- a generated artifact using client-only APIs may need a **marker directive** or a distinct
  import path, and
- the resulting error frequently **names a package that is installed and present** — because
  resolution failed under the server condition, not because the dependency is missing.

Read that error as a *boundary* problem, not a dependency problem. The fix belongs in the
generator that emits the artifact, which you own.

**3. If the emit is wrong for your framework, own the generator.**

    meta eject --list          # every template you can take ownership of
    meta eject form            # copies it to codegen/generators/form.ts

Then compose the engine and replace only the step that differs. Every generator's renderer
is exported, so this is usually a wrapper, not a rewrite:

```ts
// codegen/generators/form.ts — OWNED
import { renderFormFile } from "@metaobjectsdev/codegen-ts-react";

// ...inside generate():
const body = renderFormFile(entity, ctx.renderContext);
return { path, content: `"use client";\n` + body };   // your framework's requirement
```

You keep receiving upstream fixes to `renderFormFile` while owning the one line your
framework cares about. **Forking the whole renderer is the thing to avoid**, not owning the
generator.

**4. Server-tier output is usually already portable.** The entity module (a table plus
validation schemas) and the query helpers (which take `db` as a parameter rather than
importing a singleton) carry no HTTP-framework coupling — a server-rendered component can
call a generated query directly. Retargeting is usually only needed at the routes and UI
tiers.
```

- [ ] **Step 3: Add the `extStyle` reference row**

In `references/typescript.md`, find the config-options table or list and add an `extStyle` row with the same `"js"` vs `"none"` rule, cross-referencing the SKILL.md section. Keep it one line.

- [ ] **Step 4: Verify no framework is named as supported**

Run:
```bash
grep -n -i -e 'next\.js' -e 'nextjs' -e 'vercel' -e 'nuxt' -e 'svelte' \
  agent-context/skills/metaobjects-codegen/SKILL.md
```
Expected: **no matches.** The section names React Server Components, Angular universal and Qwik as *category examples* only — if any output names a framework as a target, rewrite that line.

- [ ] **Step 5: Refresh agent-context conformance fixtures**

Run: `grep -rl "agent-context-conformance" server/typescript/packages fixtures | head`
Then run that suite and regenerate the expected fixtures per its README. The scaffolded skills under `fixtures/agent-context-conformance/*/expected/.claude/skills/` must match the source skills byte-for-byte.

Run: `cd server/typescript && bun test --filter agent-context 2>&1 | tail -20`
Expected: PASS after regeneration.

- [ ] **Step 6: Verify the skill's YAML front-matter still parses**

Run: `head -5 agent-context/skills/metaobjects-codegen/SKILL.md`
Expected: intact `---`-delimited front-matter with `name:` and `description:`. (Four of six skills once shipped with broken front-matter and never intent-triggered — do not reintroduce that.)

- [ ] **Step 7: Commit**

```bash
git add agent-context/skills/metaobjects-codegen fixtures/agent-context-conformance
git commit -m "docs(skills): the retargeting procedure (FR-040 4.3)

The ownership doctrine was already published and still did not fire,
because nothing connected a symptom to it: no skill mentioned extStyle or
a split module graph, so a resolution error read as a broken tool rather
than as a generator to retarget.

Written as a decision procedure, not a framework list. Framework names
appear only as examples inside a category, so it serves a stack nobody
anticipated. A test-free guard: the task verifies no framework is named
as a supported target."
```

---

### Task 8: Make the TanStack Table v8 requirement discoverable

The one real library bug the reframe leaves standing. **v9 support is explicitly out of scope** — v9 removed `useReactTable`/`getCoreRowModel`, which `entity-grid.tsx` imports, so it is a migration, not a range widening.

**Files:**
- Modify: `client/web/packages/tanstack/README.md`
- Modify: `client/web/packages/tanstack/package.json` (comment-adjacent docs only — do NOT widen the range)
- Modify: `agent-context/skills/metaobjects-runtime-ui/references/tanstack.md`
- Test: `client/web/packages/tanstack/test/peer-range.test.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

- [ ] **Step 1: Confirm the incompatibility rather than assuming it**

```bash
npm view @tanstack/react-table dist-tags
grep -rn "useReactTable\|getCoreRowModel" client/web/packages/tanstack/src | head
```
Expected: `latest` is a 9.x, and the grid imports both removed APIs. Record the observed version in the commit message.

- [ ] **Step 2: Write the failing test**

Create `client/web/packages/tanstack/test/peer-range.test.ts`:

```ts
// FR-040 §4.4 — the published `latest` of react-table is a major ahead of what this
// package supports, so `npm i @tanstack/react-table` installs v9 and every subsequent
// install in that project fails ERESOLVE. The range is CORRECT; the requirement must be
// discoverable so an adopter does not hit it blind.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

describe("react-table peer requirement", () => {
  test("the peer range is bounded to v8", () => {
    expect(pkg.peerDependencies["@tanstack/react-table"]).toMatch(/\^8\./);
  });

  test("the README states the v8 pin and why a bare install breaks", () => {
    expect(readme).toMatch(/@tanstack\/react-table@\^8/);
    expect(readme).toMatch(/ERESOLVE/);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd client/web/packages/tanstack && bun test test/peer-range.test.ts`
Expected: FAIL on the README assertions.

- [ ] **Step 4: Document the requirement**

Add to `client/web/packages/tanstack/README.md`, near the top:

```markdown
## Install: TanStack Table v8 is required

This package supports `@tanstack/react-table` **v8** (`^8.20.0`). The registry's
`latest` is v9, which removed `useReactTable` and `getCoreRowModel` — both used by
`<EntityGrid>` — so v9 is a migration, not a version bump.

Install the supported major explicitly:

    npm i @tanstack/react-table@^8.21.3

A bare `npm i @tanstack/react-table` resolves v9, which does not satisfy this package's
peer range. npm then fails **every subsequent install in that project** with `ERESOLVE`
until v8 is pinned — so this is worth getting right the first time.
```

Add the same pin to the install snippet in `agent-context/skills/metaobjects-runtime-ui/references/tanstack.md`.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd client/web/packages/tanstack && bun test test/peer-range.test.ts`
Expected: PASS.

- [ ] **Step 6: Refresh agent-context fixtures if the skill changed**

Run the agent-context conformance suite identified in Task 7 Step 5 and regenerate if red.

- [ ] **Step 7: Commit**

```bash
git add client/web/packages/tanstack/README.md \
        client/web/packages/tanstack/test/peer-range.test.ts \
        agent-context/skills/metaobjects-runtime-ui/references/tanstack.md \
        fixtures/agent-context-conformance
git commit -m "docs(tanstack): make the react-table v8 requirement discoverable (FR-040 4.4)

The registry's latest is v9; this package peers ^8.20.0. A bare
`npm i @tanstack/react-table` therefore installs v9 and poisons the tree
— every later install in that project fails ERESOLVE until someone pins
v8 by hand, with nothing telling them to.

The range stays bounded: v9 removed useReactTable and getCoreRowModel,
both used by EntityGrid, so supporting it is a migration tracked
separately. This makes the existing requirement findable, and pins that
it stays documented."
```

---

### Task 9: `meta init` scaffold honesty

The two remaining nits from the probe. Independent of the ownership work.

**Files:**
- Modify: `server/typescript/packages/cli/src/commands/init.ts`
- Test: `server/typescript/packages/cli/test/init.test.ts` (locate the existing suite: `ls server/typescript/packages/cli/test/ | grep init`)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable.

- [ ] **Step 1: Read the two sites**

Run: `grep -n 'type": "module"\|dbImport' server/typescript/packages/cli/src/commands/init.ts`
Note the current message text and the scaffolded config value.

- [ ] **Step 2: Write the failing tests**

Add to the existing init suite:

```ts
test("the type:module notice names the file it modified", async () => {
  // The probe found this mutates a framework-owned manifest silently enough to surprise.
  const { warnings } = await runInitOnFixture({ packageJson: { name: "x", version: "1.0.0" } });
  const notice = warnings.find((w) => w.includes('"type": "module"'));
  expect(notice).toBeDefined();
  expect(notice).toContain("package.json");
});

test("scaffolded dbImport is commented, not an active dangling path", async () => {
  // queriesFile takes db as a parameter and the Hono routes take injected deps, so on
  // those stacks nothing consumes dbImport — an active value points at a file `init`
  // never creates.
  const { files } = await runInitOnFixture({});
  const cfg = files["metaobjects.config.ts"];
  expect(cfg).toMatch(/\/\/\s*dbImport:/);
});
```

Adapt `runInitOnFixture` to whatever helper the existing suite uses — read it first.

- [ ] **Step 3: Run to verify they fail**

Run: `cd server/typescript/packages/cli && bun test test/init.test.ts`
Expected: FAIL on both.

- [ ] **Step 4: Implement**

- Extend the `"type": "module"` notice to name `package.json` explicitly, e.g. `meta: set "type": "module" in your package.json — MetaObjects scaffolds and generates ESM, which a CommonJS project cannot compile. Revert it if your framework requires CommonJS.`
- Change the scaffolded `dbImport` line to a commented-out example with a one-line explanation that only a generator emitting `import { db } from …` needs it, and that `queriesFile`/`routesFileHono` do not.

- [ ] **Step 5: Run to verify they pass**

Run: `cd server/typescript/packages/cli && bun test test/init.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify the scaffold still works end to end**

```bash
cd "$(mktemp -d)" && npm init -y >/dev/null
node <repo-root>/server/typescript/packages/cli/dist/index.js init
```
Expected: scaffolds cleanly; `metaobjects.config.ts` has `dbImport` commented; the notice names `package.json`.

- [ ] **Step 7: Run the CLI suite**

Run: `cd server/typescript/packages/cli && bun test`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add server/typescript/packages/cli/src/commands/init.ts \
        server/typescript/packages/cli/test/init.test.ts
git commit -m "fix(cli): honest init scaffold — name the manifest, comment dbImport (FR-040 4.4)

init set \"type\": \"module\" on a framework-owned package.json without
naming the file it changed, and scaffolded an active dbImport pointing at
a file it never creates — which on a stack using queriesFile (db as a
parameter) plus deps-injected routes nothing consumes at all."
```

---

### Task 10: Optional — Next.js / Vercel recipe

**Do this only if the reviewer wants it.** Spec §4.5 classifies it as a *helper* justified by that stack's popularity, never as library capability. Removing it must cost nothing but convenience.

**Files:**
- Create: `docs/recipes/nextjs-vercel.md`

**Interfaces:**
- Consumes: Tasks 1–7.
- Produces: documentation only.

- [ ] **Step 1: Confirm the reviewer wants this task**

If not requested, mark this task skipped and stop. Adding it unasked contradicts the FR's own framing.

- [ ] **Step 2: Match the existing recipe format**

Run: `ls docs/recipes/ && head -40 docs/recipes/csharp-angular18.md`

- [ ] **Step 3: Write the recipe**

Cover, all verified during the probe: `extStyle: "none"`; `routesFileHono()` mounted at `app/api/[[...route]]/route.ts` via `hono/vercel` (the nine-line handler); the `"use client"` prepend in an ejected `form`/`hooks` generator; that generated query helpers are directly callable from a Server Component; that such a page **statically prerenders by default and will silently serve stale data** unless made dynamic; and Vercel's pooled-TCP guidance under Fluid compute (`attachDatabasePool` from `@vercel/functions`).

Open with a line stating this is a convenience path and that the general procedure lives in the `metaobjects-codegen` skill.

- [ ] **Step 4: Verify no library code changed**

Run: `git status --short`
Expected: only `docs/recipes/nextjs-vercel.md`. If any package file is modified, the recipe has leaked into the library — revert it.

- [ ] **Step 5: Commit**

```bash
git add docs/recipes/nextjs-vercel.md
git commit -m "docs(recipes): Next.js + Vercel adoption path (FR-040 4.5)

A helper, not a capability: every step is something the retargeting
procedure in the metaobjects-codegen skill already produces. No package
file changes."
```

---

### Task 11: `AGENTS.md` — stop promising per-framework packages

Found by the FR-040 content audit. This is the project's own architecture/context document
(`CLAUDE.md` is a **symlink** to it), and it currently commits to the exact model FR-040 rejects.

**Files:**
- Modify: `AGENTS.md:153` and `AGENTS.md:178`
- Test: none (prose). Verified by the grep in Step 4.

**Interfaces:**
- Consumes: Tasks 1–9 (the ownership model must actually work before the doc describes it).
- Produces: nothing importable.

- [ ] **Step 1: Read both sites and confirm the wording**

Run: `grep -n "Future" AGENTS.md | head`
Expect line 153 (`- Future: \`angular/\`, \`svelte/\`, \`react-native/\`.`) and line 178
(`Future framework integrations (Angular, Svelte, React Native) follow the same two-package pattern.`).

**CRITICAL:** `CLAUDE.md` is a symlink to `AGENTS.md`. Edit **`AGENTS.md`**. Never edit `CLAUDE.md`,
and never use `sed -i` on either — it replaces the symlink with a regular file and breaks the link.
Use the Edit tool.

- [ ] **Step 2: Replace line 153's bullet**

The list is of client-side package directories. Replace the `Future:` bullet with a statement of the
policy rather than a roadmap promise:

```
- MetaObjects does not add a first-party package per framework. React ships a codegen+runtime pair;
  Angular ships source-only (ADR-0048's promotion bar). Any other framework is reached by owning and
  retargeting the generators (FR-040), not by waiting for an official package.
```

- [ ] **Step 3: Replace line 178's sentence**

Replace `Future framework integrations (Angular, Svelte, React Native) follow the same two-package
pattern.` with:

```
The two-package split is the shape a first-party integration takes when there is one — it is not a
commitment to add more. Reaching another framework is an ownership move, not a roadmap item: eject
the generator and retarget its emit (FR-040).
```

- [ ] **Step 4: Verify the promise is gone and the symlink survived**

Run: `grep -n "svelte\|react-native\|React Native\|Svelte" AGENTS.md`
Expected: no line presenting them as planned first-party packages. A mention inside the new
"retarget it yourself" framing is correct and may remain.

Run: `test -L CLAUDE.md && echo "symlink intact" || echo "SYMLINK BROKEN — restore it"`
Expected: `symlink intact`. If broken, restore with `ln -sf AGENTS.md CLAUDE.md` before committing.

- [ ] **Step 5: Commit**

```bash
git add AGENTS.md
git commit -m "docs: stop promising a package per framework (FR-040 1)

The architecture doc committed to future first-party codegen+runtime pairs
for Svelte and React Native — the per-framework-package model FR-040 exists
to reject, stated in the project's own context file. It was also stale:
Angular was listed as future while it already ships source-only (ADR-0048).

Replaced with the policy: another framework is reached by owning and
retargeting a generator, not by waiting for a package."
```

---

### Task 12: `docs/ports/typescript-client.md` — the UI-tier doc an RSC adopter reads

**Files:**
- Modify: `docs/ports/typescript-client.md` (the generator sections, and lines 47–49)

**Interfaces:**
- Consumes: Tasks 4 (UI reference templates), 5 (`meta eject`), 7 (the skill section this links to).
- Produces: nothing importable.

- [ ] **Step 1: Read the file and locate the three edit points**

Run: `grep -n "Future framework\|formFile\|tanstackQuery\|Generated React forms" docs/ports/typescript-client.md | head -20`

- [ ] **Step 2: Fix the "future frameworks" sentence at lines 47–49**

Apply the same correction as Task 11 Step 3, worded for this page. Do not promise Svelte or
React Native packages.

- [ ] **Step 3: Add the ownership + module-graph note near the generator sections**

Insert once, above the "Generated React forms" section:

```markdown
> **These generators are yours.** `formFile()`, `tanstackQuery()`, `tanstackGrid()` and
> `tanstackGridHook()` are ordinary generators with reference templates you can take ownership of:
> `meta eject form` (or `hooks` / `grid` / `grid-hook`) copies one into `codegen/generators/`.
>
> If your framework compiles server and client from one tree and resolves each half under different
> export conditions — React Server Components, Angular universal, Qwik — an emitted client artifact
> may need a marker directive. That is a one-line change in the generator you own:
> `content = '"use client";\n' + renderFormFile(entity, ctx)`. A resolution error in that situation
> often names a package that IS installed; read it as a boundary problem, not a missing dependency.
> Full procedure: the `metaobjects-codegen` skill, "Your framework isn't the default".
```

- [ ] **Step 4: Verify no framework is presented as a supported target**

Run: `grep -n -i "next\.js\|nuxt\|qwik\|svelte" docs/ports/typescript-client.md`
Expected: matches only inside the category-example phrasing above (RSC / Angular universal / Qwik),
never as "MetaObjects supports X".

- [ ] **Step 5: Commit**

```bash
git add docs/ports/typescript-client.md
git commit -m "docs(ports): the UI tier is ownable, and it has a module-graph boundary (FR-040 3.1)

This is the page an adopter reads before hitting the RSC resolution failure.
It documented the four UI generators purely as things to wire, never said
they were ownable, and had no client/server module-graph content at all."
```

---

### Task 13: UI codegen package READMEs

**Files:**
- Modify: `server/typescript/packages/codegen-ts-react/README.md`
- Modify: `server/typescript/packages/codegen-ts-tanstack/README.md`

**Interfaces:**
- Consumes: Tasks 1, 4, 5.
- Produces: nothing importable.

- [ ] **Step 1: Add one paragraph to each, near "Usage"**

For `codegen-ts-react/README.md`:

```markdown
### The generator is yours

`formFile()` has a reference template: `meta eject form` copies it into `codegen/generators/form.ts`
for you to own. The emitted component is React with react-hook-form — if your framework needs a
marker directive or a different import shape, compose the exported renderer and change that one
step: `content = '"use client";\n' + renderFormFile(entity, ctx)`.
```

For `codegen-ts-tanstack/README.md`, the same paragraph naming `meta eject hooks` / `grid` /
`grid-hook` and `renderHooksFile` / `renderColumnsFile` / `renderGridHookFile`.

- [ ] **Step 2: Verify the constraint**

Run: `grep -n -i "next\.js\|nuxt\|svelte\|qwik" server/typescript/packages/codegen-ts-react/README.md server/typescript/packages/codegen-ts-tanstack/README.md`
Expected: **no matches.** These are shipped packages — the Global Constraint forbids naming a
framework as a target here, so the paragraph above deliberately names none.

- [ ] **Step 3: Commit**

```bash
git add server/typescript/packages/codegen-ts-react/README.md \
        server/typescript/packages/codegen-ts-tanstack/README.md
git commit -m "docs: the UI generators are ejectable and composable (FR-040 4.1/4.2)

First page an adopter reads on install; neither mentioned ownership."
```

---

### Task 14: `docs/llms/*` — the agent-facing quickstart teaches the deprecated import

The highest-severity content finding. These two files are what the website mirrors and what the
project tells AI assistants to read first, and their quickstart imports generators from the path
this repo documents as deprecated, never mentioning that `meta init` copies them into the adopter's
own repo.

**Files:**
- Modify: `docs/llms/llms-full.txt` (the config example around line 246)
- Modify: `docs/llms/llms.txt` (line 70)

**Interfaces:**
- Consumes: Tasks 1–9.
- Produces: the corrected source that the site's `www/llms*.txt` are copied from wholesale.

- [ ] **Step 1: Confirm both defects**

Run: `grep -n "codegen-ts/generators" docs/llms/llms-full.txt docs/llms/llms.txt`
Expected: `llms-full.txt:246` (inside the config example) and `llms.txt:70`.

- [ ] **Step 2: Fix the `llms-full.txt` quickstart**

Change the import block so it imports the OWNED local copies, matching what `meta init` actually
scaffolds and what `metaobjects.config.ts` in this repo's own docs shows:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
// Owned generators scaffolded by `meta init` (ADR-0034 scaffold-and-own) — these files are
// copied into YOUR repo and are yours to edit. The default emit targets Fastify on Node;
// retarget it by editing these, not by switching tools. `meta eject <name>` takes ownership
// of any other generator.
import { entityFile } from "./codegen/generators/entity.js";
import { queriesFile } from "./codegen/generators/queries.js";
import { routesFile } from "./codegen/generators/routes.js";
import { barrel } from "./codegen/generators/barrel.js";
```

Keep the surrounding `defineConfig({...})` body unchanged.

- [ ] **Step 3: Fix `llms.txt:70`**

Replace the clause naming the deprecated path with one describing ownership. The generators
"come from `codegen/generators/` in your own repo, copied there by `meta init` (ADR-0034); the
shipped defaults target Fastify/Drizzle and are retargeted by editing them."

- [ ] **Step 4: Verify**

Run: `grep -n "codegen-ts/generators" docs/llms/llms-full.txt docs/llms/llms.txt`
Expected: **no matches.**

- [ ] **Step 5: Commit**

```bash
git add docs/llms/llms-full.txt docs/llms/llms.txt
git commit -m "docs(llms): the agent-facing quickstart taught the deprecated import (FR-040 3.3)

These are the files the project tells an AI assistant to read first, and the
site mirrors them verbatim. Their quickstart imported generators from
@metaobjectsdev/codegen-ts/generators — the path this repo documents as
deprecated — and never mentioned that meta init copies them into the
adopter's own repo to own and retarget.

The site's www/llms*.txt are copied wholesale from these; do not hand-patch
the site copies or the two drift."
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §4.1 extend ownable set to UI tier | 3 (routes-hono), 4 (form/hooks/grid/grid-hook), 2 (reader) |
| §4.2(a) `meta eject` | 5 |
| §4.2(b) promote render layer to public API | 1 |
| §4.2 `targets:` header contract | 3 (new templates), 6 (original four) |
| §4.3 diagnostic skill section | 7 |
| §4.4 TanStack peer range | 8 |
| §4.4 init nits (`type: module`, `dbImport`) | 9 |
| §4.5 optional recipe | 10 (gated) |

No gaps.

**Type consistency:** `makeReferenceReader(moduleUrl, names)` (Task 2) is consumed with that exact signature in Task 4. `readReferenceTemplate` / `resolveReferenceRoot` / `REFERENCE_GENERATOR_NAMES` are produced identically by all three packages (Tasks 2, 4) and consumed uniformly in Task 5. Renderer signatures `(entity: MetaObject, ctx: RenderContext) => string` are verified in Task 1 and used in Tasks 3, 4 and 7. `ejectGenerator(opts) → { path, importLine, status }` is defined and used only in Task 5.

**Deliberate red states:** Task 2 Step 6 leaves the name-loop test failing on `routes-hono` until Task 3 ships the asset; Task 3 Step 6 skips the header-contract test until Task 6 completes it. Both are called out in their steps with instructions not to weaken the assertion. **Tasks 2, 3 and 6 must therefore land in order.** Tasks 8 and 9 are independent and may be done at any point.

**Open questions carried from the spec:** §6.1 (how small the exported render surface can be) is answered conservatively by Task 1 — four whole-file renderers, no sub-steps — deferring finer seams until an adopter needs one. §6.2 (import rewriting) is tested in Task 4 Step 1. §6.3 (`verify --codegen` vs ejected generators) was **not** addressed by any task; it has since been resolved — the gate needs no knowledge of ejection, and the round trip (eject → edit the owned generator → drift → `meta gen` → clean, with a hand edit surviving throughout) is pinned by `cli/test/integration/verify-codegen-ejected-generator.test.ts`. See the spec's §6.3 for the full answer, including why that gate must run in a subprocess. §6.4 (`"use client"` by default) is deliberately left to the adopter per §4.2.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-29-fr-040-framework-agnostic-codegen-ownership.md`. Two execution options:

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
