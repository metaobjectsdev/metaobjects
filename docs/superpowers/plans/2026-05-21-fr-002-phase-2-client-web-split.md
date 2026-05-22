# FR-002 Phase 2 — client/web Package Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose `@metaobjectsdev/runtime-ts-client` into three runtime packages under `client/web/packages/` (runtime-web, react, tanstack), lift the form-file generator into a new `@metaobjectsdev/codegen-ts-react` server-side package, update all in-tree consumers and CLAUDE.md, and delete `runtime-ts-client`. Single atomic PR; `bun test` from `server/typescript/` must remain at **2105 pass / 0 fail**.

**Architecture:** Five-package split following the Prisma/Apollo/Drizzle convention — codegen and runtime as **separate** packages per framework integration. Two disjoint dep trees: runtime (browser, zero Node deps) and codegen (server, zero React deps). Workspace declaration in `server/typescript/package.json` extends with a relative glob `../../client/web/packages/*` to pick up the new runtime packages without moving the workspace root.

**Tech Stack:** TypeScript 5.6, Bun 1.3.8 workspaces, ts-poet for codegen emit, React 19 + react-hook-form + TanStack Query/Table as runtime optional peer deps, Biome for format pass.

**Companion docs:**
- Spec: [docs/superpowers/specs/2026-05-21-fr-002-phase-2-client-web-split-design.md](../specs/2026-05-21-fr-002-phase-2-client-web-split-design.md)
- Downstream FR: the downstream consumer's own migration spec

---

## File Structure (target state)

**Created (Phase 2):**
- `client/web/packages/runtime-web/` — pure framework-agnostic core
  - `package.json`, `tsconfig.json`, `tsconfig.typecheck.json`, `README.md`
  - `src/currency.ts`, `src/filter-qs.ts`, `src/fetcher.ts`, `src/index.ts`
  - `test/currency.test.ts`, `test/filter-qs.test.ts`
- `client/web/packages/react/` — React runtime
  - `package.json`, `tsconfig.json`, `tsconfig.typecheck.json`
  - `src/use-entity-form.tsx`, `src/currency-input.tsx`, `src/index.ts`
  - `test/use-entity-form.test.tsx`, `test/currency-input.test.tsx`
- `client/web/packages/tanstack/` — TanStack runtime
  - `package.json`, `tsconfig.json`, `tsconfig.typecheck.json`
  - `src/entity-fetcher.tsx`, `src/cell-renderer-provider.tsx`, `src/cell-renderers.tsx`, `src/entity-grid.tsx`, `src/index.ts`
  - `test/entity-fetcher.test.tsx`, `test/entity-grid.test.tsx`
- `server/typescript/packages/codegen-ts-react/` — form-file generator
  - `package.json`, `tsconfig.json`, `tsconfig.typecheck.json`
  - `src/form-file.ts`, `src/templates/form-file.ts`, `src/entity-constants.ts`, `src/index.ts`
  - `test/form-file.test.ts`

**Modified:**
- `server/typescript/package.json` — workspace globs extended
- `server/typescript/packages/cli/package.json` + `src/lib/load-metaobjects-config.ts` + tests
- `server/typescript/packages/codegen-ts/src/generators/index.ts` — drop `formFile` re-export
- `server/typescript/packages/codegen-ts/src/templates/entity-constants.ts` — form-related strings extracted
- `server/typescript/packages/codegen-ts-tanstack/src/templates/{hooks-file.ts,grid-hook-file.ts}` — emitted import strings updated
- `server/typescript/packages/codegen-ts-tanstack/test/*.test.ts` — assertions on emitted imports updated
- `server/typescript/packages/forge/src/agent-docs/index.ts` — agent-docs string refs
- `server/typescript/packages/codegen-ts/test/golden/**` — regenerated
- `CLAUDE.md` — five-package convention; updated TS package layout table

**Deleted:**
- `server/typescript/packages/runtime-ts-client/` — entire directory
- `server/typescript/packages/codegen-ts/src/generators/form-file.ts`
- `server/typescript/packages/codegen-ts/src/templates/form-file.ts`
- `server/typescript/packages/codegen-ts/test/generators/form-file*.test.*` (assertions move to codegen-ts-react)

---

## Pre-flight (do once before Task 1)

- [ ] **Baseline test count** — confirm starting state:

```
cd <repo-root>/server/typescript
bun install
bun test 2>&1 | tail -3
```
Expected: **2105 pass / 0 fail** (the baseline cited in spec). Record exact number — every subsequent task must match or exceed this until the new packages add their own tests.

- [ ] **Create feature branch:**

```
cd <repo-root>
git checkout -b feat/fr-002-phase-2-client-web-split
```

- [ ] **Confirm clean tree:** `git status` → "nothing to commit, working tree clean".

---

## Task 1: Extend workspace globs

**Files:**
- Modify: `server/typescript/package.json`

- [ ] **Step 1: Extend the workspaces glob to include client/web.**

Open `server/typescript/package.json` and replace the `workspaces` array:

```json
"workspaces": ["packages/*", "../../client/web/packages/*"],
```

- [ ] **Step 2: Verify Bun accepts the relative glob.**

```
cd <repo-root>/server/typescript
bun install
```
Expected: install completes without "workspace pattern not found" or path errors. No client/web packages exist yet, so the glob just resolves to zero matches — that's fine, Bun should tolerate it.

If Bun rejects ascending relative globs (rare but possible on older versions), fall back to: create a root `package.json` at `<repo-root>/package.json` with the same `"name": "@metaobjectsdev/monorepo"` content plus `"workspaces": ["server/typescript/packages/*", "client/web/packages/*"]`, and remove the workspaces field from `server/typescript/package.json`. Update CLAUDE.md test-execution guidance accordingly in Task 13.

- [ ] **Step 3: Commit.**

```
git add server/typescript/package.json
git commit -m "chore(workspace): extend bun workspace glob to client/web/packages"
```

---

## Task 2: Scaffold runtime-web package

**Files:**
- Create: `client/web/packages/runtime-web/package.json`
- Create: `client/web/packages/runtime-web/tsconfig.json`
- Create: `client/web/packages/runtime-web/tsconfig.typecheck.json`
- Create: `client/web/packages/runtime-web/src/index.ts`
- Create: `client/web/packages/runtime-web/README.md`

- [ ] **Step 1: Create `package.json`.**

```json
{
  "name": "@metaobjectsdev/runtime-web",
  "version": "0.4.0",
  "description": "Pure framework-agnostic browser core for metaobjects: currency, filter URL serialization, fetcher contract types.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "bun": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "src", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.typecheck.json",
    "test": "bun test"
  },
  "dependencies": {
    "@metaobjectsdev/metadata": "workspace:*",
    "qs": "^6.13.0"
  },
  "devDependencies": {
    "@types/qs": "^6.9.0",
    "bun-types": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`** (copy structure from `server/typescript/packages/runtime-ts-client/tsconfig.json` and adjust).

```json
{
  "extends": "../../../../server/typescript/tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "test"]
}
```

Note: relative `extends` path goes up four levels (runtime-web → packages → web → client → metaobjects → server/typescript/tsconfig.base.json). Adjust if `tsconfig.base.json` lives elsewhere — confirm before writing:

```
ls <repo-root>/server/typescript/tsconfig.base.json
```

- [ ] **Step 3: Create `tsconfig.typecheck.json`** (mirror what other packages use).

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true
  },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 4: Create `src/index.ts` as an empty placeholder.**

```ts
// Public API surface for @metaobjectsdev/runtime-web.
// Sources populated in Tasks 3-4.
export {};
```

- [ ] **Step 5: Create `README.md`** (1-2 sentence stub).

```markdown
# @metaobjectsdev/runtime-web

Pure framework-agnostic browser core for metaobjects: currency formatting, filter URL serialization, and fetcher contract types. Zero React, zero TanStack, zero Node-only deps.
```

- [ ] **Step 6: Verify workspace resolution.**

```
cd <repo-root>/server/typescript
bun install
bun pm ls 2>&1 | grep runtime-web
```
Expected: `@metaobjectsdev/runtime-web@0.4.0` appears in workspace list.

- [ ] **Step 7: Typecheck the empty package.**

```
cd <repo-root>/client/web/packages/runtime-web
bun run typecheck
```
Expected: zero errors.

- [ ] **Step 8: Commit.**

```
git add client/web/packages/runtime-web/
git commit -m "feat(runtime-web): scaffold empty @metaobjectsdev/runtime-web package"
```

---

## Task 3: Move currency to runtime-web

**Files:**
- Move: `server/typescript/packages/runtime-ts-client/src/currency.ts` → `client/web/packages/runtime-web/src/currency.ts`
- Move: `server/typescript/packages/runtime-ts-client/test/currency.test.ts` → `client/web/packages/runtime-web/test/currency.test.ts` (if exists; otherwise create test in step 3)

- [ ] **Step 1: Check whether currency tests exist in runtime-ts-client.**

```
ls <repo-root>/server/typescript/packages/runtime-ts-client/test/ 2>/dev/null
```
If `currency.test.ts` exists, it moves with the source. If not, write a smoke test from scratch.

- [ ] **Step 2: Move the source file.**

```
cd <repo-root>
git mv server/typescript/packages/runtime-ts-client/src/currency.ts \
       client/web/packages/runtime-web/src/currency.ts
```

If a test file exists:

```
git mv server/typescript/packages/runtime-ts-client/test/currency.test.ts \
       client/web/packages/runtime-web/test/currency.test.ts
```

- [ ] **Step 3: If no test moved, write a smoke test at `client/web/packages/runtime-web/test/currency.test.ts`:**

```ts
import { expect, test, describe } from "bun:test";
import { formatCurrency, parseCurrency, minorUnitsFor } from "../src/currency.js";

describe("@metaobjectsdev/runtime-web — currency", () => {
  test("formatCurrency formats USD minor units", () => {
    expect(formatCurrency(1234, { currency: "USD", locale: "en-US" })).toBe("$12.34");
  });

  test("parseCurrency round-trips", () => {
    const minor = parseCurrency("$12.34", { currency: "USD", locale: "en-US" });
    expect(minor).toBe(1234);
  });

  test("minorUnitsFor returns 100 for USD", () => {
    expect(minorUnitsFor("USD")).toBe(100);
  });

  test("minorUnitsFor returns 1 for JPY (no fractional units)", () => {
    expect(minorUnitsFor("JPY")).toBe(1);
  });
});
```

- [ ] **Step 4: Update runtime-web's `src/index.ts`** to export currency:

```ts
// Public API surface for @metaobjectsdev/runtime-web.
export { formatCurrency, parseCurrency, minorUnitsFor } from "./currency.js";
```

- [ ] **Step 5: Remove the re-export from runtime-ts-client (it will reference the new location temporarily during transition).**

Open `server/typescript/packages/runtime-ts-client/src/index.ts` and remove the line:
```ts
export { formatCurrency, parseCurrency, minorUnitsFor } from "./currency.js";
```

If you want runtime-ts-client to keep working during the transition (because some files in runtime-ts-client still import it internally), replace with:
```ts
export { formatCurrency, parseCurrency, minorUnitsFor } from "@metaobjectsdev/runtime-web";
```

- [ ] **Step 6: Add runtime-ts-client → runtime-web workspace dep so the temporary re-export resolves.**

Open `server/typescript/packages/runtime-ts-client/package.json`, add to dependencies:
```json
"@metaobjectsdev/runtime-web": "workspace:*",
```

- [ ] **Step 7: Run tests.**

```
cd <repo-root>/server/typescript
bun install     # pick up the new workspace dep
bun test 2>&1 | tail -3
```
Expected: still **2105 pass / 0 fail** (currency tests pass in their new home; runtime-ts-client's re-export still works).

- [ ] **Step 8: Commit.**

```
git add -A
git commit -m "feat(runtime-web): move currency module from runtime-ts-client"
```

---

## Task 4: Move filter-qs + fetcher types to runtime-web

**Files:**
- Move: `server/typescript/packages/runtime-ts-client/src/tanstack/filter-builder.ts` → `client/web/packages/runtime-web/src/filter-qs.ts`
- Move type declarations: `server/typescript/packages/runtime-ts-client/src/tanstack/types.ts` → `client/web/packages/runtime-web/src/fetcher.ts`
- Extract type-only declarations from `server/typescript/packages/runtime-ts-client/src/tanstack/cell-renderers.ts` (the `CellRenderer<T>` interface) into the same `client/web/packages/runtime-web/src/fetcher.ts`.

- [ ] **Step 1: Read the source files to confirm what's type-only vs implementation.**

```
cat <repo-root>/server/typescript/packages/runtime-ts-client/src/tanstack/types.ts
cat <repo-root>/server/typescript/packages/runtime-ts-client/src/tanstack/filter-builder.ts
cat <repo-root>/server/typescript/packages/runtime-ts-client/src/tanstack/cell-renderers.ts
```

`types.ts` is pure types — moves whole.
`filter-builder.ts` is pure TS function — moves whole.
`cell-renderers.ts` mixes the `CellRenderer<T>` *interface* (type-only) with `defaultCellRenderers` (React components). Split them.

- [ ] **Step 2: Move filter-builder → filter-qs.**

```
cd <repo-root>
git mv server/typescript/packages/runtime-ts-client/src/tanstack/filter-builder.ts \
       client/web/packages/runtime-web/src/filter-qs.ts
```

- [ ] **Step 3: Move types.ts → fetcher.ts.**

```
git mv server/typescript/packages/runtime-ts-client/src/tanstack/types.ts \
       client/web/packages/runtime-web/src/fetcher.ts
```

- [ ] **Step 4: Extract CellRenderer interface from cell-renderers.ts and append to fetcher.ts.**

Read `server/typescript/packages/runtime-ts-client/src/tanstack/cell-renderers.ts`. Identify the `CellRenderer<T>` interface declaration (likely 5-15 lines). Copy it to the end of `client/web/packages/runtime-web/src/fetcher.ts`. Remove it from cell-renderers.ts. Leave `defaultCellRenderers` (the implementations) in place for now — they move in Task 7.

- [ ] **Step 5: Update import paths inside the moved files.**

In `client/web/packages/runtime-web/src/filter-qs.ts` and `client/web/packages/runtime-web/src/fetcher.ts`, any imports that pointed to `../*` (siblings in the tanstack dir) must repoint. Since both file are now siblings of each other in `runtime-web/src/`, change:
- `from "./types.js"` → `from "./fetcher.js"`
- (Any references to currency: should already be `from "../../currency.js"` → change to `from "./currency.js"`.)

- [ ] **Step 6: Update runtime-web's `src/index.ts`** to export the new modules:

```ts
// Public API surface for @metaobjectsdev/runtime-web.
export { formatCurrency, parseCurrency, minorUnitsFor } from "./currency.js";
export { buildFilterQs } from "./filter-qs.js";
export type { EntityFetcher, GridConfig, CellRenderer } from "./fetcher.js";
```

- [ ] **Step 7: Update runtime-ts-client's internal imports.**

In `server/typescript/packages/runtime-ts-client/src/tanstack/index.ts`, replace the local re-exports with re-exports from runtime-web:

```ts
export { buildFilterQs } from "@metaobjectsdev/runtime-web";
export type { EntityFetcher, GridConfig } from "@metaobjectsdev/runtime-web";
export type { CellRenderer } from "@metaobjectsdev/runtime-web";
// ...rest of the file stays
```

In any other file under `server/typescript/packages/runtime-ts-client/src/tanstack/*.tsx` that imports from `./types.js`, `./filter-builder.js`, or the `CellRenderer` type from `./cell-renderers.js`, update to import from `@metaobjectsdev/runtime-web`. Use grep to find them:

```
cd <repo-root>/server/typescript/packages/runtime-ts-client/src/tanstack
grep -ln 'from "\./types\|from "\./filter-builder\|CellRenderer' *.tsx *.ts
```

- [ ] **Step 8: Run tests.**

```
cd <repo-root>/server/typescript
bun test 2>&1 | tail -3
```
Expected: still **2105 pass / 0 fail**.

- [ ] **Step 9: Commit.**

```
git add -A
git commit -m "feat(runtime-web): move filter-qs + fetcher contract types"
```

---

## Task 5: Scaffold react package and move React-form sources

**Files:**
- Create: `client/web/packages/react/{package.json,tsconfig.json,tsconfig.typecheck.json,README.md,src/index.ts}`
- Move: `server/typescript/packages/runtime-ts-client/src/react/index.tsx` → `client/web/packages/react/src/use-entity-form.tsx`
- Move: `server/typescript/packages/runtime-ts-client/src/components/currency-input.tsx` → `client/web/packages/react/src/currency-input.tsx`
- Move: any matching tests under `runtime-ts-client/test/`

- [ ] **Step 1: Create `client/web/packages/react/package.json`:**

```json
{
  "name": "@metaobjectsdev/react",
  "version": "0.4.0",
  "description": "React runtime for metaobjects: useEntityForm hook and CurrencyInput component.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "bun": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "src", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.typecheck.json",
    "test": "bun test"
  },
  "dependencies": {
    "@metaobjectsdev/runtime-web": "workspace:*"
  },
  "peerDependencies": {
    "@hookform/resolvers": ">=3.0.0",
    "react": ">=18.0.0",
    "react-hook-form": ">=7.0.0",
    "zod": ">=3.23.0"
  },
  "peerDependenciesMeta": {
    "@hookform/resolvers": { "optional": true },
    "react": { "optional": true },
    "react-hook-form": { "optional": true },
    "zod": { "optional": true }
  },
  "devDependencies": {
    "@hookform/resolvers": "^3.10.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/dom": "^10.0.0",
    "@types/react": "^19.0.0",
    "bun-types": "latest",
    "jsdom": "^29.1.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "react-hook-form": "^7.54.0",
    "typescript": "^5.6.0",
    "zod": "^4.4.3"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` and `tsconfig.typecheck.json`** — mirror Task 2's pattern, but tsconfig.json's `include` covers `.tsx` too (the base config should already accept TSX; verify).

- [ ] **Step 3: Move the React sources.**

```
cd <repo-root>
git mv server/typescript/packages/runtime-ts-client/src/react/index.tsx \
       client/web/packages/react/src/use-entity-form.tsx
git mv server/typescript/packages/runtime-ts-client/src/components/currency-input.tsx \
       client/web/packages/react/src/currency-input.tsx
```

- [ ] **Step 4: Fix internal imports in the moved files.**

In `use-entity-form.tsx` and `currency-input.tsx`, any imports of `../currency.js` (relative path to old currency.ts) need to repoint:
```ts
import { formatCurrency } from "@metaobjectsdev/runtime-web";
```

- [ ] **Step 5: Move corresponding tests if they exist.**

```
ls <repo-root>/server/typescript/packages/runtime-ts-client/test/ 2>/dev/null
```
If tests for `useEntityForm` or `CurrencyInput` exist there, `git mv` them into `client/web/packages/react/test/`.

- [ ] **Step 6: Write react package's `src/index.ts`:**

```ts
// Public API surface for @metaobjectsdev/react.
export {
  useEntityForm,
  type EntityFieldMeta,
  type EntityMeta,
  type BoundInputProps,
  type InputAccessor,
  type UseEntityFormOptions,
  type UseEntityFormReturn,
} from "./use-entity-form.js";
export { CurrencyInput, type CurrencyInputProps } from "./currency-input.js";
```

(Confirm the exported symbol names match what's in the moved files — grep for `export` in each to verify.)

- [ ] **Step 7: Update runtime-ts-client to re-export from the new react package.**

In `server/typescript/packages/runtime-ts-client/src/index.ts`, replace any local `./react/index.js` and `./components/currency-input.js` re-exports with re-exports from `@metaobjectsdev/react`. Add `@metaobjectsdev/react` to runtime-ts-client's `dependencies` (workspace:*).

- [ ] **Step 8: Run tests + typecheck.**

```
cd <repo-root>/server/typescript
bun install
bun test 2>&1 | tail -3
bun run --filter '@metaobjectsdev/react' typecheck
```
Expected: **2105 pass / 0 fail**, typecheck clean.

- [ ] **Step 9: Commit.**

```
git add -A
git commit -m "feat(react): scaffold @metaobjectsdev/react with useEntityForm + CurrencyInput"
```

---

## Task 6: Scaffold tanstack package and move tanstack runtime sources

**Files:**
- Create: `client/web/packages/tanstack/{package.json,tsconfig.json,tsconfig.typecheck.json,README.md,src/index.ts}`
- Move: all `.tsx` files from `server/typescript/packages/runtime-ts-client/src/tanstack/` to `client/web/packages/tanstack/src/`
- Move the React-implementation half of `cell-renderers.ts` (renamed `cell-renderers.tsx` since it contains JSX)

- [ ] **Step 1: Create `client/web/packages/tanstack/package.json`:**

```json
{
  "name": "@metaobjectsdev/tanstack",
  "version": "0.4.0",
  "description": "TanStack runtime for metaobjects: EntityFetcherProvider, EntityGrid, default cell renderers.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "bun": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "src", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.typecheck.json",
    "test": "bun test"
  },
  "dependencies": {
    "@metaobjectsdev/runtime-web": "workspace:*",
    "@metaobjectsdev/react": "workspace:*"
  },
  "peerDependencies": {
    "@tanstack/react-query": ">=5.90.0",
    "@tanstack/react-table": ">=8.20.0",
    "react": ">=18.0.0"
  },
  "peerDependenciesMeta": {
    "@tanstack/react-query": { "optional": true },
    "@tanstack/react-table": { "optional": true },
    "react": { "optional": true }
  },
  "devDependencies": {
    "@tanstack/react-query": "^5.90.0",
    "@tanstack/react-table": "^8.20.0",
    "@testing-library/react": "^16.0.0",
    "@testing-library/dom": "^10.0.0",
    "@types/react": "^19.0.0",
    "bun-types": "latest",
    "jsdom": "^29.1.1",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` + `tsconfig.typecheck.json`** (same shape as react package).

- [ ] **Step 3: Move tanstack runtime sources.**

```
cd <repo-root>
git mv server/typescript/packages/runtime-ts-client/src/tanstack/entity-fetcher.tsx \
       client/web/packages/tanstack/src/entity-fetcher.tsx
git mv server/typescript/packages/runtime-ts-client/src/tanstack/cell-renderer-provider.tsx \
       client/web/packages/tanstack/src/cell-renderer-provider.tsx
git mv server/typescript/packages/runtime-ts-client/src/tanstack/entity-grid.tsx \
       client/web/packages/tanstack/src/entity-grid.tsx
```

For `cell-renderers.ts` (which still has the React implementations after Task 4 stripped its types):

```
git mv server/typescript/packages/runtime-ts-client/src/tanstack/cell-renderers.ts \
       client/web/packages/tanstack/src/cell-renderers.tsx
```

(File contains JSX; rename to `.tsx`.)

- [ ] **Step 4: Fix imports inside the moved files.**

Each moved file likely imported from `./types.js`, `./filter-builder.js`, `../currency.js`, etc. — all of which are now in `runtime-web`. Replace with `@metaobjectsdev/runtime-web` imports. Some may have imported from `./cell-renderers.js` for the type — change to `@metaobjectsdev/runtime-web` (since `CellRenderer` type lives there now per Task 4 step 4).

- [ ] **Step 5: Move the existing tanstack `index.ts` content into tanstack package's `src/index.ts`:**

```ts
// Public API surface for @metaobjectsdev/tanstack.
export { EntityFetcherProvider, useEntityFetcher } from "./entity-fetcher.js";
export type { EntityFetcherProviderProps } from "./entity-fetcher.js";
export type { EntityFetcher, GridConfig } from "@metaobjectsdev/runtime-web";
export { defaultCellRenderers } from "./cell-renderers.js";
export type { CellRenderer } from "@metaobjectsdev/runtime-web";
export {
  CellRendererProvider,
  useCellRenderers,
  type CellRendererProviderProps,
} from "./cell-renderer-provider.js";
export { EntityGrid, type EntityGridProps, type EntityGridState } from "./entity-grid.js";
export { buildFilterQs } from "@metaobjectsdev/runtime-web";
```

- [ ] **Step 6: Move tanstack tests** (if any exist in runtime-ts-client/test) into `client/web/packages/tanstack/test/`.

- [ ] **Step 7: Update runtime-ts-client to re-export from tanstack.**

In `server/typescript/packages/runtime-ts-client/src/index.ts`, the tanstack re-export block:

```ts
export {
  EntityFetcherProvider,
  useEntityFetcher,
  // ...all the tanstack symbols
} from "@metaobjectsdev/tanstack";
```

Add `@metaobjectsdev/tanstack: workspace:*` to runtime-ts-client's `dependencies`.

Delete `server/typescript/packages/runtime-ts-client/src/tanstack/index.ts` (its content has been replaced by the tanstack package's index).

- [ ] **Step 8: Run tests + typecheck.**

```
cd <repo-root>/server/typescript
bun install
bun test 2>&1 | tail -3
bun run --filter '@metaobjectsdev/tanstack' typecheck
```
Expected: **2105 pass / 0 fail**.

- [ ] **Step 9: Commit.**

```
git add -A
git commit -m "feat(tanstack): scaffold @metaobjectsdev/tanstack with EntityGrid + EntityFetcher + cell renderers"
```

---

## Task 7: Scaffold codegen-ts-react and move form-file generator

**Files:**
- Create: `server/typescript/packages/codegen-ts-react/{package.json,tsconfig.json,tsconfig.typecheck.json,README.md,src/index.ts}`
- Move: `server/typescript/packages/codegen-ts/src/generators/form-file.ts` → `server/typescript/packages/codegen-ts-react/src/form-file.ts`
- Move: `server/typescript/packages/codegen-ts/src/templates/form-file.ts` → `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts`
- Extract form-related constants from `server/typescript/packages/codegen-ts/src/templates/entity-constants.ts` into `server/typescript/packages/codegen-ts-react/src/entity-constants.ts`
- Move form-file tests from `codegen-ts/test/` to `codegen-ts-react/test/`

- [ ] **Step 1: Create `server/typescript/packages/codegen-ts-react/package.json`:**

```json
{
  "name": "@metaobjectsdev/codegen-ts-react",
  "version": "0.4.0",
  "description": "React codegen for metaobjects — emits <Entity>.form.tsx files using react-hook-form and @metaobjectsdev/react helpers.",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./src/index.ts",
  "exports": {
    ".": {
      "bun": "./src/index.ts",
      "types": "./src/index.ts",
      "default": "./dist/index.js"
    }
  },
  "files": ["dist", "src"],
  "scripts": {
    "build": "tsc -p .",
    "typecheck": "tsc -p tsconfig.typecheck.json",
    "test": "bun test"
  },
  "dependencies": {
    "@metaobjectsdev/metadata": "workspace:*",
    "@metaobjectsdev/codegen-ts": "workspace:*",
    "ts-poet": "^6.10.0"
  },
  "peerDependencies": {
    "@biomejs/biome": ">=1.9.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "bun-types": "latest",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json` + `tsconfig.typecheck.json`** matching `codegen-ts-tanstack`'s shape:

`tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src",
    "composite": true
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "test"]
}
```

`tsconfig.typecheck.json`:
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": true },
  "include": ["src/**/*", "test/**/*"]
}
```

- [ ] **Step 3: Move the form-file generator + template.**

```
cd <repo-root>
git mv server/typescript/packages/codegen-ts/src/generators/form-file.ts \
       server/typescript/packages/codegen-ts-react/src/form-file.ts
mkdir -p server/typescript/packages/codegen-ts-react/src/templates
git mv server/typescript/packages/codegen-ts/src/templates/form-file.ts \
       server/typescript/packages/codegen-ts-react/src/templates/form-file.ts
```

- [ ] **Step 4: Update emitted import strings inside the moved template.**

Open `server/typescript/packages/codegen-ts-react/src/templates/form-file.ts`. Find any line that emits an import string referencing `@metaobjectsdev/runtime-ts-client`:

- `"@metaobjectsdev/runtime-ts-client/react"` → `"@metaobjectsdev/react"`
- `"@metaobjectsdev/runtime-ts-client"` (for CurrencyInput) → `"@metaobjectsdev/react"`
- `"@metaobjectsdev/runtime-ts-client"` (for formatCurrency) → `"@metaobjectsdev/runtime-web"`

Use grep to find every occurrence:

```
grep -n "@metaobjectsdev/runtime-ts-client" server/typescript/packages/codegen-ts-react/src/templates/form-file.ts
```

Apply the replacements. Also check `server/typescript/packages/codegen-ts-react/src/form-file.ts` for any embedded strings.

- [ ] **Step 5: Extract form-related constants from codegen-ts entity-constants.ts.**

Read `server/typescript/packages/codegen-ts/src/templates/entity-constants.ts`. Identify constants that hold strings used **only by form generation** (e.g., `RUNTIME_REACT_FORM_PATH`, `CURRENCY_INPUT_IMPORT`, etc.). Move them to a new file `server/typescript/packages/codegen-ts-react/src/entity-constants.ts`. Constants used by `entity-file.ts`, `queries-file.ts`, `routes-file.ts` STAY in codegen-ts.

If a single constant is used by both codegen-ts and codegen-ts-react, leave it in codegen-ts and have codegen-ts-react import it:
```ts
import { ENTITY_CONST } from "@metaobjectsdev/codegen-ts";
```

- [ ] **Step 6: Write codegen-ts-react's `src/index.ts`:**

```ts
// Public API surface for @metaobjectsdev/codegen-ts-react.
export { formFile, type FormFileOpts } from "./form-file.js";
```

(Confirm the actual exported names from the moved `form-file.ts` and adjust if different.)

- [ ] **Step 7: Remove `formFile` from `codegen-ts/src/generators/index.ts`.**

Open `server/typescript/packages/codegen-ts/src/generators/index.ts`. Remove any line re-exporting `formFile` or `FormFileOpts`. The generator factory now ships exclusively from `@metaobjectsdev/codegen-ts-react`.

- [ ] **Step 8: Move form-file tests.**

```
ls <repo-root>/server/typescript/packages/codegen-ts/test/generators/ | grep -i form
```
For each test file related to `form-file`:
```
git mv server/typescript/packages/codegen-ts/test/generators/<file> \
       server/typescript/packages/codegen-ts-react/test/<file>
```
Update test imports — `from "@metaobjectsdev/codegen-ts/generators"` → `from "@metaobjectsdev/codegen-ts-react"`.

- [ ] **Step 9: Audit codegen-ts/test/generators/factories.test.ts for form-file assertions.**

```
grep -n "form-file\|formFile" server/typescript/packages/codegen-ts/test/generators/factories.test.ts
```
Remove any blocks that assert against the form-file factory; those move to a new test in codegen-ts-react.

- [ ] **Step 10: Run tests + typecheck.**

```
cd <repo-root>/server/typescript
bun install
bun test 2>&1 | tail -3
bun run --filter '@metaobjectsdev/codegen-ts-react' typecheck
bun run --filter '@metaobjectsdev/codegen-ts' typecheck
```

⚠️ At this point, the test count may **drop** because some golden snapshots reference the old `@metaobjectsdev/runtime-ts-client/react` import in generated form files — they'll fail snapshot comparison. That's expected; the next task regenerates them.

If tests drop, record the new pass count. Goldens regenerate in Task 9.

- [ ] **Step 11: Commit.**

```
git add -A
git commit -m "feat(codegen-ts-react): scaffold @metaobjectsdev/codegen-ts-react and move form-file generator"
```

---

## Task 8: Update codegen-ts-tanstack emitted imports

**Files:**
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/templates/hooks-file.ts`
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/templates/grid-hook-file.ts`
- Modify: `server/typescript/packages/codegen-ts-tanstack/src/grid-filter-validate.ts` (if it embeds import strings)
- Modify: `server/typescript/packages/codegen-ts-tanstack/test/*.test.ts` — assertions update

- [ ] **Step 1: Grep for the old package name in templates.**

```
grep -rn "@metaobjectsdev/runtime-ts-client" server/typescript/packages/codegen-ts-tanstack/src/
```

- [ ] **Step 2: Replace every occurrence with `@metaobjectsdev/tanstack`.**

In every matched file, change the literal string `"@metaobjectsdev/runtime-ts-client"` → `"@metaobjectsdev/tanstack"`.

- [ ] **Step 3: Update test assertions.**

```
grep -rn "@metaobjectsdev/runtime-ts-client" server/typescript/packages/codegen-ts-tanstack/test/
```
Replace in each matched file.

- [ ] **Step 4: Run codegen-ts-tanstack tests.**

```
cd <repo-root>/server/typescript
bun test --filter '@metaobjectsdev/codegen-ts-tanstack' 2>&1 | tail -5
```
Expected: codegen-ts-tanstack's own tests pass. Golden snapshots in codegen-ts may still be out of date — that's the next task.

- [ ] **Step 5: Commit.**

```
git add server/typescript/packages/codegen-ts-tanstack/
git commit -m "feat(codegen-ts-tanstack): retarget emitted imports to @metaobjectsdev/tanstack"
```

---

## Task 9: Regenerate golden snapshots

**Files:**
- Modify: All files under `server/typescript/packages/codegen-ts/test/golden/__snapshots__/`

- [ ] **Step 1: Identify the snapshot regeneration command.**

```
cd <repo-root>/server/typescript/packages/codegen-ts
cat package.json | grep -A 1 '"scripts"'
```
The golden tests should have an update mechanism. In Bun, snapshot tests use `expect(...).toMatchSnapshot()` and regenerate with `bun test --update-snapshots`. If the goldens are file-based fixtures (not Bun snapshots), find the regen script.

```
ls test/golden/
cat test/golden/run.sh 2>/dev/null || true
```

- [ ] **Step 2: Regenerate.**

If Bun snapshots: `bun test --update-snapshots`
If file-based fixtures: run whatever regen script the codegen-ts package provides (e.g., `bun run test:update-goldens`).

If no regen script exists, regenerate by running the generators against the fixture metadata and writing output to the snapshot dir. Inspect `test/generators/factories.test.ts` and any `test/golden/*.test.ts` for the existing regeneration entry point.

- [ ] **Step 3: Inspect the diff.**

```
git diff --stat server/typescript/packages/codegen-ts/test/golden/
```
Expected: many files changed, each with only import-string diffs (`@metaobjectsdev/runtime-ts-client` → `@metaobjectsdev/react` / `@metaobjectsdev/tanstack` / `@metaobjectsdev/runtime-web`). No structural or logic changes.

```
git diff server/typescript/packages/codegen-ts/test/golden/ | grep "^[+-]" | grep -v "^[+-]\{3\}" | grep -v "@metaobjectsdev/" | head
```
Expected output: empty (every changed line should be an import string). If non-import lines appear, investigate — something else regressed.

- [ ] **Step 4: Run full test suite.**

```
cd <repo-root>/server/typescript
bun test 2>&1 | tail -3
```
Expected: **2105 pass / 0 fail** (baseline restored, possibly higher if the new packages added tests).

- [ ] **Step 5: Commit.**

```
git add server/typescript/packages/codegen-ts/test/golden/
git commit -m "test(codegen-ts): regenerate golden snapshots after package rename"
```

---

## Task 10: Delete runtime-ts-client

**Files:**
- Delete: `server/typescript/packages/runtime-ts-client/` (entire directory)

- [ ] **Step 1: Verify nothing inside `server/` still imports from runtime-ts-client.**

```
cd <repo-root>
grep -rln "@metaobjectsdev/runtime-ts-client" --include="*.ts" --include="*.tsx" --include="*.json" \
  server/ client/ 2>/dev/null | grep -v node_modules | grep -v dist | grep -v "/runtime-ts-client/" | grep -v "/golden/"
```
Expected: empty (no consumers remain). If anything matches, fix that file first.

- [ ] **Step 2: Delete the package.**

```
git rm -r server/typescript/packages/runtime-ts-client/
```

- [ ] **Step 3: Verify install + tests.**

```
cd <repo-root>/server/typescript
bun install
bun test 2>&1 | tail -3
```
Expected: **2105 pass / 0 fail** (or higher).

- [ ] **Step 4: Commit.**

```
git commit -m "refactor: delete @metaobjectsdev/runtime-ts-client (split into runtime-web + react + tanstack)"
```

---

## Task 11: Update in-tree consumers (cli + forge)

**Files:**
- Modify: `server/typescript/packages/cli/package.json` — add codegen-ts-react workspace dep
- Modify: `server/typescript/packages/cli/src/lib/load-metaobjects-config.ts` + tests — string refs
- Modify: `server/typescript/packages/forge/src/agent-docs/index.ts` — string refs
- Modify: `server/typescript/packages/codegen-ts/src/templates/entity-constants.ts` — if any tanstack-related strings remain that should be in codegen-ts-tanstack

- [ ] **Step 1: Add codegen-ts-react dep to cli.**

Open `server/typescript/packages/cli/package.json`. Under `dependencies` add:
```json
"@metaobjectsdev/codegen-ts-react": "workspace:*",
```

- [ ] **Step 2: Update cli source + tests.**

```
grep -n "@metaobjectsdev/runtime-ts-client\|@metaobjectsdev/codegen-ts-tanstack" \
  server/typescript/packages/cli/src/lib/load-metaobjects-config.ts \
  server/typescript/packages/cli/test/unit/load-metaobjects-config.test.ts \
  server/typescript/packages/cli/test/unit/init-refresh-docs.test.ts
```

For every reference:
- `@metaobjectsdev/runtime-ts-client` → split per usage: `@metaobjectsdev/react`, `@metaobjectsdev/tanstack`, or `@metaobjectsdev/runtime-web` (use the runtime-web mapping from Task 4-6).
- `@metaobjectsdev/codegen-ts-tanstack` stays as-is (package name unchanged).
- Add new references to `@metaobjectsdev/codegen-ts-react` where the CLI documents/scaffolds form generation.

- [ ] **Step 3: Update forge agent-docs.**

```
grep -n "@metaobjectsdev/runtime-ts-client\|@metaobjectsdev/codegen-ts-tanstack" \
  server/typescript/packages/forge/src/agent-docs/index.ts
```
Update the same way.

- [ ] **Step 4: Run tests.**

```
cd <repo-root>/server/typescript
bun install
bun test 2>&1 | tail -3
```
Expected: **2105 pass / 0 fail** (or higher).

- [ ] **Step 5: Commit.**

```
git add server/typescript/packages/cli/ server/typescript/packages/forge/
git commit -m "refactor(cli,forge): update package references to new client/web layout"
```

---

## Task 12: Update CLAUDE.md

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the TS package layout section.**

Open `CLAUDE.md`. Find the "## TS package layout" section. Replace the **Client-side / universal web** subsection's package list with:

```markdown
**Client-side / universal web** (`client/web/packages/`):
- `runtime-web/` (`@metaobjectsdev/runtime-web`) — pure framework-agnostic core: currency, filter URL serialization, fetcher contract types. Zero React, zero TanStack.
- `react/` (`@metaobjectsdev/react`) — React runtime: `useEntityForm`, `<CurrencyInput>`.
- `tanstack/` (`@metaobjectsdev/tanstack`) — TanStack runtime: `EntityFetcherProvider`, `<EntityGrid>`, default cell renderers.
- Future: `angular/`, `svelte/`, `react-native/`.
```

Add to **Server-side** (`server/typescript/packages/`):
```markdown
- `codegen-ts-react/` (`@metaobjectsdev/codegen-ts-react`) — React codegen: `formFile()`.
```

(Keep `codegen-ts-tanstack/` where it already is in the list.)

- [ ] **Step 2: Replace the "Framework integration package anatomy" section.**

The current section describes a multi-entry codegen+runtime+dynamic package. Replace it with:

```markdown
### Framework integration: separate codegen and runtime packages

Each framework integration ships as a **pair** of packages — one for codegen (server-side, runs at `meta gen` time) and one for runtime (browser-side, runs in the user's app). Mirrors Prisma (`prisma` + `@prisma/client`), Apollo (`@apollo/codegen-cli` + `@apollo/client`), and Drizzle (`drizzle-kit` + `drizzle-orm`).

| Integration | Codegen | Runtime |
|---|---|---|
| React | `@metaobjectsdev/codegen-ts-react` | `@metaobjectsdev/react` |
| TanStack (depends on React) | `@metaobjectsdev/codegen-ts-tanstack` | `@metaobjectsdev/tanstack` |

Each codegen package emits imports that target its matching runtime package. Codegen packages live under `server/typescript/packages/` because they execute server-side, even though their output targets the browser. Runtime packages live under `client/web/packages/` and have zero Node-only deps.

Future framework integrations (Angular, Svelte, React Native) follow the same two-package pattern.
```

- [ ] **Step 3: Update the user-facing `metaobjects.config.ts` example.**

Find the example that uses `tanstackQuery`/`tanstackGrid` imports. Update to:

```ts
import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile, queriesFile, routesFile, barrel } from "@metaobjectsdev/codegen-ts/generators";
import { formFile } from "@metaobjectsdev/codegen-ts-react";
import { tanstackQuery, tanstackGrid } from "@metaobjectsdev/codegen-ts-tanstack";

export default defineConfig({
  outDir: "packages/database/src/generated",
  dialect: "sqlite",
  apiPrefix: "/api",
  generators: [
    entityFile(),
    queriesFile(),
    routesFile(),
    formFile(),
    tanstackQuery(),
    tanstackGrid(),
    barrel(),
  ],
});
```

- [ ] **Step 4: Update the "Running tests" section** if Task 1's workspace change affects test-run instructions.

Verify the existing "cd typescript && bun test" guidance was updated post-Phase-1 to `cd server/typescript`. If it wasn't, fix it now. The Task-1 workspace extension does NOT change the test-execution location — it stays at `cd server/typescript`.

- [ ] **Step 5: Commit.**

```
git add CLAUDE.md
git commit -m "docs(claude-md): five-package split convention + updated TS layout table"
```

---

## Task 13: Final verification

- [ ] **Step 1: Clean install from scratch.**

```
cd <repo-root>/server/typescript
rm -rf node_modules
bun install
```
Expected: clean install, no resolution errors, all new packages discovered.

- [ ] **Step 2: Full test suite.**

```
bun test 2>&1 | tail -3
```
Expected: **2105 pass / 0 fail** (or higher if new packages added smoke tests).

- [ ] **Step 3: Full typecheck.**

```
bun run --filter '*' typecheck
```
Expected: zero errors.

- [ ] **Step 4: Confirm no stale references remain.**

```
cd <repo-root>
grep -rln "@metaobjectsdev/runtime-ts-client" --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md" \
  server/ client/ docs/ CLAUDE.md 2>/dev/null | grep -v node_modules | grep -v dist
```
Expected: empty. Every reference to the old package is gone (except possibly historical mentions in `docs/superpowers/specs/` and `docs/superpowers/plans/`, which is fine).

- [ ] **Step 5: Runtime-web purity spot-check (manual).**

```
cd /tmp && rm -rf rw-check && mkdir rw-check && cd rw-check
bun init -y
bun add file:<repo-root>/client/web/packages/runtime-web
ls node_modules/ | sort
```
Expected: `node_modules/` contains `@metaobjectsdev/runtime-web`, `@metaobjectsdev/metadata`, `qs`, and their non-React/non-Node-only transitive deps only. There should be **no `react`, no `ts-poet`, no `@biomejs/biome`, no `@tanstack/*`** in the resolved tree.

If any of those appear: a dependency leaked into runtime-web. Track it down by `bun pm why <pkg>` and fix the dep declaration in the offending workspace package.

- [ ] **Step 6: Git status check.**

```
cd <repo-root>
git status
git log --oneline main..HEAD
```
Expected: clean working tree, ~12 commits on the feature branch.

- [ ] **Step 7: Final commit (if any cleanup needed) and push.**

```
git push -u origin feat/fr-002-phase-2-client-web-split
```

(Do not merge to main — the user reviews the PR / merges manually.)

---

## Self-Review Notes

This refactor is large, but every step has a verification command. If any step's verification fails, **stop and fix before continuing** — the PR is atomic and intermediate breakage propagates.

If a step's listed file paths don't exist (e.g., a `currency.test.ts` file presumed to exist isn't there), document the deviation in the commit message and either write a fresh smoke test (per Task 3 step 3) or skip the move sub-step for that file.

The relative workspace glob `../../client/web/packages/*` is the primary approach. If Bun rejects it at Task 1 step 2, fall back to a root `package.json` at `<repo-root>/` and remove the workspaces field from `server/typescript/package.json`. The fallback must also include the test-execution warning ("don't `bun test` from repo root") in CLAUDE.md.

Goldens regenerate cleanly only if the import-string updates in Tasks 7-8 are complete. If Task 9's diff includes non-import changes, those signal a regression — investigate before committing the goldens.
