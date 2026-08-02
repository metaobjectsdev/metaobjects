# Persistability derives from source presence, never subtype (#248) — Design

**Date:** 2026-08-01 · **Issue:** #248 · **Branch:** `fix/248-persistability-from-source` · **Status:** proposed

## 1. Principle

> **An object participates in the database iff it declares (or inherits via `extends`) a
> `source.*` child. No database decision — table, DDL, FK target, drift check, CRUD
> queries/routes — may key on the object's subtype name.**

This is not a new rule. It is the **loader's already-declared contract**, which migrate-ts
(and parts of codegen-ts) violate:

- `server/typescript/packages/metadata/src/persistence/source/validate-source-roles.ts:3-5,20,36`
  — *"An object that declares ≥1 source MUST have exactly one with role 'primary'.
  **Zero sources is allowed (object is not persisted).**"* A sourceless object of ANY
  subtype loads clean and means "not backed by any store".
- `server/typescript/packages/codegen-ts/src/source-detect.ts:1-8` — the entity-file
  composer already documents it verbatim: *"Pure metadata-driven, not a typeId
  discriminator: any object subtype can opt out of Drizzle table emission simply by
  omitting source.rdb."*

Because the fix aligns implementations with an invariant the loader already publishes,
**this is a bugfix (PATCH), not a behavior contract change** — no flag, no deprecation
window.

## 2. The bug (both halves, empirically confirmed)

### 2a. migrate-ts — phantom `CREATE TABLE` (the reported half)

`buildExpectedSchema` Pass 1 (`server/typescript/packages/migrate-ts/src/expected-schema.ts:139-168`)
skips exactly: non-objects (`:140`), abstracts (`:141`), the **hardcoded string compare**
`child.subType === "value"` (`:142`), TPH subtypes (`:145`), and read-only-source-only
projections (`:147-154`). An object with **no source at all falls through** and gets a
`TableDescriptor` with a **fabricated physical name** (`resolveTableName` falls back to
`pluralize(snake_case(name))`), and enters the FK-target maps (`:176-206`) under that fake
name. Every provider-registered `object.*` subtype fails **open**.

Reported blast radius: a 155-object wire-protocol package (custom `object.message`
subtype, co-loaded with domain entities so messages can reference them) produced
`UP: 157 CREATE TABLE` — ~146 phantom tables — making `meta migrate` and
`meta verify --db` (which flows through the same `buildExpectedSchema`, via
`src/drift/drift.ts:70-86`) unusable.

### 2b. codegen-ts — the same fail-open, as broken generated code

The **table tier is already correct**: `templates/entity-file.ts:98-101` dispatches on
`hasWritableRdbSource` — a sourceless object of any subtype gets the value-object path
(interface + Zod, no Drizzle table). But the **queries/routes/API tier still filters by
subtype**, so it emits DB-bound artifacts against a table that was (correctly) never
emitted. Confirmed by direct `runGen` probe against a 3-object model (`Order` entity with
source; `Money` plain `object.value`; `Ghost` entity with **no** source):

- `Ghost.queries.ts` emitted, importing `ghosts` (the Drizzle table const) and
  `GhostUpdateSchema` from `./Ghost.js` — **neither export exists** (value-object path)
  → TS2305 in generated output.
- `Ghost.routes.ts` emitted — same class of broken imports.
- `Money.routes.ts` emitted for a **plain value object** (`generators/routes-file.ts:26-28`
  has no value skip at all), importing `moneys`, `MoneyFilterAllowlist`,
  `MoneySortAllowlist` — none exist. A pre-existing fail-open of the same family.

So for the reported model, fixing migrate alone leaves `meta gen` emitting ~146 broken
queries/routes files. Both halves ship in this fix.

## 3. The derived rules

Two predicates, both pure functions of the object's **resolving** children
(ADR-0039: an entity may inherit its `source.rdb` via `extends` — Pass 1 and
`hasWritableRdbSource` already read resolving for exactly this reason):

- **R1 — table tier** (migrate Pass 1; drizzle table already conforms):
  a non-abstract, non-TPH-subtype object gets a `TableDescriptor` **iff it declares or
  inherits ≥1 WRITABLE source** (`MetaSource.isWritable()`,
  `metadata/src/persistence/source/meta-source.ts:89-96`). The `@unmanaged`-writable
  branch (→ `fkTargetOnly`, no descriptor) is unchanged and nested inside R1.
- **R2 — DB-artifact tier** (codegen queries/routes/API-doc CRUD): the artifact is
  emitted **iff the object declares or inherits ≥1 `source.rdb` of ANY kind**
  (new helper `hasAnyRdbSource`, sibling of `hasWritableRdbSource` in
  `codegen-ts/src/source-detect.ts`). Writable → CRUD path; read-only-only →
  the existing projection read-only path (template-internal `isProjection` dispatch,
  unchanged). Zero sources → shape-only artifacts (entity file's value-object path),
  no queries/routes.

### 3a. Why R1 subsumes the old skips EXACTLY

- **`subType === "value"`:** value purity (ADR-0028) bans sources on values, and the
  TS enforcement iterates **resolving** `children()`
  (`metadata/src/subtype-rules.ts:99-137`, `validateValuePurity` — `model.children()`
  at `:100`, source ban at `:125-136`). So even a value that `extends` an entity "for
  shape" cannot reach migrate/codegen with an effective source — it fails load with
  `ERR_SUBTYPE_RULE_VIOLATION` first. For every loadable model,
  `hasWritableSource(value) === false`. Subsumption is loader-enforced, not
  convention.
- **Read-only-only projection skip:** read-only ⇒ not writable, so
  `!hasWritableSource` covers it; the view-diff pipeline
  (`codegen-ts/src/projection/build-projection-views.ts`, threaded via
  `BuildExpectedSchemaOptions.views`) owns those objects, unchanged.
- **Write-through** (writable table + read-only view): has a writable source → table
  emitted, view handled by Pass 4. Unchanged.
- **`@unmanaged` writable:** still enters the writable branch; own-source
  `isUnmanaged` detection (`expected-schema.ts:161-167`) and
  `collectUnmanagedNames` (`unmanaged.ts:32-43`) agree exactly as before.
- **NEW (the fix):** sourceless entity and sourceless custom subtype → skipped; they
  also drop out of the `entities`/`fkTargetOnly` FK maps, removing the fabricated
  physical FK-target name hazard. An FK whose `@references` target is sourceless now
  resolves to nothing and is skipped (`buildForeignKeys`' existing
  `if (!refTable) continue;` at `expected-schema.ts:831-832`) — the same behavior as
  any unresolvable target today (see §9a for the follow-up loader validation).

### 3b. Inheritance is deliberate

A custom subtype (or entity) that `extends` a sourced entity **inherits the source and
is persisted** — `extends` is THE inheritance mechanism (ADR-0029/0039) and resolving
reads are the norm. An object that must never be persisted simply must not extend a
sourced base. (A subtype that should be *incapable* of persistence has an existing home:
its provider just doesn't license `source.*` children — ADR-0037 step 0 child-licensing —
see §5.)

## 4. Site inventory (the "find them all" review)

Schema/DDL is TS-owned (ADR-0015): Java/Python/C# emit no DDL, so DB-gating sites are
TS-only. Every site below was read; classification is **keep** (legitimately structural)
or **rederive** (subtype-as-persistence-proxy).

### migrate-ts (`server/typescript/packages/migrate-ts`)

| Site | Today | Verdict |
|---|---|---|
| `src/expected-schema.ts:142` `subType === "value"` | hardcoded subtype compare | **REDERIVE** — delete; subsumed by R1 |
| `src/expected-schema.ts:147-154` read-only-only skip | source-kind based, but leaves the sourceless fall-through | **REDERIVE** — collapse to `if (!hasWritableSource) continue;` (delete the now-dead `hasReadOnlySource`) |
| `src/expected-schema.ts:140` `type !== TYPE_OBJECT` | type-axis gate | **KEEP** — only objects can own sources/fields; not a persistence proxy |
| `src/expected-schema.ts:141` `isAbstract` | abstract template | **KEEP** — an abstract is a reusable declaration template, never an instance store, regardless of sources it hoists for concretes to inherit |
| `src/expected-schema.ts:145` `isTphSubtype` (+ `:392-426` TPH walk, `tphConcreteSubtypes`' `TYPE_OBJECT` scan) | discriminator topology | **KEEP** — structural inheritance fact: the subtype's storage IS the base's single table. The *whether-persisted* question is answered on the base by R1; a sourceless TPH hierarchy skips uniformly (subtypes via `:145`, base via R1) |
| `src/expected-schema.ts:161-167` `@unmanaged` own-source branch | source-derived | **KEEP** (now nested under R1) |
| `src/expected-schema.ts:176-206` FK maps / `resolveTargetTable` | populated from Pass 1 | **KEEP** — fixed transitively (phantom names no longer enter) |
| `src/unmanaged.ts:32-43` `collectUnmanagedNames` | iterates own sources | **KEEP** — already source-derived |
| `src/drift/drift.ts:70-86` `computeDrift[FromActual]` | composes `buildExpectedSchema` | **KEEP** — `meta verify --db` / `--d1` fixed transitively |
| `src/referential-actions.ts:40` `VALIDATOR_SUBTYPE_REQUIRED` etc.; field/validator subtype switches throughout `expected-schema.ts` | field/validator TYPE mapping | **KEEP** — type mapping, not persistence gating |
| `diff/ emit/ apply/ introspect/ snapshot/ verify/` | operate on `SchemaSnapshot`, post-metadata | **KEEP** — no metadata subtype awareness (grep-verified) |

### codegen-ts (`server/typescript/packages/codegen-ts`)

| Site | Today | Verdict |
|---|---|---|
| `src/templates/entity-file.ts:98-101` table-vs-shape dispatch | `hasWritableRdbSource` | **KEEP** — already conforms; this is the reference pattern |
| `src/reference/entity.ts:82` | same | **KEEP** |
| `src/source-detect.ts:20-31` `hasWritableRdbSource` | resolving, source-derived | **KEEP**; add sibling `hasAnyRdbSource` (any kind) exported via `src/index.ts` (`:97` exports the existing one) |
| `src/generators/queries-file.ts:15-22` `skipNonQueryable = subType !== OBJECT_SUBTYPE_VALUE && !isTphSubtype` | subtype proxy; sourceless falls open | **REDERIVE** → `hasAnyRdbSource(e) && !isTphSubtype(e)` |
| `src/reference/queries.ts:108-111` same filter (scaffold-and-own asset; `meta init` copies it verbatim via `reference-templates.ts` / `cli/src/commands/init.ts:275-293`) | same | **REDERIVE** (new scaffolds only; existing consumers own their copies — §7) |
| `src/generators/routes-file.ts:26-28` filter `@emitRoutes !== false && !isTphSubtype` | **no persistence gate at all** — values AND sourceless objects get broken routes files | **REDERIVE** → add `hasAnyRdbSource(e)` conjunct |
| `src/reference/routes.ts:40-44` same | same | **REDERIVE** |
| `src/generators/routes-file-hono.ts:34` filter `@emitRoutes !== false` only | same fail-open | **REDERIVE** → add `hasAnyRdbSource(e)` conjunct (its missing TPH handling is pre-existing and out of scope here) |
| `src/generators/api-model.ts:337-349` `isQueryable` ("mirror of the queries filter") | subtype proxy | **REDERIVE** in lockstep — api-docs must not document CRUD that no longer exists |
| `src/projection/projection-detector.ts`, `extract-view-spec.ts:256`, `build-projection-views.ts:163-269` | own read-only-kind sources | **KEEP** — already source-derived (own-source reads are the chartered C#-parity classification, ADR-0039 comments in situ) |
| `src/relation-resolver.ts:69` skips projections | source-derived | **KEEP** |
| `src/runner.ts:161,175` value-object emitted-name collision domain (ADR-0044) | subtype check | **KEEP** — file/type NAMING taxonomy, not a DB decision |
| `src/generators/docs-data-builder.ts:52,616`, `src/templates/mermaid-er.ts:115` | value labeling for docs/ER | **KEEP** — docs depict the MODEL taxonomy; persisted-ness already flows from `hasWritableRdbSource` (`:52`) |
| `src/templates/callable-file.ts:78` proc-args value lookup; `src/generators/prompt-render-file.ts:48` payload VOs; `src/generators/api-model.ts:765` payload-ref VO check | value-shape semantics | **KEEP** — taxonomy (what a value IS), not persistence |
| `src/templates/tph-discriminator.ts:213` `subType !== OBJECT_SUBTYPE_ENTITY` | TPH scan scoped to entities | **KEEP** — TPH is chartered as an entity-inheritance concept (`spec/metamodel/object.json`: `@discriminator`/`@discriminatorValue` registered on `object.entity` only) |
| `src/templates/drizzle-schema.ts:186-211` `buildFkMapForEntity` | no target-persisted check; also bare-name `findObject` | **DEFER** — an `@enforce`'d reference to a non-persisted target is a modeling error the LOADER should reject (§9a); the bare-name lookup is already tracked as a #228/#244-adjacent gap |
| `src/templates/barrel.ts` | exports entity modules only | **KEEP** — never references queries/routes, so filter changes can't strand it (verified) |

### Elsewhere (verified clean)

- `cli`: `commands/migrate.ts` / `verify.ts` compose `buildExpectedSchema` +
  `buildProjectionViews` — no own subtype gating; fixed transitively.
- `runtime-ts`: `validator-runner.ts:229` (`OBJECT_SUBTYPE_VALUE`) is VO-validation
  taxonomy; the rest is TYPE_OBJECT/identity lookups. **KEEP** — runtime binds to
  tables the consumer passes in; it makes no persistability decision.
- `sdk`, client packages (`runtime-web`/`react`/`tanstack`): no object-subtype DB
  gates (grep-verified). See §9c for the API-surface-parity follow-up.

## 5. Decision 1 — explicit `persistence?: "never" | "bySource"` on `TypeDefinition`: **AGAINST**

The issue's alternative would let a provider declare a subtype's persistence posture on
the type registration. Rejected:

1. **Fully derivable** — the loader contract already encodes "zero sources ⇒ not
   persisted" per OBJECT; a per-TYPE flag restates a subset of that and creates a
   contradiction case (`persistence: "never"` + a declared source) needing a new error
   for zero expressive gain. ADR-0023: never add vocabulary a rule can derive.
2. **Wrong axis per ADR-0007/0037** — physical/persistence concerns live on the
   `source` child of the OBJECT, not on the type definition; a type-level flag is a
   second source of truth for the same fact.
3. **The legitimate residual need already has a home** — "this subtype must be
   *incapable* of persistence" is child-licensing: the provider simply does not
   license `source.*` under its subtype (`childRules`, FR-033 fail-closed), and the
   loader rejects a declared source with `ERR_CHILD_NOT_ALLOWED`. No new field.
4. **Cost** — `TypeDefinition` shape is mirrored in five ports and gated by
   `registry-conformance`; a new field is a coordinated all-port change inside what
   must stay an npm-only PATCH.

## 6. Decision 2 — migrate/verify scope filter (`--entities` / package): **DEFER (separable follow-up)**

`ResolvedGenConfig` has `entities: string[]` (`cli/src/lib/config.ts:25-28`,
`args.ts:90-96` — gen positionals); `ResolvedMigrateConfig` (`config.ts:37-59`) and
`VerifyFlags` (`args.ts:189-197`) have no scope. Recommendation: **not in this fix.**

1. The core fix removes the *need* in the reported case (phantom tables gone) — the
   remaining value is ergonomics (scoping a big multi-package model), not correctness.
2. Migrate scoping has real design surface gen scoping doesn't: a scoped expected
   schema diffed against a full DB proposes **drops for every out-of-scope table**
   unless the scope also filters the ACTUAL side (and the snapshot ledger, and the
   FK-graph cascade keying from #241). That both-sides-scoped diff semantics deserves
   its own design, not a rider on a PATCH.

## 7. Backward compatibility & byte-identity guardrail

**The norm (well-formed models — every table-owning object declares/inherits a source):**

- `meta migrate` / `meta verify --db|--d1`: **byte-identical** expected schema, SQL,
  and drift output. Only sourceless objects change classification, and the only
  objects that were both sourceless and previously table-classified are the bug.
- `meta gen`: **no emitted file's content changes.** The only delta is file-SET
  membership: files that stop being emitted are exactly those that imported
  non-existent exports (`ghosts`, `MoneyFilterAllowlist`, …) and could never have
  typechecked. Pinned by no-churn assertions + the golden gate (§8).

**Previously-bitten models (had sourceless objects):**

- A DB/snapshot that already **contains phantom tables** (from applying the buggy
  migration) will see `DROP TABLE` proposals on the next migrate — correct (they are
  phantoms), and destructive-gated behind the existing `--allow drop-table` policy;
  called out in the CHANGELOG entry.
- Previously-written broken `*.queries.ts`/`*.routes.ts` files are **not pruned** —
  `meta gen` never deletes; they simply stop regenerating (consumer deletes them).
- **Scaffold-and-own** (ADR-0034): existing consumers own their copied
  `codegen/generators/{queries,routes}.ts` — the reference-template fix reaches new
  `meta init` scaffolds only; existing copies keep the subtype filter until the
  consumer re-syncs. Documented, acceptable: their owned copies are no *more* wrong
  than before, and the engine-side generators most consumers use are fixed.

## 8. Versioning + test strategy

**npm-only PATCH** (next `0.20.x`). Changed packages: `migrate-ts`, `codegen-ts`
(`cli` untouched — it composes the fixed pieces; `metadata` untouched — the contract
already exists there). PyPI/NuGet/Maven: **no changed product file** — no other port
emits DDL (ADR-0015). Litmus (per the versioning policy): a `^prev` consumer with a
well-formed model runs `npm update && meta gen && meta migrate` and gets byte-identical
output. Cross-port codegen (Spring/Pydantic/Kotlin generators) is audited as a
follow-up (§9b), not folded into this release.

**Tests (TDD; details in the plan):**

1. `migrate-ts` regression (`test/expected-schema-persistability.test.ts`, new):
   co-load persisted entity + sourceless entity + sourceless CUSTOM subtype
   (`object.message` registered via `composeRegistry([...coreProviders, provider])`,
   the pattern in `metadata/test/child-placement-enforcement.test.ts:142`) → exactly
   one table; FK `@references` a sourceless object → no FK descriptor, no fabricated
   name; diff vs empty DB → exactly one `create-table`.
2. `codegen-ts` regression (probe-style `runGen`): sourceless entity + value + entity
   model → `Ghost.queries/routes`, `Money.routes` NOT emitted; `Order.*` content
   byte-identical to a run without the sourceless co-loads; same assertions through
   the reference (scaffold) generators.
3. Existing pins that must stay green (byte-identity): `expected-schema.test.ts`
   (value skip at `:447`), TPH (`expected-schema-tph.test.ts`), `@unmanaged`/#208,
   projection/view suites, full `migrate-ts` + `codegen-ts` + `cli` suites.

**Known traps (from the project memory, planned around explicitly):**

- **Golden gate lives outside the package suite** — run
  `cd server/typescript/packages/codegen-ts && bun test test/golden/` explicitly. The
  golden corpus has no top-level `object.value` and all its entities are sourced
  (grep-verified), so expected result is green-unchanged; any diff is a stop signal.
- **`migrate-ts` changes can regress the SEPARATE
  `server/typescript/packages/integration-tests`** (`view-lifecycle-{pg,sqlite}.test.ts`)
  — only the slow CI lane runs them; run locally (Docker/Testcontainers) before done.
- **Migrate correctness gate** — the change only removes never-correct tables from the
  expected side; the existing real-engine round-trips (`migrate-ts/test/integration/`
  lifecycle/apply suites) pin emit→apply→introspect→re-diff-EMPTY for sourced models
  and must pass unchanged.
- Never bare `bun test` at repo root; stage explicit paths, never `git add -A`.

## 9. Out of scope / deferred follow-ups (to file as issues)

- **9a. Loader validation: enforced reference/relationship → non-persisted target.**
  Today an `@enforce`'d `identity.reference` (or relationship) from a persisted entity
  to a sourceless object yields divergent downstream behavior: migrate silently skips
  the FK (unresolvable target), while `drizzle-schema.ts:186-211` still emits a
  `.references()` against a table const that doesn't exist (broken generated code).
  The right fix is a LOADER error (cross-port, all four loaders + a conformance
  fixture) — a physical FK needs a physical target. Too big for this PATCH.
- **9b. Cross-port codegen audit.** Java `codegen-spring`, Python, Kotlin, C# emit
  repositories/controllers/DTOs — audit whether their emission gates are
  subtype-proxies with the same sourceless fail-open (no DDL, so lower stakes; same
  principle). Pattern-match to the #228 out-of-scope audit list.
- **9c. Client API-surface parity.** `codegen-ts-react` / `codegen-ts-tanstack` emit
  hooks/forms for any object (compilable today — they bind types/schemas that ARE
  emitted); once routes stop existing for sourceless objects those hooks dangle at
  runtime. Align their filters with `hasAnyRdbSource` as an ergonomics follow-up.
- **9d. `meta migrate` / `meta verify` scope filter** (§6) — both-sides-scoped diff
  design.
- **9e. `routes-file-hono` TPH gating + `drizzle-schema`/`relation-resolver`
  bare-name `findObject`** — pre-existing gaps adjacent to, but independent of, this
  fix (the latter already noted under the #228/#244 follow-up audits).
