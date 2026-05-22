# Metadata constants co-location + provider alignment — Design

**Date:** 2026-05-21
**Status:** Design (ready for implementation plan)
**Scope:** Shatter the `@metaobjectsdev/metadata` god-file (`constants.ts`, 518 lines) and its parallel monolith (`core-attr-schemas.ts`) into per-concern modules co-located with the type they describe, grouped by metamodel layer. Delete the Java-only `@javaRuntime` leak from TS. Keep registration on the existing provider model. TypeScript-only; wire-format / conformance neutral.

## Background — the smell

`metadata/src/constants.ts` is a single 518-line file imported by 7 packages (cli, codegen-ts, codegen-ts-react, codegen-ts-tanstack, migrate-ts, runtime-ts, sdk). It mixes the durable cross-language metamodel vocabulary with feature attrs and even language-specific values. Concrete problems:

1. **God-file / no locality.** Touching one concept (say, fields) means editing `constants.ts`, the parallel `core-attr-schemas.ts`, and `meta/meta-field.ts` — three centralized files, none co-located.
2. **Blast radius.** Every constant change mutates `metadata`, the root of the dependency tree; with H7's lockstep versioning a one-line change forces a full-suite republish.
3. **A genuine layering leak.** `OBJECT_JAVA_RUNTIME_POJO/MAP/PROXY` — Java runtime strategy values — live in the **TypeScript** package, registered + enum-validated in the core schema, with a `meta-object.javaRuntime` accessor. Not in any conformance fixture. The TS core validates Java semantics.

The Java implementation does this right: type/subtype constants live **on the type class** (`StringField.SUBTYPE_STRING`), feature/concern constants live **in the feature module** (`CodegenAttributeConstants` in `codegen-base`, `JpaConstants` in the JPA module), and types **self-register** via a provider model. metaobjects-TS already has the provider model (`provider.ts`, `MetaDataTypeProvider`, `composeRegistry`, Java parity per `2026-05-17-type-provider-model-design.md`) and a `dbProvider` precedent — but the constants never followed.

## The correction (why this is NOT a cross-package relocation)

An earlier framing proposed relocating "feature" constants to downstream packages (e.g., `layout`/`dataGrid` → `codegen-ts-tanstack`). That was a misclassification. CLAUDE.md's "Cross-language porting" section lists the vocabularies that **must be identical across all language implementations**, and they include: filter operators, source subtypes (`dbTable`/`dbView`), origin subtypes, **layout subtypes (`dataGrid`)**, currency attrs (`@currency`, `@locale`), and `@schema`. Those are all **cross-language core metamodel** — the loader validates them, conformance pins them, and multiple downstream packages merely *consume* them.

Therefore: **almost nothing leaves `metadata`.** Downstream packages (codegen-*, runtime-*) are pure consumers of the shared metamodel. The fix is internal to `metadata`: break the god-files apart by concern and co-locate each concern's constants + schema + node accessor. The only thing that leaves is `@javaRuntime` — deleted, because it is genuinely not core (Java-only, not conformance-tested).

The `MetaDataTypeProvider` "one provider per package" mechanism stays in place and remains available for a future genuine downstream extension (a package that introduces a brand-new, non-cross-language metamodel type). It is simply not exercised by this change beyond the existing core + db providers, because today there is no such downstream-owned vocabulary.

## Invariant — wire-format / conformance neutral

The canonical serialized output of any metadata is identical regardless of *which module* defines a constant or *which provider* registers a type. Conformance tests the canonical *output*, not the registration source. So:

- The cross-language vocabulary strings do not change value (e.g., `"dataGrid"` stays `"dataGrid"`).
- The set of validated attrs does not change (except `@javaRuntime` validation is removed; unknown attrs are not rejected, so cross-language metadata carrying `@javaRuntime` still loads).
- **All 45 conformance fixtures must pass unchanged**, and the canonical serializer output must be byte-identical before and after.

This is the single most important safety property: it is a pure code-organization refactor, not a behavior change.

## Ownership rule

| Test | Home |
|---|---|
| Cross-language core metamodel — loader-validated AND in the CLAUDE.md cross-language vocabulary (all type/subtype names, structural keys, separators, field/identity/relationship/validator/view/source/origin attrs, filter operators, currency attrs, layout `dataGrid` + attrs) | **`metadata`**, co-located by concern |
| DB-domain attrs (`@dbColumn`, `@db.indexed`) — already a separate provider | **`metadata/persistence/db`** (already factored; unchanged behavior) |
| Language-specific, not conformance-tested (`@javaRuntime` + `pojo`/`map`/`proxy` + accessor) | **deleted from TS** |
| Downstream codegen/runtime hints that the loader does NOT validate and that are NOT cross-language | would move to the owning package — **but there are none today** |

## Target structure — co-locate by concern, grouped by metamodel layer

Replace the two monoliths (`constants.ts`, `core-attr-schemas.ts`) and scatter the `meta/*` accessors into per-concern modules, grouped by layer:

```
metadata/src/
├── core/                         # core domain metamodel
│   ├── object/    { object-constants.ts, object-schema.ts, meta-object.ts }
│   ├── field/     { field-constants.ts, field-schema.ts, meta-field.ts }
│   ├── attr/      { attr-constants.ts, ... }
│   ├── validator/ { validator-constants.ts, validator-schema.ts, ... }
│   ├── identity/  { identity-constants.ts, identity-schema.ts, ... }
│   └── relationship/ { ... }
├── persistence/                  # storage-oriented metamodel
│   ├── source/    { source-constants.ts, source-schema.ts, ... }
│   ├── origin/    { origin-constants.ts, ... }
│   └── db/        { db-constants.ts, db-attr-schemas.ts, db-provider.ts }   # relocated from src/db/
├── core/
│   └── query/     { query-constants.ts }   # the 9 filter operators + sort-order values (shared query vocab)
├── presentation/                 # UI-oriented metamodel
│   ├── view/      { view-constants.ts, view-schema.ts, ... }
│   └── layout/    { layout-constants.ts, layout-schema.ts, meta-layout.ts } # dataGrid lives HERE, not tanstack
├── shared/        { structural-keys.ts (name/package/extends/…), separators.ts (@ prefix, :: , fused-key), wildcards.ts, package-path.ts }
├── registry.ts  provider.ts  composeRegistry  (unchanged)
└── loader/      (unchanged)
```

Notes:
- Each concern module owns its **constants + AttrSchema inventory + node accessor** together. Touching "fields" = one folder.
- `core-types.ts`'s `registerCoreTypes()` becomes a thin composition that calls each concern's `register<Concern>(registry)` function (or each concern exports an `AttrSchema[]` + type def the core provider assembles). The monolithic `core-attr-schemas.ts` is deleted; its arrays move into the concern modules.
- **Cross-cutting query vocab** (the 9 filter operators + sort-order values) lives in a `core/query/` concern, since `@filterable`/`@sortable` are field attrs but the operator set is its own shared vocabulary consumed by codegen-ts (allowlist gen) + runtime-ts (parse) + runtime-web (`buildFilterQs`).
- **Currency** attrs (`@currency`, `@locale`) live with `core/field/` (currency is the `field.currency` subtype) — they are field-level metamodel.

## Export-surface compatibility

`metadata/src/index.ts` keeps a barrel that re-exports every concern module's public constants, so existing **bare-name imports keep working**: `import { FILTER_OP_EQ, FIELD_ATTR_FILTERABLE, LAYOUT_SUBTYPE_DATA_GRID } from "@metaobjectsdev/metadata"` resolves unchanged. The only intentional breakage is the deleted `@javaRuntime` constants (`OBJECT_JAVA_RUNTIME_*`) and the `meta-object.javaRuntime` accessor. This keeps the 7 consuming packages compiling without import churn — they need zero changes except anything referencing the deleted Java symbols (verified: only a metadata test).

(A future, optional improvement: expose per-concern sub-paths like `@metaobjectsdev/metadata/core/field` for consumers who want narrower imports. Out of scope here — the barrel preserves today's surface.)

## `@javaRuntime` deletion

Delete from TS entirely:
- `OBJECT_JAVA_RUNTIME_POJO/MAP/PROXY`, `OBJECT_JAVA_RUNTIME_VALUES`, `ObjectJavaRuntimeValue` (constants).
- The `@javaRuntime` AttrSchema entry in the (relocated) object schema, including its `allowedValues` enum.
- The `meta-object.javaRuntime` getter accessor.
- The assertions in `metadata/test/meta/meta-object.test.ts` that read `.javaRuntime`.

**Risk checks (already verified, restated for the plan):**
- Unknown attrs are NOT rejected by `attr-schema-validate.ts` (it only checks declared attrs for required/type/allowedValues). So metadata carrying `@javaRuntime` continues to load without error after the schema is removed — it simply becomes an unvalidated passthrough attr. ✓
- No production code consumes `.javaRuntime` — only `meta-object.test.ts`. ✓
- Confirm no conformance fixture carries `@javaRuntime` (verified: 0 matches) — so canonical output is unaffected. ✓

## Provider model

- `metadata` continues to ship `coreTypesProvider` (now composed internally from per-concern registration modules instead of two monoliths) and `dbProvider` (unchanged, lives in `persistence/db`).
- `composeRegistry` and the loader's `registry` injection are unchanged.
- Downstream packages remain consumers; no new providers are introduced by this change. The mechanism remains available for genuine future extensions.
- **Decision — provider granularity:** keep ONE `coreTypesProvider` (composed from per-concern registration functions) rather than fragmenting into per-concern providers. Rationale: per-concern *modules* already deliver locality; minting N `MetaDataTypeProvider` objects adds composition ceremony without a consumer that needs to toggle concerns independently. (If a headless consumer ever needs to drop `presentation/`, splitting a `presentationProvider` is a cheap follow-up.)

## Cross-language parity

Java already co-locates constants on type classes and uses the provider model. This change brings the **TS structure** toward that shape (co-location + per-concern registration). Because the change is wire-neutral, **no Java change is required** and conformance is unaffected. A nice-to-have future alignment (Java grouping its registration by the same core/persistence/presentation layers) is explicitly out of scope.

## Sequencing vs H7

Do this **before H7c (first publish)**. It is mostly internal to `metadata` and the barrel preserves the public bare-name surface, so the *published* API is nearly unchanged — but `@javaRuntime` removal is a (tiny) surface change, and shipping the clean internal structure in the first published `0.5.0` is preferable to a post-publish reshuffle. It is independent of H7b (changesets) and can land before or after it; recommended before H7c.

## Out of scope

- Relocating any constants to downstream packages (none qualify — all are cross-language core).
- Any Java / Python / C# changes.
- Fragmenting the core provider into per-concern `MetaDataTypeProvider` objects.
- Per-concern sub-path exports from `metadata` (the barrel preserves today's import surface).
- Behavior changes of any kind — this is organization-only.

## Verification

- `constants.ts` and `core-attr-schemas.ts` no longer exist as monoliths; each concern folder owns its constants + schema + accessor.
- `bun test` across the workspace = baseline 2105 / 0 fail (minus the deleted `.javaRuntime` test assertions, which are removed not broken).
- `bun run --filter '*' typecheck` clean; `bun run --filter '*' build` clean.
- **All 45 conformance fixtures pass; canonical serializer output byte-identical to pre-refactor** (the load-bearing safety check — capture golden canonical output before, diff after).
- No `OBJECT_JAVA_RUNTIME` / `.javaRuntime` references remain anywhere in TS.
- The 7 consuming packages compile with zero import changes (barrel preserves bare-name surface).
- Grep: no `@metaobjectsdev/metadata` consumer imports a now-deleted symbol.
