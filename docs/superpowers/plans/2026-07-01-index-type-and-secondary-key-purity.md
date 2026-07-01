# `index.*` type + `identity.secondary` key-purity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the overloaded `identity.secondary` by behavior — make it a unique alternate key (remove `@unique`, no back-compat) and add a new cross-target `index.lookup` type for non-unique retrieval, with `@using/@expr/@where/@orders` as RDB-physical escapes — across all five ports, conformance-gated, with migration + docs.

**Architecture:** TS is the reference port: establish vocabulary + validation + codegen + the shared conformance fixtures there first, then fan out to C# / Java / Kotlin / Python to mirror the contract and turn the shared gates green. `identity.secondary` and `index.lookup` are both children of `object.entity`; uniqueness is encoded by the type (identity = unique, index = non-unique), not a boolean. The RDB-physical attrs are contributed by the **db/persistence provider** (not core), on both types. `index.fulltext`/`vector`/`spatial` are documented-but-not-registered.

**Tech Stack:** TS (Bun, Drizzle, `expected-registry.json` manifest), C# (.NET, EF), Java+Kotlin (Maven, JVM shared metadata, Exposed), Python (spec_metamodel JSON providers, SQLAlchemy). Shared corpora: `fixtures/registry-conformance/`, `fixtures/conformance/`, `fixtures/persistence-conformance/`, `fixtures/metamodel-docs/`, `fixtures/agent-context-conformance/`.

## Global Constraints

- **Named constants for all metamodel strings** — `index`, `lookup`, `fields`, `using`, `expr`, `where`, `orders`. TS: `packages/metadata/src/constants.ts`; parallel per port. Never inline literals.
- **Strict provenance (ADR-0023):** every new type/subtype/attr must be added to a registered provider AND `expected-registry.json` (all 5 ports, byte-identical) — else `ERR_UNKNOWN_ATTR` / `ERR_REGISTRY_SEALED`.
- **No backwards compatibility:** `@unique` is removed from `identity.secondary` outright — a legacy `@unique` is `ERR_UNKNOWN_ATTR`. No deprecation window.
- **`index.lookup` is the ONLY index subtype registered.** `index.fulltext`/`index.vector`/`index.spatial` are documented in the ADR/spec only — NOT registered (YAGNI + 1.0 freeze).
- **Physical escapes** (`@using`/`@expr`/`@where`/`@orders`) are RDB-physical, contributed by the **db/persistence provider** to BOTH `identity.secondary` and `index.lookup`; consumed only by RDB codegen. `@orders` is a `string[]` positional to `@fields`, values `asc|desc`.
- **`index.lookup` is non-unique by definition** — `@unique` is never registered on `index.*`.
- **`index`/`identity` nodes are children of `object.entity`.** `index.lookup` requires ≥1 field in `@fields`; every field must resolve against the entity's effective fields.
- **Sigil-free YAML authoring** (ADR-0006); canonical JSON uses `@`-attrs. Cross-port serialized form must stay byte-identical (canonical serializer).
- **Public-repo hygiene:** never name the adopter projects in any committed file — use "a downstream adopter". This repo is public.
- **Cross-port execution:** each port task mirrors the TS reference contract and must turn the shared conformance fixtures green; per-port unit tests in addition.

---

### Task 1: ADR — record the decision

**Files:**
- Create: `spec/decisions/ADR-0040-index-type-and-secondary-key-purity.md`
- Modify: `docs/superpowers/specs/2026-07-01-index-type-and-secondary-key-purity-design.md` (add the ADR pointer under "Docs to update")

- [ ] **Step 1: Write the ADR** (Nygard format). Context: `identity.secondary` accreted the full index vocab (`fields/unique/expr/using/orders/where`); two adopters use it for both unique keys (`*_unique`) and non-unique indexes (`idx_*`, incl. composite). Decision: (1) `identity.secondary` = unique alternate key, `@unique` removed; (2) new `index.*` type, `index.lookup` ships (non-unique retrieval); (3) `fulltext`/`vector`/`spatial` reserved-not-registered; (4) `@using/@expr/@where/@orders` = RDB-physical escapes on both, contributed by the db provider. Consequences: breaking (migration), supersedes PR #142, feeds the 1.0 vocab-freeze. Apply the ADR-0037 "what does X do?" test explicitly. Genericize adopter references.

- [ ] **Step 2: Add the CLAUDE.md pointer.** In `CLAUDE.md` under the identity/relationship vocabulary bullet, add: `index.lookup` (non-unique retrieval; uniqueness-in-the-type: `identity.secondary`=unique, `index.lookup`=non-unique; `@using/@expr/@where/@orders` RDB-physical escapes) → see ADR-0040. Note `index.fulltext/vector/spatial` reserved.

- [ ] **Step 3: Commit.**
```bash
git add spec/decisions/ADR-0040-index-type-and-secondary-key-purity.md CLAUDE.md docs/superpowers/specs/2026-07-01-index-type-and-secondary-key-purity-design.md
git commit -m "docs(adr): ADR-0040 — index.* type + identity.secondary key-purity"
```

---

### Task 2: TS reference — `index.lookup` vocabulary + constants + registration

**Files:**
- Modify: `server/typescript/packages/metadata/src/constants.ts` (add `INDEX` type, `INDEX_SUBTYPE_LOOKUP`, `INDEX_ATTR_FIELDS`, and reuse existing `IDENTITY_ATTR_*` names for `USING/EXPR/WHERE/ORDERS`)
- Create: `server/typescript/packages/metadata/src/core/index/meta-index.ts` (the `MetaIndex` node class — mirror `core/identity/meta-identity.ts`)
- Modify: the TS core provider that registers identity subtypes (mirror how `identity.secondary` is registered — find via `grep -rn "identity" server/typescript/packages/metadata/src/**/provider*.ts` and the sibling that calls the equivalent of `def.optionalAttribute`) — register `index.lookup` with `@fields`
- Modify: the TS **db/persistence provider** (the one contributing `@using/@expr/@where/@orders/@unique` to `identity.secondary` today — `grep -rn "unique\|orders\|using" server/typescript/packages/metadata/src/persistence/`): (a) REMOVE `@unique` from `identity.secondary`; (b) add `@using/@expr/@where/@orders` to `index.lookup`; keep them on `identity.secondary` minus `@unique`
- Test: `server/typescript/packages/metadata/test/index-type.test.ts`

**Interfaces:**
- Produces: `INDEX = "index"`, `INDEX_SUBTYPE_LOOKUP = "lookup"`, `INDEX_ATTR_FIELDS = "fields"`; `MetaIndex` with `.fields(): string[]`; `index.lookup` registered with attrs `{fields, using, expr, where, orders}` (NO `unique`); `identity.secondary` attrs now `{fields, using, expr, where, orders}` (NO `unique`).

- [ ] **Step 1: Write the failing test** — load metadata with an `object.entity` containing `index.lookup { name, fields:[customerId, placedAt], orders:[asc,desc] }`, assert it loads, resolves fields, `index.fields()` returns `["customerId","placedAt"]`; assert `@unique` on `index.lookup` → `ERR_UNKNOWN_ATTR`; assert `@unique` on `identity.secondary` → `ERR_UNKNOWN_ATTR`.
- [ ] **Step 2: Run — verify it fails** (`index` type unregistered). `cd server/typescript && bun test packages/metadata/test/index-type.test.ts`
- [ ] **Step 3: Add constants + `MetaIndex` + register `index.lookup` in the core provider; move the physical attrs in the db provider; remove `@unique`.**
- [ ] **Step 4: Run — verify it passes.**
- [ ] **Step 5: Commit** `feat(metadata): index.lookup type + drop @unique from identity.secondary (TS)`.

---

### Task 3: TS reference — validation (field resolution + @unique rejection)

**Files:**
- Modify: `server/typescript/packages/metadata/src/loader/validation-passes.ts` (add an `index.lookup` field-resolution pass mirroring the `identity.secondary` `@fields` resolution — reuse the resolving accessor per ADR-0039)
- Test: `server/typescript/packages/metadata/test/index-validation.test.ts`

**Interfaces:**
- Consumes: `MetaIndex.fields()` (Task 2).
- Produces: loader error `ERR_INVALID_INDEX` when an `index.lookup` has 0 fields or references a non-existent field.

- [ ] **Step 1: Write the failing test** — `index.lookup` with empty `fields` → error; with a field that doesn't resolve → error; with valid inherited field (via `extends`) → OK (ADR-0039 resolving accessor).
- [ ] **Step 2: Run — fails.**
- [ ] **Step 3: Implement the validation pass** (mirror the identity `@fields` pass; iterate the effective field set via `children()`/`fields()`, not `own*`).
- [ ] **Step 4: Run — passes.**
- [ ] **Step 5: Commit** `feat(metadata): index.lookup field-resolution validation (TS)`.

---

### Task 4: TS reference — registry manifest (the shared 5-port contract)

**Files:**
- Modify: `fixtures/registry-conformance/expected-registry.json` (add `index.lookup` with its attrs; REMOVE `unique` from `identity.secondary`)
- Modify: `fixtures/registry-conformance/README.md` (note `index.lookup`; reserved subtypes)
- Test: the TS registry-conformance runner (`grep -rln "expected-registry" server/typescript`)

**Interfaces:**
- Produces: the byte-exact manifest all five ports must match.

- [ ] **Step 1: Update `expected-registry.json`** — add the `index` type block with `lookup` subtype + attrs `{fields, using, expr, where, orders}` (+ common doc attrs); delete the `unique` attr entry under `identity.secondary`. Keep ordering canonical.
- [ ] **Step 2: Run the TS registry-conformance test — verify it now matches the TS emitted registry** (green after Task 2 made the TS registry carry `index.lookup` + dropped `@unique`).
- [ ] **Step 3: Commit** `feat(conformance): register index.lookup + drop identity.secondary @unique in the manifest`.

---

### Task 5: TS reference — codegen (Drizzle ORM table + migrate DDL)

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/templates/drizzle-schema.ts:117-135` (retarget: emit `index(...)` for `index.lookup` nodes; `identity.secondary` now ALWAYS `uniqueIndex(...)`; drop the `uniqueAttr !== false` branch — read `index.lookup` children instead)
- Modify: `server/typescript/packages/migrate-ts/src/expected-schema.ts` (the index-DDL builder — around the `@orders` handling at :375; emit `CREATE INDEX` for `index.lookup` honoring `@orders/@using/@expr/@where`; `identity.secondary` → unique index/constraint)
- Test: `server/typescript/packages/codegen-ts/test/index-lookup-codegen.test.ts`, `server/typescript/packages/migrate-ts/test/index-lookup-ddl.test.ts`

**Interfaces:**
- Consumes: `MetaIndex` (Task 2).
- Produces: Drizzle `index("idx_...").on(...)` for non-unique; DDL `CREATE INDEX ... (col ASC, col DESC)` honoring `@orders`.

- [ ] **Step 1: Write failing codegen tests** — entity with a composite `index.lookup { fields:[customerId, placedAt], orders:[asc,desc] }` → Drizzle emits `index("idx_...").on(table.customerId, table.placedAt)` (NOT `uniqueIndex`); a `identity.secondary` → `uniqueIndex`. Migrate: DDL emits `CREATE INDEX idx_... ON orders (customer_id, placed_at DESC)`; a `identity.secondary` → `UNIQUE`.
- [ ] **Step 2: Run — fail.**
- [ ] **Step 3: Implement** the drizzle + migrate retargeting.
- [ ] **Step 4: Run — pass. Regenerate any golden that legitimately changes** (an entity that had `identity.secondary @unique:false` in a fixture now uses `index.lookup`; verify the new output is correct before committing the golden).
- [ ] **Step 5: Commit** `feat(codegen-ts): emit index.lookup as non-unique index (Drizzle + DDL)`.

---

### Task 6: Shared conformance fixtures (metadata + persistence)

**Files:**
- Create: `fixtures/conformance/index-lookup/` (input `meta.*.json` with a unique `identity.secondary` + single/composite `index.lookup` incl. `@orders:[asc,desc]`; `expected.json` own + `expected-effective.json`)
- Modify: `fixtures/persistence-conformance/canonical/meta.fitness.json` + regenerate `canonical/schema.postgres.sql` (add a composite non-unique `index.lookup` so the TS-produced DDL carries `CREATE INDEX` and every port provisions it)
- Modify: any existing conformance fixture that currently uses `identity.secondary @unique:false` → migrate to `index.lookup` (grep `fixtures/ -rln "unique.*false"`)
- Test: TS conformance runner + the persistence runner

- [ ] **Step 1: Add the metadata fixture** exercising load + canonical serialize (own + effective) of `index.lookup`.
- [ ] **Step 2: Add the composite `index.lookup` to the persistence canonical fixture; regenerate `schema.postgres.sql` via the TS migrate tool; verify the `CREATE INDEX` is correct.**
- [ ] **Step 3: Migrate any `@unique:false` fixtures to `index.lookup`.**
- [ ] **Step 4: Run TS conformance + persistence (Testcontainers) — green.**
- [ ] **Step 5: Commit** `feat(conformance): index-lookup metadata + persistence fixtures`.

---

### Tasks 7–10: Fan-out — C# / Java / Kotlin / Python

Each port mirrors the TS reference contract (Tasks 2–5) and turns the shared conformance fixtures (Task 4 registry, Task 6 metadata/persistence) green. **Java (Task 8) and Kotlin (Task 9) share the JVM `metadata` module** — the vocabulary/validation is done once in Java (Task 8); Kotlin (Task 9) is codegen-only (Exposed). Each task ends green on its port's suites + the shared gates.

### Task 7: C# port

**Files:**
- Create: `server/csharp/MetaObjects/Core/Index/IndexSchema.cs` (mirror `Core/Identity/IdentitySchema.cs`), `server/csharp/MetaObjects/Meta/MetaIndex.cs` (mirror `Meta/MetaIdentity.cs`)
- Modify: the C# provider registering identity subtypes → register `index.lookup`; the C# db provider → drop `@unique` from `identity.secondary`, add physical attrs to `index.lookup`
- Modify: `server/csharp/MetaObjects/Loader/ValidationPasses.cs` (index field-resolution + `@unique`-rejected); EF codegen leaves indexes to DDL (per the design table — **no EF model change**; confirm the DDL path, which is TS-owned, is unaffected)
- Test: `server/csharp/MetaObjects.Codegen.Tests/IndexLookupTests.cs` (+ registry/validation conformance)

- [ ] Steps: write failing unit tests (load `index.lookup`; `@unique` rejected on both types; field resolution) → implement schema/meta/provider/validation → run C# registry-conformance + validation-conformance + the shared metadata fixture → green → commit `feat(csharp): index.lookup + drop identity.secondary @unique`.

### Task 8: Java port (JVM metadata — shared with Kotlin)

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/index/Index.java` + `LookupIndex.java` (mirror `identity/SecondaryIdentity.java`), `index/IndexTypesMetaDataProvider.java` (mirror `identity/IdentityTypesMetaDataProvider.java`)
- Modify: `server/java/metadata/src/main/java/com/metaobjects/identity/SecondaryIdentity.java` (remove `ATTR_UNIQUE` + its `optionalAttributeWithConstraints` registration + `isUniqueKey()`); the db provider that contributes `@unique` → drop it, contribute physical attrs to `index.lookup`
- Modify: the loader validation phase (`ValidationPhase`) — index field-resolution + `@unique`-rejected
- Register the new provider (ServiceLoader / the provider set)
- Test: `server/java/metadata/src/test/java/com/metaobjects/index/IndexLookupTest.java` (+ registry/validation conformance runners)

- [ ] Steps: failing tests → `Index`/`LookupIndex`/provider + remove `SecondaryIdentity.ATTR_UNIQUE`/`isUniqueKey()` + validation → run `mvn -pl metadata test` + JVM registry-conformance → green → commit `feat(jvm): index.lookup + remove identity.secondary @unique (metadata)`.

### Task 9: Kotlin codegen (Exposed)

**Files:**
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt` — emit indexes from `index.lookup` children (`index("name", false, cols…)` + `@orders`); `identity.secondary` → always `uniqueIndex(...)`. This **retargets PR #142's change** from `identity.secondary @unique:false` to `index.lookup` (reuse its `index(name,false,…)` emission shape). Remove the `SecondaryIdentity.isUniqueKey()` read (deleted in Task 8).
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGeneratorTest.kt` — `index.lookup` (composite + `@orders`) → `index("idx_...", false, …)`; `identity.secondary` → `uniqueIndex`.

- [ ] Steps: failing test (retarget #142's test to `index.lookup`) → implement → `mvn -pl codegen-kotlin test` + Kotlin integration (Testcontainers) → green → commit `feat(codegen-kotlin): emit index.lookup as Exposed non-unique index`.

### Task 10: Python port

**Files:**
- Create: `server/python/src/metaobjects/spec_metamodel/index.json` (mirror `spec_metamodel/identity.json` — declares `index.lookup` + attrs), `server/python/src/metaobjects/meta/core/index/meta_index.py` + `index_constants.py` (mirror `meta/core/identity/`)
- Modify: `server/python/src/metaobjects/spec_metamodel/identity.json` (remove `unique` from `identity.secondary`); `provider.py` (register the index provider); the db provider contributes physical attrs to `index.lookup`; validation passes (field-resolution + `@unique`-rejected)
- Test: `server/python/tests/metamodel/test_index_lookup.py` (+ registry/validation conformance)

- [ ] Steps: failing tests → `index.json`/`meta_index`/register + remove `unique` + validation → `uv run pytest` + Python registry-conformance + shared metadata fixture → green → commit `feat(python): index.lookup + drop identity.secondary @unique`.

---

### Task 11: Migration (this repo's fixtures already done; adopter script)

**Files:**
- Create: `docs/features/migrations/identity-secondary-to-index-lookup.md` (the rewrite rule + a `sed`/script sketch, genericized) — the `identity.secondary{unique:false}→index.lookup` and `{unique:true|absent}→identity.secondary (drop unique)` transform
- Modify: `server/typescript/packages/migrate-ts` — confirm the migration lane treats a dropped `@unique` + `identity.secondary→index.lookup` as a no-op schema diff (the physical index is unchanged; only the metadata vocabulary moved)
- Test: `server/typescript/packages/migrate-ts/test/index-migration-noop.test.ts`

- [ ] **Step 1: Write a failing test** — the same physical schema declared as `identity.secondary @unique:false` (old) vs `index.lookup` (new) produces an **empty** migration diff (no DDL churn).
- [ ] **Step 2–4:** implement/confirm → the diff is empty → passes.
- [ ] **Step 5: Write the migration doc** (genericized) + commit `docs(migrate): identity.secondary → index.lookup migration guide + no-op diff test`.

---

### Task 12: Docs — metamodel spec + metamodel-docs fixtures + agent-context

**Files:**
- Modify: the canonical metamodel spec files describing `identity.secondary`'s attrs (`grep -rln "identity.secondary\|@orders" spec/`) — drop `@unique`, add `index.lookup`, note reserved subtypes
- Modify: `fixtures/metamodel-docs/expected/types/identity.md` (drop `@unique` row); Create: `fixtures/metamodel-docs/expected/types/index.md`; refresh `fixtures/metamodel-docs/expected/INDEX.md` + `providers.md` (regenerate via the docs generator, verify the diff)
- Modify: `agent-context/skills/metaobjects-authoring/SKILL.md` (how to declare a non-unique index (`index.lookup`) vs a unique key (`identity.secondary`); uniqueness-in-the-type); regenerate `fixtures/agent-context-conformance/*/expected/…`
- Test: the metamodel-docs conformance + agent-context conformance + vocabulary-drift gates

- [ ] **Step 1: Regenerate metamodel-docs** (run the docs generator; `index.md` appears, `identity.md` loses `@unique`). Verify the diff is exactly that.
- [ ] **Step 2: Update the authoring skill + regenerate agent-context fixtures.** Run the drift/grounding gates — green (grounding-safe: `index`/`lookup` are now registered).
- [ ] **Step 3: Update the canonical metamodel spec.**
- [ ] **Step 4: Run all doc/conformance gates — green. Commit** `docs(metamodel): index.lookup + drop identity.secondary @unique (spec, docs, skills)`.

---

### Task 13: Integrate, gate, merge, close #142

- [ ] **Step 1: Integrate** all port branches into `feat/index-type-design` (disjoint per-port files + shared fixtures TS-owned).
- [ ] **Step 2: Run the full cross-port gate** — dispatch `conformance.yml` + `integration-tests.yml` on the branch; confirm registry/validation/persistence/metamodel-docs/agent-context all green on all 5 ports.
- [ ] **Step 3: Open the PR**, summary noting it supersedes #142 (index.lookup replaces `identity.secondary @unique:false`).
- [ ] **Step 4: Close PR #142** as superseded (comment: the non-unique case moved to `index.lookup`; no `@unique:false` to honor).
- [ ] **Step 5: Merge** after the gate is green.

---

## Notes for the executor

- **Follow the ADR-0039 discipline** everywhere: read the effective field set via resolving accessors (`fields()`/`children()`), never `own*`, when resolving `index.lookup.@fields`.
- **Zero golden changes expected** except where a fixture legitimately moves from `identity.secondary @unique:false` → `index.lookup` (Task 6) — verify each such golden's new output is correct before committing it.
- **The physical escapes come from the db provider, not core** — do not register `@using/@expr/@where/@orders` on the core `index`/`identity` type; register them where `@dbColumnType` is registered (the persistence/db provider), on both `index.lookup` and `identity.secondary`.
- **Release:** this is a breaking metamodel change → a coordinated minor after merge (next release line), consistent with the 1.0 vocab-freeze narrative. Not part of this plan; flag at merge.
