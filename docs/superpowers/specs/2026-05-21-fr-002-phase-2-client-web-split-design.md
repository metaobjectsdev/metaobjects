# FR-002 Phase 2 — client/web package split

**Date:** 2026-05-21
**Status:** Design (ready for implementation plan)
**Scope:** Decompose `@metaobjectsdev/runtime-ts-client` into three runtime packages under `client/web/packages/`, lift the form-file generator into its own `@metaobjectsdev/codegen-ts-react` package, and update all in-tree consumers + CLAUDE.md. Single atomic PR.

## Background

This is the second phase of FR-002, the implementation of the polyglot layout rule (FR-001). The rule, codified in CLAUDE.md by commit `77a9938`, says: **the top-level discriminator is deployment target** — `server/<lang>/` for server-side code, `client/<platform>/` for end-user devices.

**Phase 1 (shipped 2026-05-21, commit `d04c2c0`)** moved the language directories under `server/<lang>/`. The empty `client/web/packages/` directory was created as a placeholder.

**Phase 2 (this doc)** populates `client/web/packages/` and refactors codegen to match the polyglot principle. After Phase 2, every package's role is unambiguous: a browser-only consumer's lockfile carries no `ts-poet` or `biome`; a `meta gen` invocation never resolves React.

The original CLAUDE.md anatomy described a combined "codegen + runtime + dynamic" package per framework integration (mirroring drizzle-orm's multi-entry pattern). On closer inspection, **none of the named reference libraries actually combine codegen and runtime in one package** — Prisma splits `prisma` (codegen) from `@prisma/client` (runtime), Apollo splits `@apollo/codegen-cli` from `@apollo/client`, Drizzle splits `drizzle-kit` from `drizzle-orm`. Multi-entry packages exist in those libraries, but only for runtime variants (dialects, framework adapters). Phase 2 corrects the design to match the industry convention: codegen and runtime ship as separate packages per framework integration. CLAUDE.md gets updated to match.

## Goal

After Phase 2 ships:

1. Browser-side runtime lives under [client/web/packages/](../../../client/web/packages/) as three packages: `runtime-web` (pure core), `react` (React layer), `tanstack` (TanStack layer).
2. Server-side codegen lives under [server/typescript/packages/](../../../server/typescript/packages/) as three packages: `codegen-ts` (framework-neutral, unchanged role), `codegen-ts-react` (new, owns the form-file generator), `codegen-ts-tanstack` (unchanged location, emits updated imports).
3. `@metaobjectsdev/runtime-ts-client` is deleted. Its contents have moved to one of the three new runtime packages.
4. `@metaobjectsdev/codegen-ts/templates/form-file.ts` is deleted from codegen-ts. The generator moves to `codegen-ts-react`.
5. All in-tree consumers (cli, forge, generator tests, golden snapshots, CLAUDE.md) point at the new packages.
6. `bun test` from `server/typescript/` = 2105 pass / 0 fail (baseline preserved).

## Non-goals

- **Downstream consumer migration.** downstream-consumer (and any other site linking the workspace) updates separately. The downstream-consumer FR is already written at `downstream-consumer/specs/FR-002-metaobjects-pkg-migration/spec.md`.
- **`dynamic/` layer.** Metadata-driven runtime behavior (CRUD, validation, admin UIs driven by metadata at runtime) is a **server-side** concept and is out of scope. No client-side `dynamic/` directories or exports are created.
- **npm publishing.** Deferred to H7. All packages remain workspace-internal until then.
- **C# / Java / Python ports of the runtime packages.** TS-only restructure.
- **Renaming `codegen-ts-tanstack`.** The existing name follows the `codegen-ts-<framework>` convention. Renaming would be churn for no gain.
- **Generator API changes.** The `Generator` / `GenContext` / `EmittedFile` contracts from `@metaobjectsdev/codegen-ts` stay identical. New packages just provide additional `Generator` implementations.

## Target package layout

```
metaobjects/
├── server/typescript/packages/
│   ├── codegen-ts/                       # @metaobjectsdev/codegen-ts (framework-neutral)
│   │   └── (entityFile, queriesFile, routesFile, barrel)
│   ├── codegen-ts-react/                 # @metaobjectsdev/codegen-ts-react (NEW)
│   │   └── (formFile)
│   └── codegen-ts-tanstack/              # @metaobjectsdev/codegen-ts-tanstack (existing)
│       └── (tanstackQuery, tanstackGrid, tanstackGridHook)
│
└── client/web/packages/
    ├── runtime-web/                      # @metaobjectsdev/runtime-web
    │   └── src/
    │       ├── currency.ts               # formatCurrency, parseCurrency, minorUnitsFor
    │       ├── filter-qs.ts              # buildFilterQs
    │       ├── fetcher.ts                # EntityFetcher interface + CellRenderer<T> types
    │       └── index.ts
    ├── react/                            # @metaobjectsdev/react
    │   └── src/
    │       ├── use-entity-form.tsx       # useEntityForm + types
    │       ├── currency-input.tsx        # <CurrencyInput>
    │       └── index.ts
    └── tanstack/                         # @metaobjectsdev/tanstack
        └── src/
            ├── entity-fetcher.tsx        # EntityFetcherProvider + useEntityFetcher
            ├── cell-renderer-provider.tsx
            ├── cell-renderers.tsx        # defaultCellRenderers (React JSX)
            ├── entity-grid.tsx           # <EntityGrid>
            └── index.ts
```

Codegen packages stay flat-export (single `.` entry) — they're consumed only by `metaobjects.config.ts`. Runtime packages also stay flat-export — they're consumed by hand-written app code and by generated files; a single entry keeps imports short.

## Dependency graph

Two disjoint trees, no cross-edges:

```
Runtime side (browser):              Codegen side (server):

  @metaobjectsdev/runtime-web ←┐         @metaobjectsdev/codegen-ts ←┐
        ↑                    \              ↑                   \
        └── @metaobjectsdev/react ┐             ├── @metaobjectsdev/codegen-ts-react
                ↑               \            └── @metaobjectsdev/codegen-ts-tanstack
                └── @metaobjectsdev/tanstack
```

| Package | `dependencies` | `peerDependencies` (all optional) |
|---|---|---|
| `runtime-web` | `@metaobjectsdev/metadata`, `qs` | — |
| `react` | `@metaobjectsdev/runtime-web` | `react`, `react-hook-form`, `@hookform/resolvers`, `zod` |
| `tanstack` | `@metaobjectsdev/runtime-web`, `@metaobjectsdev/react` | `react`, `@tanstack/react-query`, `@tanstack/react-table` |
| `codegen-ts` | `@metaobjectsdev/metadata`, `ts-poet` | `@biomejs/biome` |
| `codegen-ts-react` | `@metaobjectsdev/metadata`, `@metaobjectsdev/codegen-ts`, `ts-poet` | `@biomejs/biome` |
| `codegen-ts-tanstack` | `@metaobjectsdev/metadata`, `@metaobjectsdev/codegen-ts`, `ts-poet` | `@biomejs/biome` |

Bun workspace globs in `server/typescript/package.json` and a new `client/web/package.json` (or root) declare the new package locations. The exact workspace declaration follows whatever pattern already works for `server/typescript/packages/*`; Phase 1 verified the glob-relative workspace mechanism survives the deeper directory.

## Source moves

| Current path | New path |
|---|---|
| `server/typescript/packages/runtime-ts-client/src/currency.ts` | `client/web/packages/runtime-web/src/currency.ts` |
| `server/typescript/packages/runtime-ts-client/src/tanstack/filter-builder.ts` | `client/web/packages/runtime-web/src/filter-qs.ts` |
| `server/typescript/packages/runtime-ts-client/src/tanstack/types.ts` | `client/web/packages/runtime-web/src/fetcher.ts` |
| `server/typescript/packages/runtime-ts-client/src/tanstack/cell-renderers.ts` *(type declarations only)* | `client/web/packages/runtime-web/src/fetcher.ts` (merged) |
| `server/typescript/packages/runtime-ts-client/src/react/index.tsx` | `client/web/packages/react/src/use-entity-form.tsx` |
| `server/typescript/packages/runtime-ts-client/src/components/currency-input.tsx` | `client/web/packages/react/src/currency-input.tsx` |
| `server/typescript/packages/codegen-ts/src/templates/form-file.ts` | `server/typescript/packages/codegen-ts-react/src/form-file.ts` |
| `server/typescript/packages/codegen-ts/src/templates/entity-constants.ts` *(form-related strings)* | `server/typescript/packages/codegen-ts-react/src/entity-constants.ts` (split) |
| `server/typescript/packages/runtime-ts-client/src/tanstack/entity-fetcher.tsx` | `client/web/packages/tanstack/src/entity-fetcher.tsx` |
| `server/typescript/packages/runtime-ts-client/src/tanstack/cell-renderer-provider.tsx` | `client/web/packages/tanstack/src/cell-renderer-provider.tsx` |
| `server/typescript/packages/runtime-ts-client/src/tanstack/cell-renderers.ts` *(React renderer impls)* | `client/web/packages/tanstack/src/cell-renderers.tsx` |
| `server/typescript/packages/runtime-ts-client/src/tanstack/entity-grid.tsx` | `client/web/packages/tanstack/src/entity-grid.tsx` |
| `server/typescript/packages/codegen-ts-tanstack/src/**` | unchanged location; internal imports updated |

`server/typescript/packages/runtime-ts-client/` is deleted after sources move. The cell-renderers file gets split into its type-only half (→ `runtime-web/fetcher.ts`) and React-JSX-implementations half (→ `tanstack/cell-renderers.tsx`).

## Emitted imports change

Generators emit hard-coded import strings into generated files. These strings update.

| Generator | Was emitting | Now emits |
|---|---|---|
| `codegen-ts-react/form-file` | `import { useEntityForm } from "@metaobjectsdev/runtime-ts-client/react";` | `import { useEntityForm } from "@metaobjectsdev/react";` |
| `codegen-ts-react/form-file` | `import { CurrencyInput } from "@metaobjectsdev/runtime-ts-client";` | `import { CurrencyInput } from "@metaobjectsdev/react";` |
| `codegen-ts-tanstack/hooks-file` | `import { ... } from "@metaobjectsdev/runtime-ts-client";` | `import { ... } from "@metaobjectsdev/tanstack";` |
| `codegen-ts-tanstack/grid-hook-file` | same | same — points at `@metaobjectsdev/tanstack` |
| `codegen-ts/entity-constants` *(currency JSDoc)* | references `@metaobjectsdev/runtime-ts-client` | references `@metaobjectsdev/runtime-web` (for `formatCurrency`) |

The import-string constants currently centralized in [server/typescript/packages/codegen-ts/src/templates/entity-constants.ts](../../../server/typescript/packages/codegen-ts/src/templates/entity-constants.ts) split: framework-neutral ones stay in `codegen-ts`; form-related move to `codegen-ts-react`; tanstack-related already live in (or move to) `codegen-ts-tanstack`.

## In-tree consumer updates

Files that need editing in this PR (non-generated):

- [server/typescript/packages/cli/package.json](../../../server/typescript/packages/cli/package.json) — add `@metaobjectsdev/codegen-ts-react` workspace dep so it's available for user `metaobjects.config.ts` files.
- [server/typescript/packages/cli/src/lib/load-metaobjects-config.ts](../../../server/typescript/packages/cli/src/lib/load-metaobjects-config.ts) + [test/unit/load-metaobjects-config.test.ts](../../../server/typescript/packages/cli/test/unit/load-metaobjects-config.test.ts) — update any string refs to old package names if present.
- [server/typescript/packages/cli/test/unit/init-refresh-docs.test.ts](../../../server/typescript/packages/cli/test/unit/init-refresh-docs.test.ts) — same.
- [server/typescript/packages/forge/src/agent-docs/index.ts](../../../server/typescript/packages/forge/src/agent-docs/index.ts) — agent-docs string refs.
- [server/typescript/packages/codegen-ts/src/templates/form-file.ts](../../../server/typescript/packages/codegen-ts/src/templates/form-file.ts) — **deleted**, moved to codegen-ts-react.
- [server/typescript/packages/codegen-ts/src/templates/entity-constants.ts](../../../server/typescript/packages/codegen-ts/src/templates/entity-constants.ts) — split, form-related strings moved.
- [server/typescript/packages/codegen-ts/src/generators/](../../../server/typescript/packages/codegen-ts/src/generators/) — remove the `formFile` factory re-export (callers import it from `@metaobjectsdev/codegen-ts-react`).
- [server/typescript/packages/codegen-ts/test/generators/factories.test.ts](../../../server/typescript/packages/codegen-ts/test/generators/factories.test.ts) — drop form-file assertions; move to codegen-ts-react test.
- [server/typescript/packages/codegen-ts-tanstack/test/projection-hooks.test.ts](../../../server/typescript/packages/codegen-ts-tanstack/test/projection-hooks.test.ts) + [tanstack-query-filter.test.ts](../../../server/typescript/packages/codegen-ts-tanstack/test/tanstack-query-filter.test.ts) — assertions on emitted imports update to new package names.
- All golden snapshots in [server/typescript/packages/codegen-ts/test/golden/](../../../server/typescript/packages/codegen-ts/test/golden/) — regenerated (one diff per `.form.tsx` and per `.hooks.ts` / `.columns.tsx` / `.grid.ts`).
- [CLAUDE.md](../../../CLAUDE.md) — replace the "framework integration package anatomy" section. New version: codegen and runtime ship as **separate** packages per framework; cite Prisma/Apollo/Drizzle as the convention. Update the TS package layout table to list five client/codegen packages.

## Verification

Phase 2 is complete when **all** of these pass from a clean checkout:

1. `cd server/typescript && bun install` — workspace resolves cleanly. New packages discovered by the workspace glob.
2. `cd server/typescript && bun test` — **2105 pass / 0 fail** (baseline preserved from Phase 1).
3. `cd server/typescript && bun run --filter '*' typecheck` — zero errors.
4. Golden snapshot diffs are reviewed and committed — every `.form.tsx` now imports from `@metaobjectsdev/react`, every `.hooks.ts` / `.columns.tsx` from `@metaobjectsdev/tanstack`, every currency JSDoc from `@metaobjectsdev/runtime-web`.
5. **Install-tree spot-check:** in a scratch directory, `pnpm init -y && pnpm add file:./client/web/packages/runtime-web` — the resulting `node_modules` contains no `react`, no `ts-poet`, no `@biomejs/biome`. Confirms runtime-web's purity.
6. Conformance fixtures still pass — `bun test` includes the conformance corpus.

## Phasing

**Single atomic PR.** Sub-tasks ordered for the implementer:

1. Create `client/web/packages/{runtime-web,react,tanstack}/` skeletons (package.json, tsconfig.json, src/index.ts stubs).
2. Create `server/typescript/packages/codegen-ts-react/` skeleton.
3. Update workspace globs so the new packages are discovered.
4. Move sources per the table above. Each move is a single `git mv` (or directory move) followed by import-path fixups inside the file.
5. Delete `server/typescript/packages/runtime-ts-client/`.
6. Update emitted import strings in codegen-ts, codegen-ts-react, codegen-ts-tanstack.
7. Regenerate golden snapshots. Inspect the diff (should be entirely import-string changes).
8. Update in-tree consumers (cli, forge, tests).
9. Update CLAUDE.md to reflect the five-package split.
10. Run verification (`bun test`, `bun run --filter '*' typecheck`, scratch install).

If any intermediate step fails, fix it before continuing — the PR is atomic, but the work is staged inside one branch for ease of review.

## Out of scope (revisited)

- downstream-consumer migration — covered by `downstream-consumer/specs/FR-002-metaobjects-pkg-migration/spec.md`. downstream-consumer needs to land its Step 1 (Phase 1 path fix) **before** this Phase 2 PR merges to avoid compounding breakage; Step 2 (Phase 2 package updates) lands **after**.
- Server-side `dynamic/` layer — metadata-driven runtime DB stuff. Separate future work; nothing about it is decided in this doc.
- Renaming `codegen-ts-tanstack` — it already follows the convention.
- Java / Python / C# parity for the runtime-web concept — when those ports add web-client integrations, they'll have their own `client/web/<lang>/` directory (or similar).

## Open questions

- **Workspace declaration for `client/web/packages/`.** Today the bun workspace is rooted at `server/typescript/`. With packages spanning both `server/typescript/packages/` and `client/web/packages/`, either (a) the workspace root moves up to `metaobjects/`, or (b) `client/web/` gets its own workspace and a shared root. Either works; the implementer should pick the path with the smallest diff to `package.json` files. Phase 1 left an empty `client/web/packages/`, so this choice was already implied as deferred to Phase 2.
- **`peerDependencies` for `react`'s React-version range.** Current `runtime-ts-client` declares `react: >=18`. Devs install React 19. We'll keep `>=18` unless typing breakage from 19 surfaces — in which case bump to `>=19` and note it in CLAUDE.md / CHANGELOG.

## Migration notes

This is a coordinated breaking change with no deprecation window. The package `@metaobjectsdev/runtime-ts-client` ceases to exist when Phase 2 merges; downstream consumers (downstream-consumer, future trainer-website on another machine) must follow their FR before they can build against the new metaobjects `main`.
