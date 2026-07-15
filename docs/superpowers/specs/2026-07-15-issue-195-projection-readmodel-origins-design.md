# Issue #195 — Four projection read-model origin capabilities (semantic, backend-agnostic)

**Date:** 2026-07-15
**Status:** Designed + owner-approved (this doc). Reviewed by a Fable subagent (2026-07-15) which sharpened three of the four picks under the backend-agnostic lens and surfaced the filter-AST reuse path. Ready for `writing-plans`.
**Issue:** [#195](https://github.com/metaobjectsdev/metaobjects/issues/195). Owner rulings baked in (see §1).

## 0. Problem

`object.projection` + `origin.*` can synthesize view/read-model DDL for **passthrough** and **count/sum/avg/min/max aggregate** shapes today. A common class of admin/monitoring read-models can't be expressed, forcing adopters to keep them as **hand-authored, unmanaged** views — which `meta migrate` can't own and `meta verify --db` can't drift-check. Because `meta migrate` processes the whole tree and an underivable projection **throws and aborts the entire run** (`extract-view-spec.ts:226-231`), a single un-expressible view blocks migration of *every other entity* — so an adopter with even a few monitoring views can't adopt `meta migrate` at all. Four capabilities are missing:

1. Boolean rollup — "did **any** related row fail?"
2. Row-level computed column — a derived value from the base row's own fields.
3. Correlated latest-row — "the **latest** related row's column X."
4. Array rollup — collect related values into an array column.

## 1. Owner rulings (decided — do NOT reopen)

- **All four capabilities** in this FR.
- `origin.computed`'s expression is a **structured expression tree** in metadata (not a SQL string; not a raw-SQL escape hatch).
- **Semantic / backend-agnostic mandate:** each origin declares the *intent* of the derived field, independent of SQL. The RDB (`source.rdb`, ADR-0007) lowering is **one** realization; the vocabulary must also be lowerable by a non-RDB backend (an in-process runtime evaluator over the ObjectManager layer, a document-store aggregation pipeline, …). Anything that only makes sense for an RDB is a defect.
- Naming: **`origin.computed`** (not `origin.expression`). This **retires the `origin.expression` reservation** in `origin-constants.ts:29-32` / issue #159; #159's future arithmetic becomes additive node kinds in `origin.computed`'s expression tree.
- **Strict issue order:** finish #195 fully, then #203 → #204 → #205.
- **Out of scope → separate follow-up FR** (to be designed with Fable): the "this DB object is not migrate-managed" escape valve. It is NOT projection-only and NOT a new invention — it ties to an intended `@sqlView`-style attribute that carries the actual hand-written view DDL, PLUS a distinct "managed elsewhere" concept, and must generalize to **any** DB object (entities included), not just projections. See §8.

## 2. Semantic frame (the contract every origin obeys)

An origin declares a **pure, deterministic derivation over the entity graph**: given a base row and the set of related rows reachable along `@via`, produce **one value of the field's declared type** (`field.subType` + `isArray` are the output-type contract, extending the #185 passthrough type-preservation doctrine). Determinism is non-negotiable because the conformance corpora **byte-compare** results and the migrate view-fingerprint must be stable — so every capability pins its empty-set value, its tie-break, and its null handling.

This frame already has **two independent consumers** in-repo, which is what makes the backend-agnostic mandate tractable:
- **View DDL synthesis** (TS-only, ADR-0015): `extractViewSpec` → `SelectSpec` → a `LEFT OUTER JOIN … GROUP BY` statement (`view-spec.ts:44-61`, `view-ddl-emit.ts:116-131`).
- **Native-type resolution** for in-process payload assembly (cross-port, NOT SQL): e.g. `KotlinPayloadGenerator.kt:38-46,151-157` maps `@agg count → Long`, `avg → Double`, `collection → List<TargetPayload>`.

So every new origin has two proof obligations from day one — a view lowering **and** a native-type contract — and the design below states both plus a document-store sanity check.

## 3. The four capabilities

### 3.1 Boolean rollup — `origin.aggregate @agg: any | all` (predicate quantifier)

**Semantic contract:** "does **any** (`any`) / **every** (`all`) related row reachable along `@via` match this predicate?" The predicate is the **already-shipped, 5-port `@filter` AST** (`attr.filter`), resolved against the related (`@via`-target) entity's fields — exactly as `origin.aggregate @filter` resolves today (`extract-view-spec.ts:73`). For `any`/`all`, `@filter` is **required** (a quantifier needs a predicate — bare "does any related row exist" is `count`, not `any`) and `@of` is **forbidden** (the quantifier is over rows, not a column); `@via` is **required** (no `@of` entity to infer the single-hop from). Output type: `field.boolean`, never `isArray`.

- The canonical `bool_or(NOT success)` is `@filter: { success: false }` — negation is free (`eq: false` / `ne` / `isNull: false` are all in the shipped filter vocabulary). No expression grammar needed for this case.
- **Pinned semantics:** empty related set → `any = false`, `all = true` (vacuous truth — matches every port's stdlib). Result is **never null**.
- **RDB lowering:** `COALESCE(bool_or(pred), FALSE)` / `COALESCE(bool_and(pred), TRUE)` on Postgres; `MAX/MIN(CASE WHEN pred THEN 1 ELSE 0 END)` coalesced on SQLite (no boolean aggregates). **Both must guard the LEFT-JOIN phantom row** (`joined.pk IS NOT NULL AND pred`) so a null-extended non-match can't satisfy the predicate.
- **Non-RDB check:** in-process `rows.some(pred)` / `rows.every(pred)` (JS `some/every`, Python `any/all`, Java `anyMatch/allMatch`, C# `Any/All`, Kotlin `any/all`) — the exact primitive with the exact empty-set semantics. Document-store `$lookup` + `$filter`/`$anyElementTrue`. Carries fully.
- **Why an `@agg` value, not a subtype (ADR-0037):** "reduce the related row-set to one value" is exactly what `origin.aggregate` *does*; `any`/`all` change the reducing function, not the behavior → a closed-set enum axis (`@agg`), §2c. **Inflation-immune** (duplicate join rows can't flip an any/all verdict), unlike `sum`/`avg`.
- **Rejected:** `@agg: any` over a boolean `@of` column (no slot for the `NOT success` negation without contaminating `@of` with an expression grammar); a new `origin.exists` subtype (forces a second subtype or a mode-attr for the `all` dual, and grows a parallel branch in every consumer instead of a case).

### 3.2 Array rollup — `origin.aggregate @agg: collect`

**Semantic contract:** collect the `@of` values across the related row-set into a **list**. `@of` required (the collected column, type-preserving); field must be `isArray: true` with element subtype = the `@of` field's subtype. `@distinct` (optional boolean) = set semantics. Optional `@orderBy` (see §4) for insertion/time order.

- **Named `collect`, not `arrayAgg`** — `array_agg` names the Postgres mechanism (forbidden by the semantic mandate); `collect` names the intent (Java/Kotlin streams word; Mongo `$push`/`$addToSet`).
- **Pinned semantics:** empty set → `[]` (never null); default element order = **element-value ascending** (conformance byte-stability + cache-stability; conveniently also satisfies PG's `array_agg(DISTINCT x ORDER BY x)` co-occurrence rule); `@distinct` dedupes.
- **RDB lowering:** `COALESCE(array_agg(...), '{}')` on Postgres (guarding the LEFT-JOIN `{NULL}` phantom); `json_group_array` (TEXT) on SQLite, wire-normalized to a JSON array (same wire shape as PG native arrays, gated by the persistence roundtrip corpus).
- **Non-RDB check:** `map → dedupe? → sort → collect`; Mongo `$setUnion`/`$push` + `$sortArray`. Carries fully.
- **Why an `@agg` value:** collecting is still "reduce the row-set to one value"; the value is a list (a fold with concat), and `isArray: true` carries that. Also add the **inverse rule**: every *non-collect* `@agg` requires `isArray: false` (closes a latent hole).
- **Rejected:** a new subtype (same §2b/2c reasoning as any/all); overloading `origin.collection` with a scalar `@of` (collection is a payload-assembly concept that never lowers to view DDL — attr-presence mode-switching is the implicit discrimination `@kind` was chartered to prevent).

### 3.3 Computed column — `origin.computed @expr: <expression tree>` (NEW subtype)

**Semantic contract:** a **row-level** derived value computed from the base entity's own effective fields (ADR-0039 resolving accessors) — no related rows, no `@via`. `@expr` is a **structured expression tree** (new `attr.expression` attr subtype, §4bis). Output type = the tree's inferred root type, which **must equal** the declared `field.subType` (`ERR_COMPUTED_TYPE_MISMATCH`, sibling of `ERR_PASSTHROUGH_TYPE_MISMATCH`). No `@convert` escape — a computed column's type is *derived*, not asserted.

- The flagship case `payload IS NOT NULL AS has_payload` is `@expr: { op: isNotNull, arg: { field: payloadJson } }` → `field.boolean`.
- **Why a new subtype (ADR-0037):** "this field's value comes from an expression over this row" is a distinct behavior; provenance is not a new field *type* (a computed boolean is a boolean — `field.subType` stays the native-type contract per ADR-0001), which rejects a `field.formula` subtype and keeps the whole derived⇒read-only machinery keyed on `origin.*` (ADR-0028 §4).
- **Non-RDB check:** an expression over one row's own fields is the *most* portable construct in the design — in-process eval is trivial; Mongo `$project` expressions map 1:1. No RDB-isms (literals stay JSON-typed; op set stays closed).

### 3.4 Correlated latest-row — `origin.first` (NEW subtype)

**Semantic contract:** "pick **one** related row along `@via`, ordered by `@orderBy`, and project its `@of` column." `@of` required (`Entity.field`, type-preserving); `@via` (dotted path, ADR-0029 single-hop-unique inference applies since `@of` anchors the entity); `@orderBy` **required** (§4); `@filter` optional (over the related entity, same resolution as aggregate's). "Latest" = `@orderBy: [createdAt:desc]`; "earliest" falls out free; nth/offset is YAGNI-cut.

- **Named `origin.first`, not `origin.latest`** — the semantic altitude is **argmax** (row-selection then projection), of which "latest" is one ordering. A subtype named `latest` that still needs `@orderBy` is a half-abstraction and needs an "earliest" twin.
- **Pinned semantics:** empty set (after filter) → `null`, so the carrying field must **not** be `@required` (validation error). **Determinism pin:** the related entity's primary key ascending is always appended as the final tie-breaker (equal-order rows otherwise make output plan-dependent and un-byte-comparable).
- **RDB lowering:** a **correlated scalar subquery** in the SELECT list (`SELECT @of FROM child WHERE fk = base.pk [AND filter] ORDER BY @orderBy, child.pk LIMIT 1`) — portable across PG + SQLite (`LATERAL`/`DISTINCT ON` are per-dialect optimizations, not the contract). **This breaks the current single-JOIN+GROUP-BY emitter shape** (`view-ddl-emit.ts:116-131`): the correlated column keys on the base alias and must coexist with `GROUP BY` (the base PK is always in the grouped passthrough set, so it composes — but this is the **largest TS implementation cost** in the FR).
- **Non-RDB check:** `related.filter(pred).sortBy(orderBy ⊕ pk)[0]?.of ?? null`; Mongo `$lookup` + `$sortArray` + `$first`. Carries fully.
- **Why a new subtype (ADR-0037 §2a):** row-selection-then-projection is its own behavior with its own attr (`@orderBy`), distinct from a column reduce; rejected `@agg: latest` (argmax is not a column-reducing function and drags an `@orderBy` no other `@agg` carries).

## 4. Shared primitive — `@orderBy`

`@orderBy`: a **string array** of `field[:asc|desc]` entries (default `asc`), resolved against the **related** entity's effective fields; reuses the shipped sort grammar + `SORT_ORDER_VALUES` constants (the `field:asc|desc` form already used by URL/dataGrid sort). **Null placement is pinned semantically, not spelled:** nulls sort **last** in both directions (lowered as `NULLS LAST` on PG / SQLite ≥ 3.30; a trivial comparator rule in-process / document-store). No null-placement vocabulary now (YAGNI; a future third `:` segment can add it). Deliberately **not** the `@fields`+positional-`@orders` pair from the index escapes — that pair is explicitly "RDB-physical, contributed by the db provider" (`expected-registry.json:2654-2665`), the wrong donor for a semantic attr.

## 4bis. The `attr.expression` grammar (backs `origin.computed`)

`origin.computed @expr` is a new **`attr.expression`** attr subtype — the same registration pattern as `attr.filter` (a per-port `MetaAttr` class with coerce/validate/desugar, cf. `meta-attr-filter.ts:19-40,67`; a provider declaration; a registry-conformance fixture). It is a **closed** node grammar (unknown `op`/`fn`/node-kind → load error, ADR-0023):

- `{ "field": "<name>" }` — ref into the base entity's effective fields → that field's subtype.
- `{ "value": <string|number|boolean|null> }` — literal.
- `{ "op": "eq|ne|gt|gte|lt|lte", "left": e, "right": e }` → boolean — **the same op names and per-subtype legality bands as `FILTER_OPS` / `OPS_BY_SUBTYPE`** (`query-constants.ts:20-64`), so the two languages stay one vocabulary.
- `{ "op": "isNull" | "isNotNull", "arg": e }` → boolean (`isNotNull` earns its own name per ADR-0037 self-documentation — it is *the* flagship case).
- `{ "op": "and" | "or", "args": [e, …] }`, `{ "op": "not", "arg": e }` → boolean.
- `{ "fn": "coalesce", "args": [e, …] }` → the unified arg subtype.

**Filter-embeddability (the reuse that matters):** every `attr.filter` object has a canonical embedding into this tree (each `{ field: { op: literal } }` clause ↦ a comparison node), so **each port implements ONE expression evaluator / lowering core** and the existing filter renderers become thin adapters over it. The reuse is shared *semantics + one engine*, not shared surface syntax — because the filter's leaves are `field → {op: literal}` and structurally **cannot** hold a value tree (field-vs-field, `coalesce`), a literal filter object is insufficient (`meta-attr-filter.ts:60-65`).

**Deferred to #159 as additive node kinds (NOT this FR):** arithmetic (`+ - * /`), `case`/`if`, string functions, and `@via`-joined field refs. The grammar is designed so these slot in without a second expression language.

**Type inference:** a small bottom-up pass — comparisons/logic/null-tests → boolean; `coalesce` → unified arg type; `field` → that field's subtype; root type must equal the declared `field.subType`.

## 5. Cross-port surface

**Cross-port (all 5 ports — vocabulary + validation + native typing):**
- `spec/metamodel/origin.json` + `spec/metamodel/attr.json`: extend `@agg` `allowedValues` to `count|sum|avg|min|max|any|all|collect`; add `origin.computed` + `origin.first` subtypes; add the `@distinct` (bool) + `@orderBy` (string-array) attrs; add the `attr.expression` subtype. → regenerate the **TS embedded** copy (`origin-definition.embedded.ts`) AND **sync the committed C# + Python copies** (`server/csharp/MetaObjects/SpecMetamodel/*.json`, `server/python/src/metaobjects/spec_metamodel/*.json` — the known forgotten-copy → silent-conformance-fail gotcha); Java auto-refreshes.
- `fixtures/registry-conformance/expected-registry.json` + the 5-port registry-conformance gate.
- The `attr.expression` `MetaAttr` class per port (coerce/validate/desugar).
- Validation passes (all 5 ports): conditional `@of`/`@filter`/`@orderBy`/`@distinct` presence per `@agg` value; `origin.computed` expression type-inference + `ERR_COMPUTED_TYPE_MISMATCH`; `origin.first` type-preservation + not-`@required` + `@orderBy` field resolution; `isArray` agreement (collect ⇒ isArray, all others ⇒ not).
- Typed origin classes in Java/Kotlin/C#/Python + the TS metadata classes.
- Payload/DTO **native typing** (`KotlinPayloadGenerator` et al. + the other ports): `any/all → Boolean`, `collect → List<T>`, `first → nullable source type`, `computed → inferred type`. (Projection DTO emission itself is cheap — these are ordinary typed fields.)

**TS-only (ADR-0015 — migrate owns schema):**
- New `SelectColumn` kinds in `view-spec.ts` + resolution in `extract-view-spec.ts` + lowering in `view-ddl-emit.ts` (incl. the correlated-subquery emitter change for `origin.first`).
- View-fingerprint / expected-schema wiring in migrate-ts for the new column kinds.

**Conformance:** a fixture per capability (`origin-agg-any`, `origin-agg-all`, `origin-agg-collect`, `origin-computed-isnotnull`, `origin-first-latest`), each exercising the **zero-related-rows** case (empty-set pins) + the value case; registry-conformance manifests updated; a persistence roundtrip scenario for the `collect` array wire shape (PG native array vs SQLite `json_group_array`).

## 6. Risks + mitigations

1. **`origin.first` breaks the one-statement JOIN+GROUP-BY emitter** — the largest TS delta. Mitigation: golden coverage of a projection mixing passthrough + aggregate + a correlated `first` column, asserting the correlated subquery composes with `GROUP BY`.
2. **Join inflation** — two distinct many-`@via` branches already silently corrupt `sum`/`avg` today (only `count` is DISTINCT-guarded, `view-ddl-emit.ts:72-79`); non-distinct `collect` inherits this. Mitigation: emit a **load-time WARN** when inflation-sensitive aggregates coexist with multiple many-branches (hardens an existing latent bug, not just the new vocab).
3. **Empty-set / phantom-row pins differ from raw SQL defaults** (`bool_or → NULL`, `array_agg` over LEFT JOIN → `{NULL}`). Mitigation: every lowering does `COALESCE` + the `joined.pk IS NOT NULL` guard; conformance probes the zero-related-rows case per capability.
4. **SQLite divergences** (no boolean aggregates, no native arrays) normalized at the wire (`json_group_array`, `CASE WHEN` folds), gated by the roundtrip corpus.

## 7. Consolidated vocabulary (what registers)

- `origin.aggregate @agg` extended → `count | sum | avg | min | max | any | all | collect` (with `@of` schema-relaxed to optional + per-value validation; new `@distinct` bool + `@orderBy` string-array attrs).
- New subtype `origin.computed` with `@expr` of new attr subtype `expression` (closed node grammar §4bis; filter-embeddable; typed against the declared field).
- New subtype `origin.first` with `@of` / `@via` / `@orderBy` / `@filter`.
- New shared attrs `@orderBy` (string array) + `@distinct` (bool); new attr subtype `attr.expression`.

```jsonc
// 1. Boolean rollup — "did any turn fail?"
{ "field.boolean": { "name": "hasError", "children": [
  { "origin.aggregate": { "@agg": "any", "@via": "Session.turns",
      "@filter": { "success": false } } } ] } }

// 2. Computed — cheap derived boolean over the base row
{ "field.boolean": { "name": "hasPayload", "children": [
  { "origin.computed": { "@expr":
      { "op": "isNotNull", "arg": { "field": "payloadJson" } } } } ] } }

// 3. Latest related row's column
{ "field.string": { "name": "currentLabel", "children": [
  { "origin.first": { "@of": "ChildA.label", "@via": "Parent.childAs",
      "@orderBy": ["createdAt:desc"], "@filter": { "isActive": true } } } ] } }

// 4. Array rollup
{ "field.string": { "name": "categories", "isArray": true, "children": [
  { "origin.aggregate": { "@agg": "collect", "@of": "Item.category",
      "@via": "Order.items", "@distinct": true } } ] } }
```

## 8. Explicitly OUT of scope (follow-ups)

- **The "not migrate-managed" escape valve** — a separate FR, to be designed with Fable. It is NOT projection-only and NOT solved here: it ties to an intended **`@sqlView`-style attribute carrying the actual hand-written view DDL**, PLUS a distinct **"managed elsewhere"** marker, and must generalize to **any** DB object (entities included). Until it lands, a genuinely irreducible view still aborts the migrate run (`extract-view-spec.ts:226-231`) — the four capabilities cover the known monitoring shapes but do not remove the all-or-nothing abort. (Owner ruling 2026-07-15.)
- **#159 expression nodes** — arithmetic, `case`/`if`, string fns, `@via`-joined refs in `origin.computed`. Additive to the `attr.expression` grammar; `origin.computed` subsumes the retired `origin.expression` reservation.
- **Strict output-type validation for the *existing* 5 `@agg` values** — none exists today; adding it could newly-reject existing adopter metadata. This FR types the **new** vocab (error); the existing values are a separate hardening issue.
- **YAGNI cuts:** `nth`/offset on `origin.first`; null-placement vocabulary on `@orderBy`; a unified `origin.reduce` rename (aggregate already *is* the unified reduce; `@agg` is its function axis).

## 9. Open questions

None blocking. (The `origin.expression` reservation retirement requires a one-line update to issue #159's direction; the escape-valve FR is tracked separately per §8.)
