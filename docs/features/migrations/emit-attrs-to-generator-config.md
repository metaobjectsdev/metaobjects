# Migration: the `@emit*` attributes become generator configuration

**Applies to:** `@emitRoutes`, `@emitTanstack`, `@emitForm`, `@emitAngular`, `@emitGrid`
**Retired in:** 0.25.0 · **Ports affected:** TypeScript only
**Automatic fix:** `meta upgrade --apply`

## What changed

Five per-entity attributes used to switch a TypeScript generator off (or, for
`@emitGrid`, on) for a single object:

```jsonc
{ "object.entity": {
    "name": "InternalAudit",
    "@emitRoutes": false,          // ← no longer read by anything
    "@emitTanstack": false,
    "children": []
}}
```

They are no longer read by any generator, and authoring one is now reported as a
retirement rather than as an unknown attribute.

## Why they were never going to work

**They were never registered vocabulary.** No metadata provider declared them, which
means they behaved differently depending on which command you ran:

| command | load mode | result |
|---|---|---|
| `meta gen` | open | the attribute worked — the artifact was suppressed |
| `meta verify` | strict (ADR-0023) | `ERR_UNKNOWN_ATTR` — the build failed |

So the documented way to suppress an artifact broke the drift gate documented beside
it. `codegen-ts`'s own constants file had already recorded the contradiction, calling
these *"NOT metamodel vocabulary — they tune codegen, not the model"* immediately above
the code that read them off the model.

Registering them was the other available fix and was rejected deliberately: it would
move `metamodelVersion`, and oblige four other language ports to carry a
TypeScript-only generator kill switch that none of them will ever read.

## What to do instead

**Decide per generator what you consume.** Two mechanisms, both of which already
existed and neither of which touches your metadata:

**1. Do not wire a generator whose output you never import.** Every generated file is
a review and maintenance surface. If nothing in your app imports `<Entity>.routes.ts`,
remove `routesFile()` from `generators` rather than generating into the void.

**2. Narrow a generator you do want with its own `filter`.**

```ts
// metaobjects.config.ts
import { defineConfig } from "@metaobjectsdev/cli";
import { routesFile } from "./codegen/generators/routes";

export default defineConfig({
  generators: [
    routesFile({ filter: (e) => e.name !== "InternalAudit" }),
  ],
});
```

`filter` is composed with the generator's built-in gates, so it can only ever *narrow*
the set — which is exactly what the four opt-out attributes did.

### `@emitGrid` is the exception: it was opt-IN

Because a `filter` only narrows, it cannot express an opt-*in*. Per-subtype grids for
TPH subtypes therefore moved to a generator **option**:

```ts
const tphGrids = (e) => e.name === "Copay";

export default defineConfig({
  generators: [
    tanstackGrid({ tphSubtypeGrids: tphGrids }),
    tanstackGridHook({ tphSubtypeGrids: tphGrids }),
  ],
});
```

**Pass the same predicate to both generators.** They emit a matched pair — a
`<Sub>.grid.ts` importing from a `<Sub>.columns.tsx`. If only one generator opts a
subtype in, you get a dangling hook with nothing to pair it with, and an outright
`TS2307` when the inherited layout carries an `@filter` preset.

The default is `() => false`, which is the behaviour of every project that never
declared `@emitGrid`.

## How to migrate

```bash
meta upgrade --apply     # removes all five attributes from your metadata
```

The rewrite is a plain removal and is safe: after this release nothing reads these
attributes, so deleting one cannot change what is emitted.

**It does change what was emitted before.** An artifact you had suppressed with one of
these attributes will now be generated. That is the point of the upgrade being paired
with config: move the suppression into `metaobjects.config.ts` using one of the two
mechanisms above. Until you do, `meta gen` names each affected object in a warning, so
the new file never appears without an explanation.
