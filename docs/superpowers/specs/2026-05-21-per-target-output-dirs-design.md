# Per-target output directories for TypeScript codegen

**Date:** 2026-05-21
**Status:** Approved (design)
**Scope:** `server/typescript/packages/{codegen-ts, codegen-ts-react, codegen-ts-tanstack, cli}`

## Problem

metaobjects codegen emits every artifact type to a single `outDir`. A consuming
project (downstream-consumer) therefore has its Drizzle schema, Fastify route handlers,
**and** React hooks/forms/columns all generated into one package
(`packages/database/src/generated/`). That "database" package consequently depends
on react, @tanstack/react-query, react-table, react-hook-form, and ships `.tsx`
form components and Fastify routes — concerns that belong in the web app and api
app respectively. The package name lies about its contents and the dependency
graph is wrong.

**Goal:** let a project route each generator's output to a different
directory/package so generated code lands with its runtime target:

- `entityFile`, `queriesFile` → a database/model package (Drizzle + Zod, server-neutral)
- `routesFile` → the API app (Fastify, server)
- `tanstackQuery`, `tanstackGrid`, `tanstackGridHook`, `formFile` → the web app (browser/React)
- `barrel` → per-target as appropriate (default: the entity-module target)

## The hard constraint

Generated sibling files import each other by **relative path** today:

- `Program.routes.ts`: `import { ... } from "./Program"` and `import { db } from "../../../index"`
- `Program.hooks.ts`: `import { ... } from "./Program"`

If `routesFile` output moves to a different package than `entityFile`, `./Program`
and `../../../index` no longer resolve. Those imports must become
**package-qualified** (e.g. `@acme/database/generated/acme/commerce/Program`
and a package-qualified `db` import). So per-target output **requires** the codegen
to know, for each target, its package import base, and to emit cross-target
references as package imports while keeping same-target references relative. This
is the core of the work — not just adding an `outDir` string.

## Verified architecture (pre-implementation findings)

- **Single chokepoint.** Every cross-file import funnels through
  `crossEntitySpecifier(layout, fromPkg, toPkg, name, extStyle)` in
  `codegen-ts/src/import-path.ts` (plus `relativeModuleSpecifier` for the `db`
  import and `barrelEntrySpecifier` for the barrel).
- **The entity file is the only cross-target import target.** queries, routes,
  hooks, columns, grid-hook, and form all import the entity's own file
  (`./Program`). FK `.references()` and `relations()` blocks import *other* entity
  files — but those are entity→entity, always within the entity-module target, so
  they stay relative. The one same-target sibling import that is *not* the entity
  file is grid-hook → `Program.columns` (both in the web target).
- **Cross-package import format is already proven.** The downstream-consumer web/api apps
  already import generated modules from the database package as **extension-less
  package paths**, resolved via `moduleResolution: "bundler"` against the database
  package's `exports` map (`"./generated/*": "./src/generated/*.ts"`):

  ```ts
  import { usePrograms } from '@acme/database/generated/acme/commerce/Program.hooks';
  import type { Purchase } from '@acme/database/generated/acme/commerce/Purchase';
  ```

  Cross-target specifiers must therefore be emitted **without** a `.js` extension,
  regardless of `extStyle`. Same-target relative imports keep respecting `extStyle`.
- **No gen-state baseline.** The current write path (`overwrite-policy.ts`
  `decideAndWrite`) keys solely on the `@generated` header — it writes new files,
  refuses to clobber files lacking the header, and otherwise overwrites. There is
  no three-way-merge baseline to migrate. "Merge across multiple roots" reduces to
  "resolve each file's full path against its target root, then run the existing
  per-file write decision."

## Design decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | **Named `targets` registry** + per-generator `target: "name"` | Import-identity is a property of the *destination*, not the generator; multiple generators share a destination. Defining it once (named) is the normalized model; inline-per-generator (the Java Maven-plugin approach) denormalizes it and forces every consumer of a destination to repeat its identity. |
| 2 | **Cross-target imports are extension-less package paths** | Matches the `exports`-map format the consuming apps already use; `moduleResolution: "bundler"` resolves them to source `.ts`. |
| 3 | **Per-target `dbImport` override** (falls back to global) | model-target queries import `db` relatively (`../index`); api-target routes import it from the package (`@acme/database`). One global value cannot serve both. |
| 4 | **Single barrel in its assigned target** (default = entity-module target) | The barrel re-exports entity files; it belongs with them. Per-target multi-barrels are a separate, larger feature. |

### Why named targets over the Java inline model

The Java Maven plugin attaches `outputDir` + `packageName` to each `<generator>`.
That works in Java because (a) imports are fully-qualified and classpath-resolved
at compile time, so an emitter never computes a relative-vs-qualified path, and
(b) the example only ever ran one generator per execution, so the
multi-destination case was never exercised. TypeScript bakes import strings in at
generation time, so a consumer generator must know the *producer's* import identity
when it emits — a shared, named registry models that directly instead of
reconstructing it from scattered inline values.

## Architecture

### Concepts

- **Target** — a named output destination:

  ```ts
  interface TargetConfig {
    outDir: string;              // filesystem root, relative to project root
    importBase?: string;         // pkg-specifier prefix others use to import modules produced here
    outputLayout?: OutputLayout; // defaults to top-level outputLayout
    dbImport?: string;           // defaults to top-level dbImport
  }

  interface ResolvedTarget {
    name: string;
    outDir: string;
    importBase: string | undefined;
    outputLayout: OutputLayout;
    dbImport: string;
  }
  ```

- **Default target** — synthesized from existing top-level fields:
  `{ name: "default", outDir: config.outDir, importBase: config.importBase, outputLayout: config.outputLayout, dbImport: config.dbImport }`.
  Generators with no `target` use it.

- **Entity-module target** — the destination holding entity files; the only thing
  imported across targets. The runner derives it from the generator that sets
  `emitsEntityModule: true` (set by `entityFile()`), falling back to `default`.

### Config surface (additive)

`MetaobjectsGenConfig` gains:

```ts
targets?: Record<string, TargetConfig>;
importBase?: string;   // top-level: the default target's importBase
```

`NormalizedMetaobjectsGenConfig` gains a resolved `targets: Record<string, ResolvedTarget>`
that always includes `"default"`.

Every generator factory's opts gains an optional `target?: string`:
`EntityFileOpts`, `QueriesFileOpts`, `RoutesFileOpts`, `FormFileOpts`,
`TanstackQueryOpts`, `TanstackGridOpts`, `TanstackGridHookOpts`, and a new
`BarrelOpts`.

Example:

```ts
defineConfig({
  outDir:   "packages/database/src/generated",   // the "default" (entity-module) target
  importBase: "@acme/database/generated",
  dbImport: "../index", dialect: "sqlite", outputLayout: "package", apiPrefix: "/api",
  targets: {
    api: { outDir: "apps/api/src/generated", dbImport: "@acme/database" },
    web: { outDir: "apps/web/src/generated" },
  },
  generators: [
    entityFile(), queriesFile(), barrel(),        // → default (entity-module)
    routesFile({ target: "api" }),
    formFile({ target: "web" }), tanstackQuery({ target: "web" }),
    tanstackGrid({ target: "web" }), tanstackGridHook({ target: "web" }),
  ],
});
```

`api`/`web` inherit `importBase` for cross-target imports because they import *from*
the entity-module (default) target; only the entity-module target needs `importBase`.

### Generator interface

```ts
interface Generator {
  name: string;
  filter?: (entity: MetaObject) => boolean;
  generate: (ctx: GenContext) => EmittedFile[] | Promise<EmittedFile[]>;
  target?: string;            // NEW — registry key; defaults to "default"
  emitsEntityModule?: boolean; // NEW — true on entityFile(); marks the entity-module target
}
```

### The import resolver (the crux)

New helpers in `codegen-ts/src/import-path.ts`, exported from the package index:

- **`entityModuleSpecifier(ctx, entity): string`** — import the entity's own file.
  - `selfTarget.name === entityModuleTarget.name` → relative:
    `crossEntitySpecifier(entityModuleTarget.outputLayout, entity.package, entity.package, entity.name, extStyle)` (today's behavior, package-layout aware).
  - else → cross-target, extension-less:
    `${entityModuleTarget.importBase}` + (`/${packageToPath(entity.package)}` when
    `entityModuleTarget.outputLayout === "package"`) + `/${entity.name}`.

- **`siblingSpecifier(ctx, entity, basename): string`** — always same-target,
  relative, package-layout aware:
  `crossEntitySpecifier(selfTarget.outputLayout, entity.package, entity.package, basename, extStyle)`.
  Used for grid-hook → `${entity.name}.columns` (replaces the hardcoded
  `"./Program.columns"`, fixing a latent package-layout bug).

`db` import: `relativeModuleSpecifier(selfTarget.outputLayout, entity.package, selfTarget.dbImport)`.

FK/relations cross-entity imports inside the entity file: keep `crossEntitySpecifier`,
sourced from `selfTarget.outputLayout` (entity file's selfTarget *is* the
entity-module target, so behavior is unchanged).

Barrel entries: route through the same logic as `entityModuleSpecifier` (relative
when the barrel's target equals the entity-module target — the recommended default;
package-qualified otherwise).

### RenderContext / runner threading

`RenderContext` gains:

```ts
selfTarget: ResolvedTarget;          // the target THIS generator emits to
entityModuleTarget: ResolvedTarget;  // where entity files live
```

Its existing `outDir`, `outputLayout`, and `dbImport` reflect the **self** target.
The runner computes the heavy shared state (`pkMap`, `relationMap`, `packageOf`,
`loadedRoot`, dialect, etc.) once, then builds a cheap per-generator view that sets
`selfTarget` (and overrides `outDir`/`outputLayout`/`dbImport`). `GenContext.config`
likewise reflects the self target's `outputLayout` so existing
`entityOutputPath(ctx.config.outputLayout, …)` calls in generator factories pick up
the per-target layout with no factory churn.

### Path resolution + write phase

- Each `EmittedFile.path` stays relative to **its generator's target** `outDir`.
- The runner resolves `fullPath = join(target.outDir, file.path)` using the
  generator→target mapping it already controls.
- **Collision detection keys on `fullPath`** (resolved), not the relative path —
  the same filename in two different targets is not a collision; the same full path
  from two generators still is.
- `decideAndWrite(fullPath, content, strategy)` is unchanged; multi-root works
  because `fullPath` already encodes the target root.
- `cli/src/commands/gen.ts` output is updated to display project-root-relative paths
  (so files in different targets are distinguishable) instead of a single `outDir`
  header + basename-only rows.

### Validation

- A generator references a `target` not in the registry → throw, listing valid names.
- Any generator's target ≠ entity-module target **and** the entity-module target has
  no `importBase` → throw with a fix-it message naming both targets.

### Backward compatibility (hard requirement)

No `targets` + no per-generator `target` ⇒ a single synthesized `default` target ⇒
`selfTarget === entityModuleTarget` for every generator ⇒ every resolver helper
takes the relative branch ⇒ **byte-identical regen**. `fullPath` collision keys
reduce to today's single-root behavior. Existing golden + conformance tests are the
regression guard.

## Test plan (TDD)

1. **Resolver units** — `entityModuleSpecifier` / `siblingSpecifier`: same-target
   (relative) and cross-target (extension-less package path) × flat/package layout ×
   `extStyle` "js"/"none" (extStyle ignored on cross-target).
2. **Config normalization + validation** — targets resolve; `outputLayout`/`dbImport`
   fall back to global; `default` synthesized from top-level `outDir`; unknown-target
   error; missing-`importBase`-when-cross-target error.
3. **Runner multi-target** — files routed to the correct target `outDir`; collision
   scoped per resolved full path; per-generator render context carries correct
   `selfTarget` + `entityModuleTarget`.
4. **Template emission** — routes-file in `api` target emits cross-target entity
   import + per-target `db` import; hooks/form/columns/grid-hook in `web` target emit
   cross-target entity imports; grid-hook → columns stays relative; barrel relative
   in the entity-module target.
5. **Golden byte-identical regen** — existing single-target golden output unchanged.
6. **CLI gen multi-target** — writes to multiple roots; output formatting shows
   per-target paths.

Rebuild dists for `codegen-ts`, `codegen-ts-react`, `codegen-ts-tanstack`, and `cli`
(the CLI resolves codegen from built dist; stale dist has bitten this before).
`cd server/typescript && bun test` green; conformance harness green.

## Downstream validation (verify only — do NOT commit there)

In `/home/doug/Development/downstream-consumer`, route:

- entity/queries → `packages/database/src/generated`
- routes → `apps/api/src/generated`
- hooks/grid/form/columns → `apps/web/src/generated`

Then `pnpm -F @acme/database meta:gen` + `pnpm build` should pass,
with the database package no longer depending on react/tanstack/fastify. This is the
end-to-end proof; the feature + tests land in the metaobjects repo first.

## Out of scope

- Per-target multi-barrels (a routes barrel, a hooks barrel).
- Role-based default target assignment (auto-routing by artifact kind). Named targets
  is the substrate that would make this possible later.
- The adjacent known issues: one-giant-`constants.ts` colocation, and ProgramSummary
  projection codegen bugs (view without GROUP BY/aggregate columns; projection
  server-side filter not applied). Mentioned only if implementation touches adjacent
  code.
