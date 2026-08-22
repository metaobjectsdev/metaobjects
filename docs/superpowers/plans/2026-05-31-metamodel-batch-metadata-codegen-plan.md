# Metamodel Batch (FR-013/014/015/016 + ADR-0018) — Metadata + Codegen Workstream

> **For agentic workers:** REQUIRED SUB-SKILLS: `superpowers:brainstorming` (before each FR's implementation, brainstorm with the user if scope is unclear), `superpowers:test-driven-development` (every loader / codegen change is TDD-first against the conformance corpus), `superpowers:subagent-driven-development` (the per-port fan-outs are parallel-friendly subagent work once TS lands).
>
> **Gate:** the cross-port conformance corpus is the contract. A change is done when (a) its TS reference is green against the conformance fixtures it adds, AND (b) every other port — Java / Kotlin / C# / Python — runs the same fixtures byte-identically. No exceptions.

**Status:** Plan (in execution).
**Created:** 2026-05-31.
**Sister plan:** [migrate-ts workstream](2026-05-31-metamodel-batch-migrate-ts-plan.md) — runs in parallel on a separate session/machine. **Coordination contract is "metadata-lands-first per FR";** see [Coordination with migrate-ts session](#coordination-with-migrate-ts-session).

**Scope of this plan:** **metadata + codegen** across the four FRs. The four `migrate-ts` slices (FR-014 TPH DDL, FR-015 `pg_proc` introspect, FR-016 physical-name resolution rewrite, FR-013 optional `verify` warn) are **out of scope here** — the sister plan owns them.

Source designs:
- [ADR-0018 — Per-kind physical-name attributes within source paradigms](../../../spec/decisions/ADR-0018-per-kind-physical-name-attrs.md)
- [FR-013 — Field-level `@readOnly`](../specs/2026-05-28-fr-013-field-read-only-design.md)
- [FR-014 — TPH discriminator on `object.entity`](../specs/2026-05-28-fr-014-tph-discriminator-design.md)
- [FR-015 — `@parameterRef` on `source.rdb` (callable inputs)](../specs/2026-05-28-fr-015-source-parameter-ref-design.md)
- [FR-016 — `source.rdb` `name` + per-kind aliases (realizes ADR-0018)](../specs/2026-05-28-fr-016-source-rdb-name-and-kind-aliases-design.md)

This plan adds the three pieces missing from the per-FR design docs:
1. **Execution order + dependency map** so two of these FRs don't crash into each other.
2. **Generator-stack gap list per FR.** The FRs' per-port codegen tables describe the entity/ORM layer; this plan enumerates the additional generator surfaces — routes, hooks, forms, grids, filter allowlists, Spring controllers/DTOs/repos — each FR must touch and which aren't specified in the FRs themselves.
3. **A directive for FR-014 specifically:** write FR-017 as the first execution step of TPH work, before implementation. The TPH polymorphic-codegen design is its own beast and deserves a focused spec.

---

## Execution order + dependency rationale

```
        ┌────────────────┐
        │   FR-016       │  ← lands first; FR-014/015 use the new attr spellings
        │  name + per-   │
        │  kind aliases  │
        └────────┬───────┘
                 │
       ┌─────────┼─────────┐
       │         │         │
       ▼         ▼         ▼
  ┌─────────┐ ┌─────────┐ ┌─────────────────┐
  │ FR-013  │ │ FR-015  │ │   FR-014 + 017  │
  │@readOnly│ │parameter│ │ TPH discriminator│
  │         │ │   Ref   │ │ + polymorphic    │
  │         │ │         │ │ generator-stack  │
  └─────────┘ └─────────┘ └─────────────────┘
```

**Order:** FR-016 → (FR-013 ∥ FR-015 ∥ FR-014/017).

**Why FR-016 first.** FR-015's example metadata uses `@proc: "fn_x"` (not `@table: "fn_x"`), and the canonical-serializer rewrite from ADR-0018 changes the corpus's wire format. Landing FR-016 before adding new conformance fixtures for the other FRs means new fixtures use canonical per-kind spellings from the start — no churn.

**Why FR-013/015 are independent.** Different layers (FR-013 is field-attr; FR-015 is source-attr) with no shared loader code path.

**Why FR-014 needs FR-017 written first.** The metamodel piece of TPH (`@discriminator` + `@discriminatorValue` on `object.entity`) is well-specified in FR-014. The generator-stack design (polymorphic REST routes, per-subtype forms, discriminated-union hooks, per-subtype filter allowlists, Spring `@Inheritance` controllers / DTOs / repos / payload generators) is **not** specified. Implementing TPH without that design produces inconsistent per-port output. Write FR-017 first, then implement.

---

## Coordination with migrate-ts session

The sibling [migrate-ts plan](2026-05-31-metamodel-batch-migrate-ts-plan.md) runs in parallel. Coordination rules:

1. **Metadata-lands-first per FR.** This session pushes the metadata (constants, schemas, loader validation, canonical-serializer, conformance fixtures) for FR-N to `main` BEFORE the migrate-ts session starts FR-N migrate-ts work. The migrate-ts session reads the loaded model — without the new attrs registered, the migrate-ts work has nothing to consume.
2. **Per-FR push beacon.** When the metadata commit for an FR lands on `main`, leave a single-line comment in the sister plan's "FR-N preflight" row marking it green (or just message the user; the user is the human courier between the two sessions).
3. **Disjoint package directories.** This session touches `packages/metadata`, `packages/codegen-ts*`, `packages/runtime-ts`, `server/java/codegen-spring`, `server/kotlin/codegen-kotlin`, C# / Python codegen. The migrate-ts session touches `packages/migrate-ts` only. No code-file overlap.
4. **Shared resources** that need coordination:
   - `fixtures/conformance/` — this session owns metamodel fixtures (round-trip + loader validation).
   - `fixtures/persistence-conformance/` — both sessions add fixtures: this session adds query scenarios for new attrs (e.g., TPH polymorphic queries); the migrate-ts session adds migration scenarios for new DDL emission.
   - Conformance corpus regeneration after FR-016 (canonical rewrite of `@table` → `@view`/`@proc`/etc. for non-table kinds) is a **this session task** since it's the canonical-serializer output that changes; the migrate-ts session pulls and continues.

---

## Recommended workflow for this session

1. **Pull latest** every time you start. The migrate-ts session pushes to `main` too.
2. **Read the four spec docs + ADR-0018** in this order: ADR-0018, FR-016, FR-013, FR-015, FR-014.
3. **Pick a task.** Start with FR-016 (smallest, unblocks everything). When FR-016 metadata lands, signal the migrate-ts session, then fan out FR-013 + FR-015 in parallel here, and start FR-014 by writing FR-017.
4. **Per-FR rhythm:** brainstorm (only if the FR's design has gaps you discover) → write TDD-style task list with TodoWrite → execute red/green/refactor → fan out to ports via subagents → conformance corpus stays green throughout.
5. **Push cadence:** each FR is its own PR-sized chunk. Land TS reference + metadata fixtures first (signal migrate-ts session), then codegen, then per-port fan-out commits.

---

## Task: FR-016 (lands first)

### Metadata / loader work
- 5 new `AttrSchema` entries on `sourceRdbAttrs` (`@table`, `@view`, `@materializedView`, `@proc`, `@function`), 1 new `SOURCE_ATTR_NAME` schema entry.
- Constants in `server/typescript/packages/metadata/src/persistence/source/source-constants.ts` per FR-016 §Decision Part 2.
- `PHYSICAL_NAME_ATTR_BY_KIND` map.
- Four-step physical-name resolution in the loader (`server/typescript/packages/metadata/src/loader/`).
- Loader errors `ERR_PHYSICAL_NAME_KIND_MISMATCH`, `ERR_PHYSICAL_NAME_MULTIPLE`, `WARN_LEGACY_PHYSICAL_NAME_ALIAS`.
- Canonical-serializer rewrite: input `@kind: "storedProc"` + `@table` → output `@proc`.

### Conformance fixtures
9 fixtures under `fixtures/conformance/` — 6 positive + 3 error. See FR-016 §Conformance fixtures.

### Generator-stack sweep (NOT in FR-016 — open work)
Every generator that today reads `source.@table` to determine the physical name must call a single helper `getPhysicalName(source)` returning the per-kind value. Files to touch (TS reference):

- `server/typescript/packages/codegen-ts/src/generators/entityFile.ts` — Drizzle `pgTable("name", …)` emission.
- `server/typescript/packages/codegen-ts/src/generators/queriesFile.ts` — Kysely / Drizzle query helpers.
- `server/typescript/packages/codegen-ts/src/generators/routesFile.ts` — Fastify route paths derive from physical name in some cases.
- `server/typescript/packages/runtime-ts/src/drizzle-fastify/*.ts` — runtime query helpers.

> The corresponding `migrate-ts/src/expected-schema.ts` rewrite is **on the sister plan**, not here.

**Sweep recipe:** `grep -rn 'SOURCE_ATTR_TABLE\|"@table"\|source\.table\b' server/typescript/packages/ --include='*.ts'` → migrate each call site to the helper.

### Per-port fan-out
Java / Kotlin / C# / Python: register the same 5 attr aliases; mirror canonical-serializer output; sweep their generators for `@table`-hardcoding equivalent to the TS sweep. Per FR-016, ~half day per port.

### Done when (this session)
- TS reference green against the 9 new fixtures.
- `WARN_LEGACY_PHYSICAL_NAME_ALIAS` fires on legacy `@table` for non-table kind.
- Every existing rdb-source conformance fixture canonical-output uses the per-kind attr key matching `@kind`.
- All four other ports run the 9 fixtures byte-identically.
- **Signal the migrate-ts session that FR-016 metadata is on `main` so they can start their slice.**

---

## Task: FR-013 (fan out after FR-016)

### Metadata / loader work (specified in FR-013)
- `FIELD_ATTR_READ_ONLY = "readOnly"` constant + schema entry on `commonFieldAttrs` in `server/typescript/packages/metadata/src/core/field/`.
- Cross-attr validation: `ERR_READONLY_ASSIGNED_PRIMARY`, `ERR_READONLY_DOWNGRADE`.
- `WARN_READONLY_VALUE_OBJECT` for `@readOnly` on `object.value` field children.
- Effective-tree rule: max-restrictive read-only-ness wins (source's `SOURCE_READ_ONLY_KINDS` cascades down).

### Conformance fixtures (specified in FR-013)
6 fixtures — 4 positive + 2 error. See FR-013 §Conformance fixtures.

### Per-port ORM emission (specified in FR-013)
TS Drizzle, Java JPA, Kotlin Exposed, C# EF Core, Python SQLAlchemy. See FR-013 §Per-port codegen mapping.

### Generator-stack gaps (NOT in FR-013 — open work)
The FR's per-port table covers the entity/ORM emission. These generators also need updating:

- **`server/typescript/packages/codegen-ts/src/generators/routesFile.ts`** — generated POST/PATCH route handlers must reject `@readOnly` fields in request bodies. Two acceptable contracts: (a) silently strip; (b) 400 with `ERR_READONLY_FIELD_ON_WRITE`. **Decision point:** plan-author picks (b) for strictness; document the choice in the implementation-plan PR description.
- **`server/typescript/packages/codegen-ts/src/generators/entityFile.ts`** — Zod variants: existing entity file emits one `Schema` + one `CreateSchema` + one `UpdateSchema`. Add an `.omit({...readOnlyFields})` step to the create/update variants. The read schema retains all fields.
- **`server/typescript/packages/codegen-ts-react/src/generators/formFile.ts`** — generated forms skip `@readOnly` fields in create-mode and render them as `disabled` in edit-mode (read-only display).
- **`server/typescript/packages/codegen-ts-tanstack/src/generators/tanstackGrid.ts`** — no code change; grids can display readOnly fields. Add a fixture proving it.
- **`server/java/codegen-spring/`** — `PayloadGenerator` excludes `@readOnly` fields from the create/update record DTOs (Java `record` shape). `ControllerGenerator` accepts the trimmed DTO. `RepositoryGenerator` no change.
- **`server/java/codegen-spring/`** — filter-allowlist generator no change (filter is a read concern).
- **`fixtures/api-contract-conformance/`** — add a scenario: POST with a readOnly field in the body returns 400. Cross-port byte-equivalent.

> FR-013 has **no migrate-ts work** (the FR explicitly states "no DDL emission"). The optional `WARN_READONLY_NO_GENERATOR` in `migrate-ts verify` is listed on the sister plan as "defer/skip."

### Per-port fan-out
After TS reference + ORM-emission per port, run the conformance corpus on each port. ~1 day per port per FR-013's estimate, parallel.

### Done when (this session)
- TS reference green against 6 fixtures.
- API-contract conformance scenario (POST with readOnly field) green across all 5 ports.
- Generated forms in `client/web/packages/react` skip / disable readOnly fields (snapshot test).

---

## Task: FR-015 (fan out after FR-016)

### Metadata / loader work (specified in FR-015)
- `SOURCE_ATTR_PARAMETER_REF = "parameterRef"` constant + schema entry on `sourceRdbAttrs`.
- Loader errors: `ERR_PARAMETER_REF_REQUIRED_FOR_CALLABLE`, `ERR_PARAMETER_REF_UNRESOLVED`, `ERR_PARAMETER_REF_NOT_VALUE_OBJECT`, `ERR_PARAMETER_REF_ON_NON_CALLABLE_KIND`, `ERR_PARAMETER_REF_PASSTHROUGH_TYPE_MISMATCH`.
- Resolution: bare name OR FQN; reuses standard reference-resolution.

### Conformance fixtures (specified in FR-015)
10 fixtures — 6 positive + 4 error. See FR-015 §Conformance fixtures. Examples in FR-015 already use the FR-016 spellings (`@proc`/`@function`) — depends on FR-016 landing first.

### Per-port repo emission (specified in FR-015)
TS Drizzle wrapper, Java Spring `@Query`, Kotlin Exposed transaction, C# EF Core `FromSqlInterpolated`, Python SQLAlchemy `text(...)`. See FR-015 §Per-port codegen mapping.

> The `pg_proc` introspection + signature drift + `CREATE OR REPLACE FUNCTION` skeleton emit are on the sister plan, not here.

### Generator-stack gaps (NOT in FR-015 — open work)
The FR specifies how the **calling code** emits. It does NOT specify whether stored procs are exposed as REST endpoints. **Decision required before implementation:**

- **Default:** callable sources (`@kind: "storedProc" | "tableFunction"`) generate internal repo methods only, no REST route.
- **Opt-in:** an additive attribute `@exposeAsRoute: true` on `source.rdb` causes `routesFile` to emit a `POST /procs/<EntityName>` (or whatever path the project's `apiPrefix` + naming convention dictates) accepting the `@parameterRef` value-object as the request body, returning the projection array.
- **Generator surfaces gated by `@exposeAsRoute: true`** (when set):
  - `server/typescript/packages/codegen-ts/src/generators/routesFile.ts` — Fastify POST handler.
  - `server/typescript/packages/codegen-ts-tanstack/src/generators/tanstackQuery.ts` — `useGetPhaseSummaryPerCase(args)` hook (a `useQuery` wrapping the POST since the args are a body).
  - `server/typescript/packages/codegen-ts/src/generators/entityFile.ts` — Zod schema for the parameter value-object (already covered by the value-object's existing codegen path — should be no-op).
  - `server/java/codegen-spring/ControllerGenerator.java` — Spring `@PostMapping` analog.
  - C# / Kotlin / Python equivalents.

If the next Claude session prefers a simpler default (no `@exposeAsRoute`; expose only as internal methods), document that and skip the REST-side generator work. The FR is silent so either is consistent with shipped design.

### Filter / sort on callable result sets
Procs typically don't accept arbitrary filter/sort. **Default:** no filter / sort allowlist generated for callable sources. Document the choice.

### Per-port fan-out
After TS reference + REST decision, port the attr-registration + repo-emission per port. ~1 day per port per FR-015's estimate, parallel.

### Done when (this session)
- TS reference green against 10 fixtures.
- `@exposeAsRoute` decision documented in the implementation-plan PR.
- All 5 ports' generated repo helpers callable in the persistence-conformance corpus.

---

## Task: FR-014 + FR-017 (write FR-017 first, then implement)

### Step 1: Write FR-017 — "TPH polymorphic codegen across the generator stack"

**Path:** `docs/superpowers/specs/2026-MM-DD-fr-017-tph-polymorphic-codegen-design.md`.

FR-014 covers the metamodel + ORM-layer emission. FR-017 covers everything else — the generator surfaces that surround a polymorphic entity. The next session writes FR-017 covering:

- **Discriminated TS union types.** `entityFile` emits `type Auth = BridgeAuth | CopayAuth | PriorAuthAuth | QuickStartAuth | UnknownAuth` as a tagged-union keyed by the discriminator field.
- **Per-subtype Zod schemas.** `entityFile` emits `BridgeAuthSchema`, `CopayAuthSchema`, etc., each `.merge(BaseAuthSchema)`. The TS reference + runtime `parse(json)` dispatch on the discriminator value.
- **Polymorphic queries.** `queriesFile` always projects the discriminator column on `findAll/findById` for a discriminated base; row → subtype constructor dispatch.
- **REST contract decisions** (and the design must MAKE these decisions, not punt):
  - `GET /auths` returns polymorphic rows tagged with the discriminator → `@type` field.
  - `POST /auths` — choose: (a) removed in favor of per-subtype `POST /bridge-auths`, `POST /copay-auths`; (b) accepts a discriminated body with `type: "Bridge"` keying the validation branch.
- **TanStack hooks.** `useAuths()` returns the union. Per-subtype hooks `useBridgeAuths()` filter on discriminator. Per-subtype mutations `useCreateBridgeAuth()`, etc.
- **TanStack grid.** Decide: single polymorphic grid with mixed rows + a `@type` column, OR per-subtype grids? Specify.
- **React forms.** Per-subtype `<BridgeAuthForm>`, `<CopayAuthForm>` etc. (you can't create an abstract `Auth`).
- **Filter allowlists.** Per-subtype filter allowlist auto-includes the discriminator field, pinned to that subtype's value.
- **Spring (Java) generator stack.** `EntityGenerator` (JPA `@Inheritance`), `PayloadGenerator` (per-subtype request DTOs), `ControllerGenerator` (polymorphic GET + per-subtype POST), `RepositoryGenerator` (Spring Data repo on the base; per-subtype repos optional), filter-allowlist generator per subtype.
- **Kotlin generator stack.** Sealed class hierarchy in `EntityGenerator`; per-subtype `ControllerGenerator`, `PayloadGenerator`, `FilterAllowlistGenerator`.
- **C# generator stack.** EF `HasDiscriminator` in entity gen; per-subtype DTO + controller.
- **Python generator stack.** SQLAlchemy polymorphic config + per-subtype Pydantic + per-subtype FastAPI route.
- **API-contract conformance.** Polymorphic CRUD scenarios — cross-port byte-equivalent.

> FR-014's migrate-ts piece (TPH DDL emit + drift detection) is on the sister plan. **This session and the migrate-ts session both depend on the FR-014 metadata commit landing first.** Once it does, they execute in parallel — disjoint package directories.

### Step 2: Implementation order

Per FR-014:
1. TS reference: metamodel + 9 conformance fixtures (this session).
2. TS reference: FR-017 generator-stack work (~1+ week — the polymorphic generator surface is large).
3. Per-port fan-out: TS metamodel + generator-stack per port (Java largest because of Spring controller / DTO / repo / payload generator interplay).

### Done when (this session)
- FR-017 spec doc landed.
- FR-014's 9 metamodel fixtures green.
- FR-017's API-contract conformance scenarios green across 5 ports.
- An adopter project (a C# CRM adopter is the driver) can model its workflow-task / authorization / payment polymorphism in metadata and codegen produces working CRUD.

---

## Cross-cutting concerns

### Conformance corpus is the gate
Every metamodel addition gets a fixture under `fixtures/conformance/` BEFORE any port implements. The fixture-first rule is the only thing that guarantees cross-port byte-equivalence. Don't skip.

### Constants colocation (ADR-0003)
All new constants live in the per-concern modules (`field-constants.ts` for FR-013, `source-constants.ts` for FR-015/016, `object-constants.ts` for FR-014). No central edits.

### Open-closed registration (ADR-0002 + ADR-0004)
Each new attr is one schema entry + one constants entry. No central registry edits. If you find yourself touching a central switch / dispatch / list, stop and re-read ADR-0002 / ADR-0004.

### Naming convention discipline (CLAUDE.md "Coding discipline (TS)")
No inline `"@table"` / `"readOnly"` / `"discriminator"` string literals in code. Always the named constants. Compile-time typo safety.

### Per-port subagent fan-out
Once TS reference lands for an FR, the per-port work is independent. Use the subagent-driven-development skill: spawn one subagent per port, each branches off `main`, each runs the conformance corpus, each merges back to `main` independently. Don't serialize.

### Public-repo hygiene (CLAUDE.md "Public repository hygiene")
Before every commit: scan the diff for absolute home paths and other-project names. The pre-commit hook enforces; don't bypass.

---

## Done criteria for this workstream

- All 4 FRs' metadata layers implemented across all 5 ports.
- All 4 FRs' codegen layers implemented (TS reference + per-port fan-out).
- FR-017 spec written + implemented.
- Cross-port conformance corpus (metamodel + render + api-contract) green.
- Each FR's status updated from *Design* → *Implemented* (the migrate-ts portion may still be in flight on the sister plan; mark the codegen-side as done independently).

The whole batch is done when this plan AND the sister migrate-ts plan are both green.

---

## Reference

- [ADR-0002 — Open-closed typed nodes](../../../spec/decisions/ADR-0002-open-closed-typed-nodes.md)
- [ADR-0003 — Metamodel constants colocation](../../../spec/decisions/ADR-0003-metamodel-constants-colocation.md)
- [ADR-0004 — Provider-based type registration](../../../spec/decisions/ADR-0004-provider-based-type-registration.md)
- [ADR-0007 — Source v2 paradigm subtypes + multi-source](../../../spec/decisions/ADR-0007-source-v2-paradigm-subtypes-multisource.md)
- [ADR-0013 — Logical field types vs physical column attrs](../../../spec/decisions/ADR-0013-logical-field-types-vs-physical-column-attributes.md)
- [ADR-0015 — TS-only schema migration](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md)
- [ADR-0018 — Per-kind physical-name attrs](../../../spec/decisions/ADR-0018-per-kind-physical-name-attrs.md)
- CLAUDE.md — repo-wide design discipline (read first if you've never worked in this codebase).
- Conformance corpus README at `fixtures/conformance/README.md`.
