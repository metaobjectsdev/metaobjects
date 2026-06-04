# Metamodel Batch (FR-013/014/015/016 + ADR-0018) — `migrate-ts` Workstream

> **For agentic workers:** REQUIRED SUB-SKILLS: `superpowers:test-driven-development` (every migrate-ts change is TDD-first against the persistence-conformance migration scenarios), `superpowers:brainstorming` (only if a design ambiguity surfaces — the FRs already cover most of it).
>
> **Gate:** new migrate-ts emit/diff behavior is verified by **integration tests against a real Postgres** (the migrate-ts pattern — never a mock) AND by green `fixtures/persistence-conformance/` migration scenarios. The TS reference owns schema migration per ADR-0015; no other port needs to fan out.

**Status:** Plan (ready for execution on a separate session/machine).
**Created:** 2026-05-31.
**Sister plan:** [metadata + codegen workstream](2026-05-31-metamodel-batch-metadata-codegen-plan.md) — runs in parallel on a separate session. **The coordination contract is "metadata lands first per FR";** see [Coordination contract](#coordination-contract) below.

---

> ## 🆕 2026-06-03 HANDOFF — FR-017 Tier 4 per-port fan-out (Java / Kotlin / Python) — DO THIS HERE
>
> **Why this is in this doc:** this is the "other machine" workstream. FR-017 TPH
> (table-per-hierarchy polymorphic codegen) is fully landed in the **TypeScript
> reference** + both **cross-port conformance corpora** are authored and TS-green.
> The remaining work is the **per-port fan-out**, split by machine:
> - **C# is being done on the primary machine** (in progress there — do NOT start C# here).
> - **THIS session/machine: do Java, Kotlin, and Python.**
>
> **What's already shipped (read first):**
> - Design + status: [FR-017 spec](../specs/2026-06-02-fr-017-tph-polymorphic-codegen-design.md) → see the **Realization status** section (Tier-4 TS foundations + Tier-5 corpora).
> - **The oracle (do not modify — make each port match it):**
>   - api-contract: `fixtures/api-contract-conformance/tph/` (Auth base + BridgeAuth/CopayAuth/PriorAuthAuth, 4 scenarios, both lanes).
>   - persistence: `fixtures/persistence-conformance/queries/tph-*.yaml` (4 scenarios) + `Auth`/subtypes in `canonical/meta.fitness.json` + the committed `canonical/schema.postgres.sql` (single `auths` table). The query DSL gained `create`/`update` ops + an `expectError` flag — each port's persistence runner must implement these.
> - **migrate-ts TPH single-table EMISSION (Task C.1 + C.2 below) is DONE** — `expected-schema.ts` now folds subtype-only columns (nullable) into the single base table and skips subtype tables; the canonical `schema.postgres.sql` is regenerated + drift-checked green. The verify-time **drift rules (C.3/C.4 — `WARN_DISCRIMINATOR_VALUE_UNKNOWN` etc.) remain open** in this plan. Schema is TS-owned per ADR-0015, so **no per-port schema work** — every port executes the committed `schema.postgres.sql`.
> - **TS reference to mirror** (per the cross-language-porting skill — mirror, don't re-derive): `server/typescript/packages/codegen-ts/src/templates/{tph-discriminator,drizzle-schema,routes-file}.ts`, `runtime-ts/src/drizzle-fastify/index.ts` (the `discriminator: {column,value}` option), and `runtime-ts/src/{tph.ts,object-manager.ts}` (effective-children resolution + discriminator inject/scope/strip — the runtime-layer reference).
>
> **Per-port work (each of Java / Kotlin / Python), ~1 week each, parallel-friendly:**
> 1. **Codegen TPH** in the port's idiom (FR-017 §"Per-port idiom table"): JPA `@Inheritance(SINGLE_TABLE)`+`@DiscriminatorColumn`/`@DiscriminatorValue` (Java `codegen-spring`); Kotlin sealed classes + Exposed (`codegen-kotlin`); SQLAlchemy `polymorphic_on` + Pydantic + FastAPI (Python). Single-table storage; per-subtype routes at `/<base>/<discriminatorValue lowercased>`.
> 2. **Runtime/data-access TPH** so the port passes the `tph-*` persistence scenarios (inherited fields/identity/single-table resolution + discriminator inject/scope/strip + the new `create`/`update`/`expectError` DSL ops in the port's persistence-conformance runner). NB: Java/Kotlin/Python persistence-conformance runs the **generated** controller + a consumer-supplied repo seam per the api-contract README — confirm how each port's query runner executes writes.
> 3. **Conformance, both corpora:** make the port green against `api-contract-conformance/tph/` (reference lane + GENERATED artifact over HTTP) and `persistence-conformance/queries/tph-*.yaml`. Until a port's slice lands it **skips** `tph-*` (the m2n-* convention) — do not delete fixtures.
>
> **Cross-port invariants (byte-identical):** single `auths` table, subtype cols nullable; `GET /auths` polymorphic union + `GET|POST|PATCH|DELETE /auths/{bridge|copay|priorauth}` per subtype (segment = `@discriminatorValue` lowercased); discriminator injected from the URL on create (never the body); cross-subtype get/delete → 404; response always carries the discriminator field by value.
>
> Use `superpowers:subagent-driven-development` to fan the three ports out. Each is gated by the corpus (the oracle), TDD-first.

---

**Scope of this plan:** the `migrate-ts` slices across the four FRs. Three FRs contribute migrate-ts work; one (FR-013) has none.

| FR | migrate-ts work | Size |
|---|---|---|
| [FR-013 — `@readOnly`](../specs/2026-05-28-fr-013-field-read-only-design.md) | **None** required. Optional `WARN_READONLY_NO_GENERATOR` in `migrate-ts verify` — defer or skip. | n/a |
| [FR-016 — `source.rdb` name + per-kind aliases](../specs/2026-05-28-fr-016-source-rdb-name-and-kind-aliases-design.md) | `expected-schema.ts` physical-name resolution rewrite | Small (~half day) |
| [FR-015 — `@parameterRef`](../specs/2026-05-28-fr-015-source-parameter-ref-design.md) | `pg_proc` introspection + signature drift detection + `CREATE OR REPLACE FUNCTION` skeleton emit for new procs | Medium (~2-3 days) |
| [FR-014 — TPH discriminator](../specs/2026-05-28-fr-014-tph-discriminator-design.md) | TPH detection in `expected-schema.ts` + single `CREATE TABLE` for the base + nullable subtype-field columns + discriminator-column type derivation + drift detection | Largest (~3-5 days) |

The metadata layer (constants, attr schemas, loader validation, canonical serializer) and the per-port codegen are owned by the sister plan and out of scope here.

---

## Coordination contract

The sister [metadata + codegen plan](2026-05-31-metamodel-batch-metadata-codegen-plan.md) runs in parallel. Coordination rules:

1. **Metadata lands first per FR.** The sister session pushes the metadata commit (constants + schemas + loader validation + canonical serializer + metamodel conformance fixtures) for FR-N to `main` BEFORE this session starts FR-N migrate-ts work. Without the new attrs registered on the loader, `migrate-ts` has nothing to consume.
2. **Pull `main` before every task start.** The sister session may push the metadata commit any time; refresh before reading the loaded model.
3. **Preflight check per FR** (see per-task sections below). If the preflight fails (the expected attr / constant isn't on `main` yet), wait or message the user.
4. **Disjoint package directories.** This session touches `server/typescript/packages/migrate-ts/` only. The sister session does not touch this directory. No code-file overlap.
5. **Shared resources** that need coordination:
   - `fixtures/conformance/` — sister session owns it; this session reads but does not modify.
   - `fixtures/persistence-conformance/` — both sessions add fixtures: sister session adds query scenarios for new metadata; this session adds migration scenarios for new DDL emission. Disjoint subdirectories. No conflict.
6. **No need for cross-port fan-out** on the migrate-ts side. ADR-0015 — TS owns schema migration. Java / Kotlin / C# / Python `migrate` engines don't exist anymore (removed in OMDB migration-subsystem removal). This plan is **TS-only**.

---

## Recommended workflow for this session

1. **Pull latest** every time you start. The sister session pushes metadata commits to `main` independently.
2. **Read the four spec docs in this order:** ADR-0018, FR-016, FR-015, FR-014. (Skip FR-013 — no work here.) For each, scan its §`migrate-ts` impact section — that's your design source.
3. **Per-FR rhythm:**
   - Preflight: confirm the sister session's metadata commit for this FR is on `main` (grep for the new constant in `packages/metadata/src/`).
   - TDD against a real Postgres in `server/typescript/packages/migrate-ts/test/integration/`.
   - Add or update `fixtures/persistence-conformance/<scenario>/` migration scenarios.
   - Push when green.
4. **Push cadence:** each FR's migrate-ts slice is its own PR-sized chunk. No need to bundle them.
5. **Work order recommendation:** FR-016 → FR-015 → FR-014. FR-016 is smallest and the resolution rewrite is the foundation other migrate-ts code reads. FR-014 last because the largest and benefits from the other two being shaken out first.

---

## Task A: FR-016 — physical-name resolution rewrite in `migrate-ts`

### Preflight
- [ ] `grep -r 'PHYSICAL_NAME_ATTR_BY_KIND' server/typescript/packages/metadata/src/` returns matches. (Indicates sister session's FR-016 metadata is on `main`.)
- [ ] `bun install` clean.

### Work
The current `migrate-ts/src/expected-schema.ts` defaults a source's physical name from the **owning entity's name**. FR-016 §"Physical-name resolution rule (revised)" defines a four-step rule:

1. Explicit kind-matching alias (`@table` / `@view` / `@materializedView` / `@proc` / `@function`) matching `@kind`.
2. Legacy `@table` for non-table kind (pre-1.0) — accept + the loader emits `WARN_LEGACY_PHYSICAL_NAME_ALIAS`.
3. Derive from `source.@name` via the project's `columnNamingStrategy`.
4. Fall back to the owning entity's name via the same naming strategy.

Rewrite `expected-schema.ts` to use this four-step rule. The result is a single `getPhysicalName(source)` helper (or equivalent) that the rest of migrate-ts consumes.

> The sister session also needs a `getPhysicalName` helper for codegen. If it ships one in `packages/metadata` or `packages/codegen-ts`, **reuse it** rather than duplicating. If migrate-ts needs its own version (because it operates on the introspected DB model too), keep them aligned in the FR-016 PR review.

### Tests
- Unit tests in `server/typescript/packages/migrate-ts/test/` covering all four steps of the resolution rule + the precedence between them.
- Integration tests against a real Postgres confirming DDL emit picks the correct physical name regardless of which alias was set on input.

### Done when
- All four resolution steps covered by tests.
- Existing migrate-ts fixtures that use `@table` continue to behave identically (step 1 matches).
- Legacy `@table` with non-table `@kind` produces a working migration with `WARN_LEGACY_PHYSICAL_NAME_ALIAS` surfaced.
- `bun test` in `server/typescript/packages/migrate-ts/` green.

---

## Task B: FR-015 — `pg_proc` introspection + skeleton emit

### Preflight
- [ ] `grep -r 'SOURCE_ATTR_PARAMETER_REF' server/typescript/packages/metadata/src/` returns matches.
- [ ] Task A complete (FR-016 resolution rewrite landed; `@proc`/`@function` are first-class physical-name keys).

### Work
Two pieces, per FR-015 §`migrate-ts` impact:

#### B.1 — Signature validation against the live DB
Introspect the function signature from Postgres `pg_proc`:
```sql
SELECT proname, proargtypes, prorettype, proargnames, proargmodes, ...
FROM pg_proc
WHERE proname = ... AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = '<schema>');
```
Compare the live signature against the metadata's `@parameterRef` value-object + the entity's return fields. Drift surfaces as `ERR_DRIFT_PARAMETER_*` codes during `migrate-ts verify` (per-arg: added / removed / retyped / renamed / required-mismatch).

#### B.2 — Skeleton emit for new procs
For a stored proc / table function declared in metadata for the first time (live DB doesn't have the function yet), emit:
```sql
CREATE OR REPLACE FUNCTION <schema>.<proc_name>(
  <param_name> <param_type>,
  ...
) RETURNS TABLE (
  <return_field> <return_type>,
  ...
) AS $$
BEGIN
  RAISE NOTICE 'unimplemented';
END;
$$ LANGUAGE plpgsql;
```
The user fills in the body. Same pattern migrate-ts already uses for view bodies.

### Tests
- Integration test against a real Postgres: declare a proc in metadata, run `migrate-ts emit`, apply the migration, confirm the function exists with the correct signature.
- Drift test: alter the live proc's signature, run `migrate-ts verify`, confirm the right `ERR_DRIFT_PARAMETER_*` code surfaces.
- Fixture under `fixtures/persistence-conformance/` for the proc-creation migration scenario.

### Done when
- Signature drift detected accurately across all arg-shape mutations.
- Skeleton emit produces a valid `CREATE OR REPLACE FUNCTION` for a new proc.
- Persistence-conformance migration scenario green.

---

## Task C: FR-014 — TPH DDL emit + drift

### Preflight
- [ ] `grep -r 'OBJECT_ATTR_DISCRIMINATOR\b' server/typescript/packages/metadata/src/` returns matches.
- [ ] `grep -r 'OBJECT_ATTR_DISCRIMINATOR_VALUE' server/typescript/packages/metadata/src/` returns matches.
- [ ] Task A complete.

### Work
Per FR-014 §`migrate-ts` impact:

#### C.1 — TPH detection in `expected-schema.ts`
Recognize a TPH root by: an `object.entity` carrying `@discriminator` + at least one entity `extends:`-ing it with `@discriminatorValue`. Build the expected-schema view of a TPH root as a single table with the **union of base + all-subtype columns**, with subtype-only columns marked **nullable**.

#### C.2 — Single `CREATE TABLE` for the base
Emit one `CREATE TABLE` for the discriminated base. Include:
- All base fields as columns (nullability per their own `@required`).
- All subtype-only fields as columns, **automatically nullable** (TPH rule — a row that's a `Bridge` won't have `Copay`'s columns populated).
- The discriminator column with the right type derived from the named field's subtype:
  - `field.enum` → `varchar` with `CHECK` constraint enumerating all subtype values.
  - `field.int` → `integer`.
  - `field.string` → `varchar`.
- Indexes / FKs per the usual rules (e.g., FK on every subtype-relationship column).

#### C.3 — Drift detection rules
- Subtypes' fields appearing as columns on the base table — **expected**.
- A subtype declared but its fields missing from the actual table — **flagged**.
- The discriminator column missing or having a mismatched type — **flagged**.
- Discriminator values present in actual rows that aren't declared by any subtype — surfaced as `WARN_DISCRIMINATOR_VALUE_UNKNOWN` during `verify` (not a `migrate emit` blocker).

#### C.4 — Introspection caveat
Reading the live DB recovers the column set but **not** the discriminator semantic (which column IS the discriminator). The discriminator-column identity itself is metadata-declared, not introspected. The expected-schema build uses the metadata declaration as the source of truth and compares the introspected column SET against it; the discriminator-IS-this-column claim is not introspected.

### Tests
- Integration test against a real Postgres: declare a 3-subtype TPH hierarchy in metadata, run `migrate-ts emit`, apply, confirm the single base table has all union columns + the discriminator column with the right type.
- Drift test: drop a subtype column from the live table, run `verify`, confirm the right drift code.
- Drift test: insert a row with an undeclared discriminator value, run `verify`, confirm `WARN_DISCRIMINATOR_VALUE_UNKNOWN`.
- Fixture under `fixtures/persistence-conformance/` for the TPH migration scenario (matches the sister session's metamodel + persistence query fixtures).

### Done when
- TPH `CREATE TABLE` emit correctly nullable for subtype-only columns.
- Discriminator-column type derives correctly from each of `field.enum` / `field.int` / `field.string`.
- All four drift cases (subtype-field-missing, discriminator-column-missing, discriminator-column-type-mismatch, unknown-discriminator-value) detected.
- Persistence-conformance TPH migration scenario green.

---

## Optional follow-up: FR-013 `WARN_READONLY_NO_GENERATOR`

Per FR-013 §`migrate-ts` impact: an optional `verify`-time warning when a column declared `@readOnly: true` has neither a `GENERATED ALWAYS` clause, nor a `DEFAULT` expression, nor a documented external owner. Quality-of-life check, not load-time. **Defer until the rest of the batch is done; only implement if there's spare time / a real adopter ask.**

---

## Cross-cutting concerns

### Integration-tests-against-real-Postgres rule
`migrate-ts` uses Testcontainers Postgres in integration tests. Never mock the database — the whole point of this layer is bytes-on-disk correctness. The CLAUDE.md feedback memory may apply ("integration tests must hit a real database, not mocks").

### `expected-schema.ts` is the contract surface
All four tasks here either read from or write to `migrate-ts/src/expected-schema.ts`. Treat it as the single point of truth for "what schema does metadata expect" — both `emit` (forward) and `verify` (compare against live DB introspection) drive off it.

### ADR-0015 — TS-only schema migration
This plan is TS-only. No Java / Kotlin / C# / Python fan-out for migrate-ts work. The OMDB migration subsystem was removed; cross-port `meta migrate` doesn't exist anymore. Only TS migrate-ts ships.

### Public-repo hygiene (CLAUDE.md "Public repository hygiene")
Before every commit: scan the diff for absolute home paths and other-project names. The pre-commit hook enforces; don't bypass.

---

## Done criteria for this workstream

- Task A (FR-016 resolution rewrite) green.
- Task B (FR-015 `pg_proc` introspect + skeleton emit) green.
- Task C (FR-014 TPH DDL + drift) green.
- All new persistence-conformance migration scenarios green against Testcontainers Postgres.
- The optional FR-013 `WARN_READONLY_NO_GENERATOR` either implemented or explicitly deferred.

The whole batch is done when this plan AND the sister metadata-codegen plan are both green.

---

## Reference

- [ADR-0015 — TS-only schema migration](../../../spec/decisions/ADR-0015-single-shared-migrate-engine.md)
- [ADR-0018 — Per-kind physical-name attrs](../../../spec/decisions/ADR-0018-per-kind-physical-name-attrs.md)
- FR design docs: [FR-013](../specs/2026-05-28-fr-013-field-read-only-design.md), [FR-014](../specs/2026-05-28-fr-014-tph-discriminator-design.md), [FR-015](../specs/2026-05-28-fr-015-source-parameter-ref-design.md), [FR-016](../specs/2026-05-28-fr-016-source-rdb-name-and-kind-aliases-design.md).
- CLAUDE.md — repo-wide design discipline (read first if you've never worked in this codebase).
- `migrate-ts` package at `server/typescript/packages/migrate-ts/`.
