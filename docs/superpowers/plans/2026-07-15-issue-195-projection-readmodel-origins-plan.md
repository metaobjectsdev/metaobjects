# Issue #195 — Projection read-model origins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax. **TS-first, then fork-per-port** for cross-port propagation (the Program-D pattern): the orchestrator independently re-runs each gate, runs code-review + code-simplifier per unit, and commits. Do not trust a fork's "green" — re-run it yourself.

**Goal:** Add four projection read-model origin capabilities — `origin.aggregate @agg: any|all` (predicate quantifier), `@agg: collect` (array rollup), new `origin.computed @expr` (structured expression tree), new `origin.first` (pick-one-related-row-by-ordering) — defined semantically and lowered by every backend, so monitoring/admin views become metadata-managed + drift-gated instead of hand-written unmanaged SQL.

**Architecture:** Each origin is a pure `rows → value` derivation (§2 of the spec). The **vocabulary + validation + native typing** register in all 5 ports (registry-conformance); the **view-DDL synthesis is TS-only** (ADR-0015). `origin.computed`'s expression is a new closed `attr.expression` node grammar that shares the filter AST's operator vocabulary and is filter-embeddable (one cross-port eval engine). Build TS-first (constants + loader + validation + synthesis + conformance), then propagate the vocab + validation + typing to C#/Python/Java/Kotlin.

**Tech Stack:** metamodel canonical spec (`spec/metamodel/*.json`) + per-port embeds; TS `@metaobjectsdev/metadata` (loader/validation) + `migrate-ts` (view synthesis, TS-only); C#/Python committed spec copies + Java auto-refresh + Kotlin; registry-conformance (`fixtures/registry-conformance/`).

**Authoritative design:** `docs/superpowers/specs/2026-07-15-issue-195-projection-readmodel-origins-design.md` — §§ are authoritative on semantics + pinned behavior. This plan operationalizes it.

## Global Constraints

- **Named constants** for all metamodel strings (subtypes, attr names, `@agg` values, ops, error codes) — TS `packages/metadata/src/**/*-constants.ts` first, then parallel per port. No `any` in TS (use `unknown` + narrow). ESM only.
- **Cross-port byte-identical vocabulary** — every new type/subtype/attr registers in all 5 ports' registries; the `registry-conformance` gate (`fixtures/registry-conformance/expected-registry.json` byte-match) is the structural enforcer. The canonical spec (`spec/metamodel/*.json`) is the source of truth: after editing it, **regenerate the TS embedded copy AND sync the committed C# + Python copies** (`server/csharp/MetaObjects/SpecMetamodel/*.json`, `server/python/src/metaobjects/spec_metamodel/*.json`) — Java auto-refreshes from `spec/`. Forgetting a copy = silent per-port conformance fail (a known trap).
- **Schema/view synthesis is TS-only** (ADR-0015) — the migrate-ts view builder. C#/Python/Java/Kotlin do NOT synthesize DDL; they register + validate the vocab and TYPE the projection field natively.
- **Determinism pins are load-bearing** (the conformance corpora byte-compare, the view fingerprint must be stable): empty-set values (`any=false`, `all=true`, `collect=[]`, `first=null`), primary-key tie-break on `first`, nulls-last on `@orderBy`, value-ascending default element order on `collect`, and the LEFT-JOIN phantom-row guard on every aggregate lowering. Encode each in a conformance fixture's zero-related-rows case.
- **ADR-0037 / ADR-0023** — the vocab was decided against the behavior test (spec §3); every attr comes from a registered provider (no invented attrs). **ADR-0039** — use resolving/effective accessors for field/attr reads.
- **TDD** — write the failing test first for every validation rule + synthesis output. **Migrate gate:** always pass `dialect` to `diff()`; a view-synthesis change must `emit → apply to a real engine → introspect → re-diff EMPTY` (the migrate idempotence + value-semantics gate).
- **Commit author** `Doug Mealing <doug@dougmealing.com>`; end messages with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` + `Claude-Session: <url>`. **PUBLIC repo** — no private names / no `/home/...` paths in any committed file incl. commit messages. Commit directly to `main` (forward-only); push for durability.
- **Naming:** `origin.computed` (NOT `origin.expression`); `@agg: collect` (NOT `arrayAgg`); `origin.first` (NOT `origin.latest`).

## Running tests

```
cd server/typescript && bun test                       # server suite (scoped — never bare `bun test` at repo root)
cd server/typescript/packages/metadata && bun test     # loader/validation/registry unit tests
cd server/typescript/packages/migrate-ts && bun test   # view synthesis
bun run --filter '*' typecheck                          # whole workspace, from repo root
# cross-port (fork-run):
cd server/csharp && dotnet test MetaObjects.Tests --filter "FullyQualifiedName~Registry|Conformance"
cd server/python && .venv/bin/python -m pytest tests/conformance -q
cd server/java && mvn -q -pl metadata test
cd server/java && mvn -q -pl codegen-kotlin test
```

---

## File Structure

**Canonical vocab (source of truth):**
- Modify `spec/metamodel/origin.json` — extend `@agg` allowedValues; relax `@of`; add `@distinct`/`@orderBy`; new `origin.computed`, `origin.first`.
- Modify `spec/metamodel/attr.json` — new `attr.expression` (`dataType: object`).

**TS (`server/typescript/packages/`):**
- `metadata/src/**/*-constants.ts` — new subtype/attr/agg/op/error-code constants.
- `metadata/src/persistence/origin/` — `origin.computed` + `origin.first` metadata classes (mirror `meta-origin.ts` aggregate/passthrough).
- `metadata/src/**/meta-attr-expression.ts` (new) — the `attr.expression` MetaAttr class (mirror `meta-attr-filter.ts`): parse/coerce/validate/desugar the closed node grammar + `inferExprType()` + `filterToExpr()` embedding.
- `metadata/src/**/origin-definition.embedded.ts` — regenerated from canonical spec.
- `metadata/src/loader/validation-passes.ts` (+ origin/projection validation) — the new per-capability validation rules.
- `migrate-ts/src/**` — `view-spec.ts` (new SelectColumn kinds), `extract-view-spec.ts` (resolution), `view-ddl-emit.ts` (lowering).

**Cross-port:** committed spec copies (C#/Python), per-port origin classes + validation + payload/DTO typing (Java/Kotlin/C#/Python).

**Conformance:** `fixtures/registry-conformance/expected-registry.json` + new manifests; `fixtures/conformance/` origin fixtures per capability; `fixtures/persistence-conformance/` collect array wire roundtrip.

**Docs (end):** `CHANGELOG.md` (Unreleased), issue #159 (retire the `origin.expression` reservation note in `origin-constants.ts`), `spec/roadmap.md`.

---

## PHASE 0 — Shared primitives + vocab registration (TS-first)

### Task 0.1: Register `attr.expression` node grammar (TS)

**Files:** Create `server/typescript/packages/metadata/src/**/meta-attr-expression.ts` (place beside `meta-attr-filter.ts`); Modify `spec/metamodel/attr.json`, the attr constants, the provider registration; Test: a new `meta-attr-expression.test.ts`.

**Interfaces:**
- Produces: `ATTR_SUBTYPE_EXPRESSION` constant; an `attr.expression` MetaAttr that parses/validates the closed node grammar (spec §4bis); `inferExprType(node, entity): FieldSubType` (bottom-up type inference); `filterToExpr(filterAst): ExprNode` (embedding). Node kinds: `{field}`, `{value}`, `{op: eq|ne|gt|gte|lt|lte, left, right}`, `{op: isNull|isNotNull, arg}`, `{op: and|or, args}`, `{op: not, arg}`, `{fn: coalesce, args}`. Unknown kind → load error (`ERR_UNKNOWN_EXPR_NODE`).

- [ ] **Step 1: Study the model.** Read `meta-attr-filter.ts` in full (parse/coerce/validate/desugar `:19-40`, registration `:67`) + `query-constants.ts:20-64` (`FILTER_OPS`, `OPS_BY_SUBTYPE`). The expression op names + per-subtype legality bands MUST equal the filter's (one vocabulary).

- [ ] **Step 2: Write failing tests** (`meta-attr-expression.test.ts`): (a) `{op: isNotNull, arg: {field: payloadJson}}` parses + `inferExprType` → boolean; (b) unknown `{op: "regexp", …}` → `ERR_UNKNOWN_EXPR_NODE`; (c) `{op: gt, left: {field: score}, right: {value: 90}}` → boolean, and a type-illegal op (`gt` on a boolean field) rejected per `OPS_BY_SUBTYPE`; (d) `filterToExpr({success: false})` → `{op: eq, left: {field: success}, right: {value: false}}`; (e) `{fn: coalesce, args: [{field: a},{field: b}]}` infers the unified arg subtype. Run → FAIL.

- [ ] **Step 3: Implement** the MetaAttr class (mirror `meta-attr-filter.ts`) + `inferExprType` + `filterToExpr`; add `attr.expression` to `spec/metamodel/attr.json` (`{ "type": "attr", "subType": "expression", "dataType": "object", "description": "A structured expression tree over a base entity's own fields (closed node grammar: field/value refs, comparisons sharing the filter op vocabulary, isNull/isNotNull, and/or/not, coalesce). Backs origin.computed; a filter object embeds canonically. Additive node kinds (arithmetic/case/via-joined refs) are #159." }`); register the provider; add `ATTR_SUBTYPE_EXPRESSION` + `ERR_UNKNOWN_EXPR_NODE`/`ERR_COMPUTED_TYPE_MISMATCH` constants. Run tests → PASS.

- [ ] **Step 4: Commit** `feat(#195): attr.expression closed node grammar (TS) — shares filter op vocab, filter-embeddable`.

### Task 0.2: Register `@orderBy` + `@distinct` attrs (canonical + TS)

**Files:** Modify `spec/metamodel/origin.json`; regen `origin-definition.embedded.ts`; add attr-name constants.

- [ ] **Step 1:** Add to the `origin.aggregate` children: `{ "type": "attr", "subType": "boolean", "name": "distinct", "min": 0, "max": 1, "description": "Set (collect-only) to dedupe collected values (set semantics)." }` and `{ "type": "attr", "subType": "string", "name": "orderBy", "isArray": true, "min": 0, "max": 1, "description": "Ordering keys as 'field[:asc|desc]' (default asc) over the related entity's fields; nulls sort last. On @agg:collect sets element order (non-distinct); on origin.first (required) selects the row. Semantic — no SQL syntax." }`. (Declare `@orderBy` once as a shared attr shape; it appears on aggregate + first.)

- [ ] **Step 2:** Regenerate the TS embedded copy (find the regen script: `grep -rn "origin-definition.embedded" package.json server/typescript/packages/metadata` → run it) + add `ORIGIN_ATTR_ORDER_BY` / `ORIGIN_ATTR_DISTINCT` constants.

- [ ] **Step 3: Verify load** — a fixture using `@orderBy`/`@distinct` loads with no `ERR_UNKNOWN_ATTR`. Commit `feat(#195): @orderBy + @distinct origin attrs (canonical + TS)`.

### Task 0.3: Register the new `@agg` values + `origin.computed` + `origin.first` subtypes (canonical + TS)

**Files:** Modify `spec/metamodel/origin.json`; regen embedded; origin constants; `fixtures/registry-conformance/expected-registry.json`.

- [ ] **Step 1:** In `origin.aggregate`, change `@agg` `allowedValues` to `["count","sum","avg","min","max","any","all","collect"]` and relax `@of` `min` from 1 to 0 (presence is now per-`@agg`, enforced in validation). Add two subtypes:
  - `{ "type": "origin", "subType": "computed", "description": "A row-level value computed from the base entity's own fields via a structured expression tree (@expr). No related rows. Read-only.", "children": [ { "type": "attr", "subType": "expression", "name": "expr", "min": 1, "max": 1, "description": "The expression tree; its inferred type must equal the field's declared subType." } ] }`
  - `{ "type": "origin", "subType": "first", "description": "The single related row selected by @orderBy along @via, projecting @of. Latest = @orderBy desc. Read-only; empty related set → null.", "children": [ {of}, {via}, {orderBy min:1}, {filter} ] }` (reuse the `@of`/`@via`/`@filter` shapes from aggregate; `@orderBy` `min:1` here).

- [ ] **Step 2:** Regenerate embedded + add `ORIGIN_SUBTYPE_COMPUTED`/`ORIGIN_SUBTYPE_FIRST` + `AGG_ANY`/`AGG_ALL`/`AGG_COLLECT` constants. Update `expected-registry.json` (add the subtypes + attrs + agg values to the origin section). Run `cd server/typescript/packages/metadata && bun test` (registry-conformance TS slice) → the TS registry now matches. Commit `feat(#195): register @agg any/all/collect + origin.computed/first (canonical + TS)`.

---

## PHASE 1 — Validation (TS-first)

### Task 1.1: `@agg: any|all|collect` validation

**Files:** Modify the origin/projection validation pass (`grep -rn "origin.aggregate\|@agg\|validateAggregate" server/typescript/packages/metadata/src`); Test: the origin-validation test file.

- [ ] **Step 1: Failing tests:** `any`/`all` require `@filter` + `@via`, forbid `@of` (`ERR_INVALID_ORIGIN`), field must be boolean non-array; `collect` requires `@of` + field `isArray:true`, `@distinct` valid only on `collect`; a non-`collect` `@agg` with `isArray:true` → error (the inverse rule); `@orderBy` on a `distinct` collect → error. Run → FAIL.
- [ ] **Step 2: Implement** the conditional-presence + shape rules in the validation pass (reuse the existing aggregate validation site). Run → PASS. Commit.

### Task 1.2: `origin.computed` validation

- [ ] **Step 1: Failing tests:** the `@expr` inferred root type must equal the field's declared `subType` (`ERR_COMPUTED_TYPE_MISMATCH`); a `{field: X}` ref to a non-existent base field → error; `origin.computed` on a field with `@via`/`@of` → error (row-level only). Run → FAIL.
- [ ] **Step 2: Implement** using `inferExprType` (Task 0.1) against the base entity's effective fields (ADR-0039). Run → PASS. Commit.

### Task 1.3: `origin.first` validation

- [ ] **Step 1: Failing tests:** `@orderBy` required + its keys resolve against the related (`@via`-target) entity's fields; the carrying field must NOT be `@required` (empty→null); `@of` type-preservation (field subType must equal `@of`'s, #185 doctrine); `@via` single-hop-unique inference (ADR-0029) applies. Run → FAIL.
- [ ] **Step 2: Implement.** Run → PASS. Commit.

---

## PHASE 2 — TS view synthesis (migrate-ts, TS-only)

### Task 2.1: Extend the SelectSpec column model

**Files:** `migrate-ts/src/**/view-spec.ts` (`:44-61`), `extract-view-spec.ts` (`:57-87`).

- [ ] Add new `SelectColumn` kinds: `predicateAgg` (any/all), `collectAgg`, `computed`, `first`. Extend `extractViewSpec` to resolve each from its origin (predicate/`@filter` against the related entity; `@expr` tree; `@orderBy`). No lowering yet — just the resolved model + a resolution unit test. Commit.

### Task 2.2: `any|all` lowering + Task 2.3: `collect` lowering + Task 2.4: `computed` lowering

**Files:** `view-ddl-emit.ts` (`:50-131`).

- [ ] For each capability, **write a failing view-DDL golden test first** (assert the emitted SQL for Postgres AND SQLite), then implement:
  - **any/all:** `COALESCE(bool_or(<pred> AND <joined.pk> IS NOT NULL), FALSE)` / `bool_and`+`TRUE` on PG; `COALESCE(MAX/MIN(CASE WHEN <pred> AND <joined.pk> IS NOT NULL THEN 1 ELSE 0 END), 0)::boolean` on SQLite. `<pred>` reuses `renderFilterCond` (`:50-64`).
  - **collect:** `COALESCE(array_agg(<of> ORDER BY <of|orderBy>) [DISTINCT], '{}')` on PG (phantom-row-guarded); `json_group_array` on SQLite, wire-normalized.
  - **computed:** lower the `@expr` tree to a SQL expression (a small tree-walk emitter, PG + SQLite; `isNotNull` → `<col> IS NOT NULL`).
- [ ] **Migrate round-trip gate** for each: `emit → apply to a real engine (PG + SQLite) → introspect → re-diff must be EMPTY` (pass `dialect`). Commit each capability separately.

### Task 2.5: `origin.first` lowering (the correlated-subquery reshape — biggest)

**Files:** `view-ddl-emit.ts` (`:116-131` — the single-statement JOIN+GROUP-BY emitter).

- [ ] **Step 1: Failing golden** for a projection mixing passthrough + an aggregate + a `first` column — assert the correlated scalar subquery in the SELECT list (`(SELECT <of> FROM <child> WHERE <fk> = <base.pk> [AND <filter>] ORDER BY <orderBy>, <child.pk> LIMIT 1)`) composes with the outer `GROUP BY` (base PK is in the grouped set). PG + SQLite.
- [ ] **Step 2: Implement** the emitter change so a `first` column emits a correlated subquery keyed on the base alias, coexisting with the JOIN+GROUP-BY. Round-trip gate. Commit.

### Task 2.6: Join-inflation WARN

- [ ] Emit a load-time WARN when inflation-sensitive aggregates (`sum`/`avg`/non-distinct `collect`) coexist with ≥2 many-`@via` branches (hardens the existing latent `sum`/`avg` bug too). Test + commit.

---

## PHASE 3 — TS conformance + native typing

### Task 3.1: Conformance fixtures (per capability, zero-rows pins)

- [ ] Add `fixtures/conformance/` fixtures: `origin-agg-any`, `origin-agg-all`, `origin-agg-collect`, `origin-computed-isnotnull`, `origin-first-latest` — each with input metadata + expected canonical serialization, **and a zero-related-rows scenario** asserting the empty-set pin. Add a `fixtures/persistence-conformance/` roundtrip for the `collect` array wire shape (PG native array vs SQLite `json_group_array` → same wire). Update registry-conformance manifests. Run TS conformance → green. Commit.

### Task 3.2: TS native typing (payload/DTO)

- [ ] The projection field types: `any/all → boolean`, `collect → T[]`, `first → nullable source type`, `computed → inferred type`. Wire into `codegen-ts` projection field typing + a golden. Commit.

---

## PHASE 4 — Cross-port propagation (fork-per-port: C#, Python, Java, Kotlin)

### Task 4.1: Sync canonical spec copies + registry-conformance (all 5)

- [ ] Copy the updated `spec/metamodel/origin.json` + `attr.json` to `server/csharp/MetaObjects/SpecMetamodel/` + `server/python/src/metaobjects/spec_metamodel/` (byte-identical); Java auto-refreshes; regenerate/verify each port's registry manifest. Run each port's registry-conformance → green. Commit.

### Task 4.2: Per-port validation + native typing (fork-per-port)

For EACH of C#, Python, Java, Kotlin (a fork owns one port; orchestrator re-verifies + reviews + commits):
- [ ] Port the `attr.expression` MetaAttr equivalent (parse/validate/`inferExprType`/`filterToExpr`) + the per-capability validation rules (Tasks 1.1–1.3) + native field typing (Task 3.2) for the new origins. Mirror the committed TS implementation (the parity reference). Run the port's conformance + registry gate → green. Each fork reports; orchestrator independently re-runs the gate, code-review + code-simplifier, commits.

---

## PHASE 5 — Cross-port review + finalize

- [ ] **Task 5.1:** Run an xhigh workflow-backed `/code-review` over the full #195 diff, focused on cross-port divergence (does every port infer expression types identically? reject the same invalid vocab? type the projection fields identically?) + the migrate synthesis correctness. Fix confirmed findings; add a gate scenario for any ungated behavior a finding reveals.
- [ ] **Task 5.2:** Docs — `CHANGELOG.md` Unreleased entry; retire the `origin.expression` reservation note in `origin-constants.ts` + a one-line update to issue #159 (comment); note the escape-valve follow-up FR in `spec/roadmap.md`. Re-run all 5 ports' conformance from clean. Commit + push.
- [ ] **Task 5.3:** Not a release. Close #195 referencing the commits when the owner asks to release (bundled with #203–205 per the agreed order).

---

## Out of scope (per spec §8)

The "not migrate-managed" escape valve (separate Fable-driven FR — generalizes to any DB object, `@sqlView`-style DDL attr + managed-elsewhere marker); #159 expression nodes (arithmetic/case/via-joined refs); strict output-type validation for the existing 5 `@agg` values; `nth`/offset on `origin.first`; null-placement `@orderBy` vocabulary.
