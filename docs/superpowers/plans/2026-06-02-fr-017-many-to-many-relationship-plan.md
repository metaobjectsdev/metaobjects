# FR-017 Many-to-Many Relationship — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Fresh subagent per unit + spec-compliance review + code-quality review + simplifier, then merge forward. Steps use `- [ ]`. TDD throughout. Cross-port porting principle: **study the existing per-port implementation of the analogous 1:N relationship before writing M:N** — don't re-derive from spec.

**Goal:** Ship a slim, semantic M:N relationship across all five ports — vocabulary (`@through`/`@sourceRefField`/`@symmetric`, `@joinFields` removed/derived), runtime resolvers, codegen (entity nav + ORM + repository + REST traversal + docs), and full conformance coverage of hetero / directed-self-join / symmetric.

**Architecture:** Contract-first. TS defines the metamodel vocabulary + validation + the shared conformance fixtures + the SP-G registry canonical; each other port mirrors against those fixtures. Then runtime resolvers (per port, metadata-driven, derive FK fields from the junction's `identity.reference`), then codegen + REST + docs (FR-007 semantic-parity-gated), then integration.

**Tech stack:** metamodel registries (`relationship-*`), `identity.reference` derivation (`find-reference.*`), runtime query layers (TS `runtime-ts/n2m-resolver`, Java OMDB, Kotlin Exposed, Python ObjectManager, C# EF), codegen (Drizzle/EF/Spring/Exposed/SQLAlchemy + REST), doc-gen, and the shared corpora (`fixtures/conformance/`, `fixtures/persistence-conformance/`, `fixtures/api-contract-conformance/`, `fixtures/codegen-conformance/`, `fixtures/registry-conformance/`, render/doc).

**Spec:** `docs/superpowers/specs/2026-06-02-fr-017-many-to-many-relationship-design.md`. **Per-unit acceptance = the shared conformance fixtures pass for that port** — the corpus IS the spec.

**Coordination:** FR-017 changes the relationship vocabulary in the SP-G registry canonical. Land Phase 1 (vocabulary) BEFORE SP-G merges, or as a coordinated canonical update. FR-017 supersedes the SP-G Java-reconciliation join-vocab step.

---

## Phase 1 — Metamodel vocabulary + validation + shared fixtures (the contract)

### Unit 1: TS metamodel — slim vocabulary, validation, derivation, fixtures, canonical

**Files:**
- Modify: `server/typescript/packages/metadata/src/core/relationship/relationship-constants.ts` (rename `JOIN_ENTITY`→`THROUGH`; remove `JOIN_FIELDS`; add `SOURCE_REF_FIELD`, `SYMMETRIC`)
- Modify: `relationship-schema.ts` (register `through:string` required-for-M:N, `sourceRefField:string` optional, `symmetric:boolean` optional; remove `joinFields`), `meta-relationship.ts` (getters)
- Modify/Create: a M:N derivation helper beside `find-reference.ts` (derive `[sourceFK, targetFK]` from the junction's two `identity.reference` children; handle directed self-join via `@sourceRefField`; error on ambiguous)
- Modify: the relationship validation pass (symmetric-self-join-only; symmetric⊕sourceRefField; junction-must-exist-and-declare-two-references; M:N-attrs-invalid-on-1:N) — deferred-resolution validation after load
- Create: `fixtures/conformance/` M:N fixtures — positive: `relationship-m2m-hetero`, `relationship-m2m-self-join-directed`, `relationship-m2m-self-join-symmetric`; error: `error-relationship-symmetric-on-hetero`, `error-relationship-symmetric-and-sourceref`, `error-relationship-through-missing-junction-refs`, `error-relationship-m2m-attr-on-1n`
- Modify: `fixtures/registry-conformance/expected-registry.json` (relationship subtypes: `through`/`sourceRefField`/`symmetric`; no `joinFields`)
- Modify: `CLAUDE.md` cross-language-porting (relationship vocab) + `spec/` metamodel docs

- [ ] **Step 1 — Constants + schema (write failing TS metadata test first).** Add a test asserting a `relationship.association` with `@cardinality:"many"`, `@objectRef`, `@through` loads, and that `@joinEntity`/`@joinFields` are now unknown attrs. Then rename/add constants + schema. Use named constants only.
- [ ] **Step 2 — Derivation helper (TDD).** Test: given a junction entity with two `identity.reference` children, derive `[sourceFK, targetFK]` for a hetero relationship; for self-join, require `@sourceRefField`; error when ambiguous-and-undisambiguated. Implement beside `find-reference.ts`.
- [ ] **Step 3 — Validation pass (TDD per rule).** One failing test per rule (symmetric-on-hetero → `ERR_BAD_ATTR_VALUE`; symmetric+sourceRefField → error; through-names-junction-without-two-references → error after deferred resolution; M:N attr on `@cardinality:one` → error). Implement.
- [ ] **Step 4 — Author the shared fixtures.** Create the 3 positive + 4 error `fixtures/conformance/` fixtures (canonical-JSON input + `expected.json` / `expected-errors.json` per the corpus format). Run the TS conformance runner green.
- [ ] **Step 5 — Update the SP-G registry canonical.** Regenerate `expected-registry.json`; relationship subtypes now carry `through`/`sourceRefField`/`symmetric`, no `joinFields`. TS registry-conformance test green.
- [ ] **Step 6 — Docs.** Update CLAUDE.md + metamodel spec: `@through`/`@sourceRefField`/`@symmetric`; remove `joinEntity`/`joinFields`.
- [ ] **Step 7 — Review + simplify gate. Commit.** `feat(metadata): FR-017 Unit1 — TS M:N slim vocabulary (through/sourceRefField/symmetric) + derivation + validation + fixtures`

### Unit 2: C# metamodel — mirror vocabulary + validation

**Files:** `server/csharp/MetaObjects/Core/Relationship/*` (constants, schema, MetaRelationship), the C# validation passes, the C# derivation helper, the C# registry-conformance + metamodel-conformance runners.

- [ ] **Step 1 — Study the C# 1:N relationship + identity.reference handling**, then mirror the TS slim vocab (rename/remove/add) + getters.
- [ ] **Step 2 — Derivation + validation** to match the shared fixtures' error codes/sources (study TS Unit 1).
- [ ] **Step 3 — Run the shared metamodel fixtures + registry-conformance** (against the Unit-1 canonical) green.
- [ ] **Step 4 — Review + simplify gate. Commit.** `feat(metadata): FR-017 Unit2 — C# M:N slim vocabulary + validation (matches shared fixtures)`

### Unit 3: Java metamodel — register slim vocabulary + validation (supersedes SP-G join step)

**Files:** `server/java/metadata/.../relationship/MetaRelationship.java` + subtypes, the loader validation phase, the Java derivation helper, the Java metamodel + registry-conformance runners.

- [ ] **Step 1 — Register the FINAL slim vocab** (`through`/`sourceRefField`/`symmetric`) — NOT the interim `joinEntity`/`joinFields` (Java never had them; do not add them). Keep `cardinality`/`objectRef`/`onDelete`/`onUpdate`.
- [ ] **Step 2 — Derivation + validation** matching the shared fixtures (study TS Unit 1 + the existing Java `identity.reference` handling).
- [ ] **Step 3 — Run the shared metamodel fixtures + registry-conformance** green. (Note: this is the relationship slice of the SP-G Java reconciliation — coordinate with that plan.)
- [ ] **Step 4 — Review + simplify gate. Commit.** `feat(metadata): FR-017 Unit3 — Java M:N slim vocabulary + validation`

### Unit 4: Python + Kotlin metamodel

**Files:** `server/python/src/metaobjects/.../relationship_*` + validation + runners; Kotlin shares the JVM registry (Unit 3) — add/confirm the Kotlin registry-conformance + metamodel assertions.

- [ ] **Step 1 — Python:** mirror the slim vocab + derivation + validation (study TS + Python's `identity.reference` handling); shared metamodel + registry-conformance green.
- [ ] **Step 2 — Kotlin:** confirm the shared JVM registry (Unit 3) yields the slim vocab; run the Kotlin metamodel/registry assertions green.
- [ ] **Step 3 — Review + simplify gate. Commit.** `feat(metadata): FR-017 Unit4 — Python + Kotlin M:N slim vocabulary + validation`

**End of Phase 1:** the slim M:N vocabulary loads + validates identically in all five ports; the shared metamodel + registry fixtures are green cross-port; the canonical reflects the slim vocab.

---

## Phase 2 — Runtime M:N resolvers (metadata-driven, all five ports)

Each port gets a generic resolver: target/junction from the relationship, FK fields derived from the junction's `identity.reference`, three modes (hetero / directed-self-join via `@sourceRefField` / symmetric via union-on-read). Persistence-conformance is the gate.

### Unit 5: Persistence-conformance M:N fixtures + TS runtime resolver

**Files:**
- Create: `fixtures/persistence-conformance/` M:N scenarios — hetero, directed self-join, symmetric (schema = junction table + two FKs; query = traverse the join; expected results)
- Modify: `server/typescript/packages/runtime-ts/src/n2m-resolver.ts` (derive FK fields from junction references; handle `@sourceRefField`; add symmetric union path), `object-manager.ts` (`.relate()`/eager-include)
- Modify: `server/typescript/packages/runtime-ts/test/fixtures/n2m-shape.json` (junction declares two `identity.reference` children)

- [ ] **Step 1 — Author the persistence-conformance M:N fixtures** (the shared corpus; document the expected resolution for all three modes).
- [ ] **Step 2 — Update the TS resolver (TDD).** Derive `[sourceFK, targetFK]` from the junction references; directed self-join uses `@sourceRefField`; symmetric does `WHERE srcFK=? OR tgtFK=?` and picks the non-self column. Remove the `joinFields` dependency.
- [ ] **Step 3 — Run the persistence-conformance M:N scenarios** on TS against Testcontainers Postgres green (via `scripts/integration-test.sh`).
- [ ] **Step 4 — Review + simplify gate. Commit.** `feat(runtime-ts): FR-017 Unit5 — M:N persistence fixtures + reference-derived resolver (hetero/self-join/symmetric)`

### Units 6–9: Java OMDB / Kotlin Exposed / Python ObjectManager / C# EF runtime resolvers

For EACH port (one unit each): study the port's existing 1:N runtime query path, implement the generic M:N resolver mirroring TS's semantics, and run the shared persistence-conformance M:N scenarios green against Testcontainers Postgres.

- [ ] **Unit 6 — Java OMDB.** Resolver in OMDB; persistence-conformance M:N green (Java). Review + simplify. Commit `feat(omdb): FR-017 Unit6 — Java runtime M:N resolver`
- [ ] **Unit 7 — Kotlin Exposed.** Resolver via Exposed; `integration-tests-kotlin` M:N green. Review + simplify. Commit `feat(codegen-kotlin): FR-017 Unit7 — Kotlin runtime M:N resolver`
- [ ] **Unit 8 — Python ObjectManager.** Resolver in ObjectManager; persistence-conformance M:N green (Python). Review + simplify. Commit `feat(python): FR-017 Unit8 — Python runtime M:N resolver`
- [ ] **Unit 9 — C# EF.** Resolver via EF; persistence-conformance M:N green (C#). Review + simplify. Commit `feat(csharp): FR-017 Unit9 — C# runtime M:N resolver`

**End of Phase 2:** all five ports resolve all three M:N modes at runtime against the shared persistence corpus.

---

## Phase 3 — Codegen (entity nav + ORM + repository + REST) + docs + FR-007

Each port emits idiomatic M:N. FR-007 semantic codegen-conformance asserts parity (navigation member exists, right target through right junction, right cardinality/symmetry); api-contract-conformance asserts REST traversal in both lanes.

### Unit 10: api-contract + codegen-conformance M:N fixtures + TS codegen

**Files:**
- Create: `fixtures/api-contract-conformance/` M:N scenarios (both lanes) + `fixtures/codegen-conformance/` M:N semantic manifest entries (FR-007)
- Modify: `server/typescript/packages/codegen-ts/src/relation-resolver.ts` (stop `continue`-ing on M:N; emit Drizzle many-to-many through the junction + entity navigation), routes/hooks generators (REST traversal of the join)

- [ ] **Step 1 — Author the api-contract + codegen-conformance M:N fixtures** (the shared corpora; both api-contract lanes; FR-007 semantic manifest shape for M:N).
- [ ] **Step 2 — TS codegen (TDD).** Emit Drizzle relations many-to-many + entity navigation + REST routes that traverse the join + hooks. FR-007 TS manifest entry matches; api-contract TS lanes green.
- [ ] **Step 3 — Review + simplify gate. Commit.** `feat(codegen-ts): FR-017 Unit10 — M:N codegen (Drizzle m2m + nav + REST) + api-contract/codegen fixtures`

### Units 11–14: C# / Java / Kotlin / Python codegen

For EACH port (one unit each): study the port's existing relation codegen, emit M:N (entity navigation + ORM wiring + repository join + REST traversal), and run the shared api-contract (both lanes) + codegen-conformance (FR-007 semantic parity) green.

- [ ] **Unit 11 — C# codegen.** EF `UsingEntity<Through>(...)` + navigation + minimal-API traversal. Corpora green. Review + simplify. Commit `feat(csharp-codegen): FR-017 Unit11 — C# M:N codegen`
- [ ] **Unit 12 — Java codegen-spring.** Navigation + repository join + controller traversal + DTO (+ JPA `@ManyToMany`/`@JoinTable` where applicable). Corpora green. Review + simplify. Commit `feat(codegen-spring): FR-017 Unit12 — Java M:N codegen`
- [ ] **Unit 13 — Kotlin codegen.** Exposed many-to-many + controller. Corpora green. Review + simplify. Commit `feat(codegen-kotlin): FR-017 Unit13 — Kotlin M:N codegen`
- [ ] **Unit 14 — Python codegen.** SQLAlchemy `secondary=<junction>` + Pydantic nested + FastAPI traversal. Corpora green. Review + simplify. Commit `feat(python-codegen): FR-017 Unit14 — Python M:N codegen`

### Unit 15: Documentation (M:N edge, incl. symmetric) — respect ADR-0020 tiering

**ADR-0020 (codegen tiering, shipped 2026-06-02):** language-neutral artifacts are ONE shared TS engine (Tier 2) — **do NOT port the docs builder per-port.** So M:N documentation splits:
- **Standalone doc pages / Mermaid (Tier 2):** the shared TS `meta docs` engine (root `templates/`) gains the M:N edge (through the junction; symmetric marked). One engine → output is inherently identical; gated by the existing docs byte-identity gate. NOT emitted per-port.
- **Inline code-doc (Tier 1, per-port):** JSDoc / XML-doc / Postgres `COMMENT ON` emitted *into generated code* describing the M:N navigation — this is part of each port's native codegen (folded into Units 10–14), not a separate per-port doc builder.

**Files:** `server/typescript/packages/` shared docs engine + root `templates/` (Tier 2 M:N page edge); doc-conformance / docs byte-identity fixtures.

- [ ] **Step 1 — Author the M:N docs fixture** for the shared docs engine (the M:N edge + symmetric); `notes` stays internal-only per the documentation-provider contract.
- [ ] **Step 2 — Add the M:N edge to the shared TS `meta docs` engine** (Tier 2). Docs byte-identity gate green. Confirm inline code-doc for M:N nav was handled in the per-port codegen units (10–14), not duplicated here.
- [ ] **Step 3 — Review + simplify gate. Commit.** `feat(docs): FR-017 Unit15 — M:N documentation in shared docs engine (Tier 2, ADR-0020)`

**End of Phase 3:** every port emits M:N codegen + REST + docs; FR-007 + api-contract + doc corpora green cross-port.

---

## Phase 4 — Integration, cleanup, finish

### Unit 16: Cross-port green sweep + docs + remove all legacy references + merge

- [ ] **Step 1 — Full cross-port green.** All corpora (metamodel/registry/persistence/api-contract/codegen/doc) green on all five ports for all three M:N modes + the error fixtures.
- [ ] **Step 2 — Remove every `joinEntity`/`joinFields` reference** repo-wide (grep; code, fixtures, docs). No backwards-compat shims.
- [ ] **Step 3 — Docs final.** CLAUDE.md cross-language-porting + metamodel spec describe the slim M:N model + `@symmetric`; roadmap updated; spec status → implemented.
- [ ] **Step 4 — Final review + merge.** Simplifier + final reviewer over the whole FR-017 diff (focus: vocabulary identical cross-port; derivation correct; three modes resolve correctly everywhere; codegen idiomatic + FR-007-parity; REST both lanes; no legacy vocab remains). Merge forward (integrate-before-merge).

## Self-review notes
- **Contract-first ordering is load-bearing.** Phase 1 (TS vocab + shared fixtures + canonical) defines the spec every later unit verifies against. Don't start a port's runtime/codegen before its metamodel unit is green.
- **The corpus is the spec.** Each port-mirror unit's acceptance is the shared fixtures passing — that's why the plan says "study the existing port impl + match the fixtures" rather than enumerating per-port code (which is discovered by reading the reference, per the project's porting principle).
- **`@symmetric` is self-join-only + mutually exclusive with `@sourceRefField`** — enforce in Phase 1 validation; resolvers (Phase 2) implement union-on-read; don't double-store.
- **Coordinate the canonical with SP-G.** Phase 1 Unit 1 changes `expected-registry.json`; if SP-G hasn't merged, land this first or update both together. FR-017 Unit 3 IS the relationship slice of the SP-G Java reconciliation.
- **REST exposure (v1) + runtime resolvers (all ports, v1)** are both in scope per the 2026-06-02 decisions — don't defer them.
