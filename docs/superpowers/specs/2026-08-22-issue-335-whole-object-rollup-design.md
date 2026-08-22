# Whole-object rollup on `origin.aggregate @agg: collect` — design

**Issue:** [#335](https://github.com/metaobjectsdev/metaobjects/issues/335)
**Date:** 2026-08-22
**Status:** proposed
**Baseline:** `9eede9dd9`

## Summary

Make `@of` **optional** on `origin.aggregate @agg: collect`. Absent means a **whole-object
rollup**: collect the related rows as a JSON array of the field's declared `@objectRef`
value-object, rather than an array of one scalar column.

```jsonc
{ "field.object": {
    "name": "supplierBriefs",
    "isArray": true,
    "@objectRef": "acme::common::SupplierBrief",
    "children": [
      { "origin.aggregate": { "@agg": "collect", "@via": "acme::catalog::Product.suppliers" } }
    ]
}}
```

The work ships in **two halves**. Half A is the feature. Half B closes two holes in the
queryable-projection contract that Half A would otherwise land a column into.

## Why two halves

A projection is a **queryable relational surface**, not merely a wire read-shape. That is the
project's intent, and it is already true in code: any object with a readable source gets
`renderFilterAllowlist` / `renderSortAllowlist` and filtered read routes
(`templates/entity-file.ts:171`).

A whole-object rollup column is a deliberate **leaf** inside that surface — non-filterable by
construction, like a `jsonb` column in any hand-written view. The loader already enforces the
leaf-ness (`@filterable` on `field.object` is `ERR_FILTERABLE_UNSUPPORTED_SUBTYPE`,
`validation-passes.ts:436-455`).

But the surface contract has two holes today, **independent of this feature**:

1. **The filter allowlist is not `isArray`-aware.** `filterSubTypeFor`
   (`templates/filter-allowlist.ts:38-44`) falls through to `"string"` for any unrecognised
   subtype, and nothing in that file consults `isArray` at all. So
   `field.string isArray: true @filterable: true` already emits a `like`/`eq` rule against a
   `text[]` column. This is live: `weekLabels` is a shipping array projection column.
2. **There is no `@sortable` subtype validation anywhere in the loader** — versus a hard error
   for `@filterable`. `@sortable: true` on a JSON or array column passes the loader and emits a
   sort entry.

Shipping Half A without Half B adds a second non-scalar column shape to a query tier that
already mishandles the first.

## Decision: no new subtype and no new `@kind`

Considered and rejected: distinguishing a "document projection" from a "relational projection"
in the type system.

- **ADR-0037's subtype test fails.** A subtype needs its own native type, behaviour, or
  attributes. Both forms are read-only views, with the same source `@kind`s and the same
  generated artifacts. The only difference is whether one column is non-scalar.
- **`@kind` is already chartered for something else.** On `source.rdb` it names *which physical
  relational object backs this* — `table | view | materializedView | storedProc |
  tableFunction` — and read-only-ness is **derived** from it (`spec/metamodel/source.json`). A
  `documentView` member would be a category error and would break that derivation.
- **The query contract is already per-FIELD**, which is the correct level, because that is
  where the truth lives. A projection carrying one nested column stays a queryable surface on
  every other column.

**Consequence recorded deliberately:** #210 made `object.projection` the only legal host for
assembly origins, so "assemble a document" has no other home in the metamodel. If a shipping
consumer ever needs a read shape that is *not* a queryable surface, that earns its own type
then — the ADR-0007 Amendment 2 bar, the same discipline applied to `origin.collection`. Not
now, and not on speculation.

---

# Half A — the whole-object rollup

## A1. Loader (all five ports)

Split `collect` out of the `@of`-required gate at `validation-passes.ts:1252`.

**`@of` PRESENT** — unchanged, including the element-type-preserving check at `:1265-1268`.

**`@of` ABSENT** — the carrying field must be:

| Requirement | Error | Already enforced? |
|---|---|---|
| `field.object` with `@objectRef` | `ERR_INVALID_ORIGIN` | new |
| `isArray: true` | `ERR_INVALID_ORIGIN` | yes — `:1192-1197` |
| `@objectRef` targets an `object.value` | `ERR_SUBTYPE_RULE_VIOLATION` | **new — see below** |
| `@via` present | `ERR_INVALID_ORIGIN` | new (no `@of` to infer from) |
| at least one to-many `@via` hop | `ERR_ORIGIN_CARDINALITY` | yes — `_checkAggregateCardinality` |
| `@distinct` absent | `ERR_INVALID_ORIGIN` | new — see A5 |

**The value-only rule is NOT inherited from #210.** `_checkNestedPayloadRefsValueOnly`
(`validation-passes.ts:213`) walks only from **template-level payload targets** — its own
comment scopes it to "every `field.object @objectRef` reachable from a template-level payload
target". A projection-hosted `field.object` never reaches that pass, so nothing today stops a
projection field's `@objectRef` from resolving to an `object.entity`. This branch must enforce
it itself, reusing `ERR_SUBTYPE_RULE_VIOLATION` for consistency with the payload-side message.
Without it, an `@objectRef` to an entity reintroduces the #270 shape — a curated value silently
becoming the full entity — in DDL.

**Element type is declared-authoritative (#270).** The element type comes from the declared
`@objectRef`, never from the `@via` relationship's target entity. This is the exact bug #270
deleted; the rule is restated here because the new branch is where it could be reintroduced.

**`@orderBy` re-points.** `_validateOrderByKeys` currently resolves keys against
`ofTarget?.entity` (`:1271`). With `@of` absent there is no `ofTarget`, so keys must resolve
against the `@via` **terminal** entity.

**Multi-hop `@via` is legal.** `viaTerminalEntity` already walks every segment
(`extract-view-spec.ts:477-493`), and the `any`/`all` branch already permits multi-hop. No new
restriction — consistency with the sibling branch is the reason.

## A2. Member resolution — the #270 guard

The lowering must project **exactly the declared value-object's members**, matched **by name**
against the `@via` terminal entity's effective fields.

- A VO member with **no matching field** on the terminal entity → **error**, new code
  `ERR_COLLECT_MEMBER_UNRESOLVED`. A new code must be added to the shared ledger and every
  registry that gates it — TS `errors.ts` (exact-bidirectional), Python `errors.py` (superset),
  Java `ErrorCode.java` — in the same change, or the ledger tests fail.
- A VO member whose `field.<subType>` **differs** from the matched field's → **error**, reusing
  `ERR_INVALID_ORIGIN`, which is what the scalar element-type check at `:1265-1268` already
  emits. This is the object-form analogue of that check, carrying the same #185
  type-preserving doctrine per member.

Failing open here — silently dropping or substituting members — is precisely how #270 turned a
declared curated value-object into the full entity. The error is the point.

## A3. Codegen (TypeScript only — ADR-0015)

`extract-view-spec.ts`: today `if (!of_) continue;` (`:891`) sits **above** the `AGG_COLLECT`
branch (`:902`), and the aggregated entity is resolved *from* `@of`. Restructure so the
object arm resolves from `@via` instead.

**Mirror the `any`/`all` branch** (`:861-885`) — it is the same shape and already proven:
`viaTerminalEntity(via, …)` → `resolveEntityRef` → `findAliasInTree` → `primaryKeyColumn`.

New column kind `collectObjectAgg` in `view-spec.ts`, carrying the resolved member list
(`{ memberName, sourceColumn }[]`) plus `sourceAlias`, `joinedPkColumn`, `orderBy`.

Kept as a **separate kind** rather than an arm of `collectAgg`: the payloads differ (a member
list vs a single source column) and the existing kind is consumed by
`viewOrderKeysAreDeterministic` / the real-aggregate predicate at `:1005` and `:1021`, which a
union type would force every consumer to re-narrow.

## A4. DDL lowering (`view-ddl-emit.ts`)

Preserves the existing empty-set guard and ordering discipline.

**Postgres — `jsonb`, not `json`.** Verified against PostgreSQL 15.15: `json` has neither an
equality nor an ordering operator (`ERROR: operator does not exist: json = json`;
`could not identify an ordering operator for type json`), so the `json_agg(json_build_object(…)
ORDER BY …)` form named in the issue **does not run**. `jsonb` has both, and `field.object` is
already `jsonb` in `column-mapper.ts:610-613`.

```sql
COALESCE(
  jsonb_agg(jsonb_build_object('id', s."id", 'name', s."name") ORDER BY s."id" ASC)
    FILTER (WHERE s."id" IS NOT NULL),
  '[]'::jsonb
) AS "supplierBriefs"
```

**SQLite** — verified on 3.53.0: nested objects propagate (the JSON subtype carries), and
in-aggregate `ORDER BY` and the `FILTER` clause both work.

```sql
COALESCE(
  json_group_array(json_object('id', s."id", 'name', s."name") ORDER BY s."id" ASC)
    FILTER (WHERE s."id" IS NOT NULL),
  json_array()
) AS "supplierBriefs"
```

In-aggregate `ORDER BY` requires SQLite **≥ 3.44**. This is **not a new constraint** — the
existing scalar `collect` already emits it, and D1's baseline is pinned at `3.44.0`
(`introspect/d1.ts:44`).

**Empty default differs by arm**: the scalar arm keeps `'{}'` (a PG array); the object arm uses
`'[]'::jsonb`. The scalar arm's output must stay byte-identical.

## A5. Element order and dedupe

**Default order: the related entity's primary key, ascending.** "Value-ascending" does not
transfer from scalars — ordering rows by a serialized object is meaningless, and on PG `json`
it does not even parse. PK-ascending is deterministic and already the in-emitter precedent:
`renderFirst` appends `childAlias.childPk ASC` as its tie-break (`view-ddl-emit.ts:131-137`).

**`@orderBy` is supported**, resolving against the `@via` terminal entity, with the PK appended
as tie-break so equal-order rows stay byte-deterministic.

> **This diverges from the scalar arm, deliberately.** Today a scalar `collect` with `@orderBy`
> emits *only* those keys (`view-ddl-emit.ts:193-196`) — no tie-break — so two rows equal under
> the keys have engine-chosen order. That is tolerable for scalars and not for objects, where
> the value itself cannot break the tie (PG `json` has no ordering operator at all). Appending
> the PK matches `renderFirst`, which already does exactly this. The scalar arm is **not**
> changed: doing so would alter existing emitted SQL for every project using `@orderBy`.

**`@distinct` is FORBIDDEN — by choice, not by engine limit.** State this honestly: it was
verified to work on both engines (SQLite 3.53 `json_group_array(DISTINCT json_object(…))`
dedupes correctly; PG `jsonb_agg(DISTINCT …)` works). It is forbidden because it is a
guaranteed no-op whenever the value-object carries the entity's primary key, which is the
common case, and a silent no-op is worse than a refusal. Re-entry path if an adopter presents a
real case: allow `@distinct` **with a mandatory `@orderBy`**, inverting today's mutual
exclusion.

## A6. Registry prose — byte-gated, seven files

`@of` is already `"required": false` structurally, so no `required` flip. But its `description`
reads *"Required for count/sum/avg/min/max/collect; …"* and that string is byte-gated in seven
places across all five ports:

```
fixtures/registry-conformance/expected-registry.json
fixtures/metamodel-docs/expected/types/origin.md
spec/metamodel/origin.json
server/csharp/MetaObjects/Persistence/Origin/OriginSchema.cs
server/csharp/MetaObjects/SpecMetamodel/origin.json
server/python/src/metaobjects/spec_metamodel/origin.json
server/typescript/packages/metadata/src/persistence/origin/origin-definition.embedded.ts
```

All seven change in lockstep or `registry-conformance` goes red in every port.

## A7. `metamodelVersion`: `0.10` → `0.11` (additive)

This is #210 in reverse — a rule change whose only machine-readable footprint is prose, which
`check-metamodel-version.mjs` can only **WARN** about (`:36`). No gate forces the call, so it is
made here: **additive**, because previously-invalid metadata becomes valid and nothing that
loaded before stops loading. Set with `node scripts/check-metamodel-version.mjs --set 0.11`
(writes all five sites).

---

# Half B — the queryable-surface contract

## B1. `isArray`-aware filter band

`filterSubTypeFor` (`templates/filter-allowlist.ts:38-44`) maps subtype → category and falls
through to `"string"`; nothing consults `isArray`.

**Rule:** an array-typed field is **not filterable** under the FR-009 scalar operator band. A
`field.<scalar> isArray: true` carrying `@filterable: true` becomes a **load error**, reusing
`ERR_FILTERABLE_UNSUPPORTED_SUBTYPE` — the same door `field.object` already goes through, since
the reason is identical (no operator in the band applies).

Fail at load, not by filtering the field out of the allowlist: silently dropping a declared
`@filterable` is the same failure mode as the pre-#292 unchecked snapshot — the author believes
something is enforced that is not.

## B2. `@sortable` subtype validation

`@sortable` defaults from `@filterable`, so today it is only independently set when explicit —
and nothing validates it. Add the subtype/array check that `@filterable` has, so
`@sortable: true` on a JSON or array column is a load error rather than a generated sort over a
JSON column.

**Note:** B1 and B2 are potentially breaking for a project that today declares
`@filterable`/`@sortable` on an array field. That declaration currently generates a rule that
cannot work, so this converts a runtime failure into a load failure. Call it out in the
changelog.

---

## Testing

**The corpus must gain the case, not just the code.** `fixtures/conformance/README.md:102`
already records `flattened-kitchen-sink`'s dropped `supplierBriefs` as *"coverage genuinely
lost"* and names #335 as the restore path. Restore it there, expressed the new way.

| Layer | What |
|---|---|
| Conformance (5 ports) | `@of`-absent collect loads on a `field.object @objectRef isArray`; each error arm fails: no `@objectRef`, non-value target, missing `@via`, all-to-one `@via`, unresolved member, member type mismatch |
| No-churn | a `collect` **with** `@of` emits byte-identical SQL — pinned, since the scalar arm shares the branch |
| Real engine, both dialects | emit → apply → introspect → **re-diff must be empty**, then read rows back and assert the array-of-objects shape, including the empty-set case returning `[]` not `null` |
| Half B | a `@filterable` array field fails to load; a `@sortable` array field fails to load |

**The round-trip tests live in a separate package.** `view-lifecycle-{pg,sqlite}.test.ts` are in
`server/typescript/packages/integration-tests`, which only the `ts-slow` lane runs — they will
not appear in a `codegen-ts` or `migrate-ts` run. Golden SQL alone is not acceptable evidence
for new DDL; that is how the migrate defect class got through before.

**SQLite byte-stability binds.** `view-fingerprint.ts` explains that Postgres never compares
against the deparser (it hashes the body we emit), **but that "SQLite/D1 need none of this:
`sqlite_master.sql` is the verbatim text we wrote, so the body comparator is exact there."** So
the emitted SQLite expression must be deterministic or every migrate reports drift.

## Non-goals

- Non-RDB lowerings — #211's capability matrix.
- Filtering a parent by an embedded child's property. This is the capability a queryable
  surface would eventually want, `json_agg` cannot serve it, and it is a separate design.
- Exposing `ObjectManager.attachIncludes` as a generated endpoint. It is wired into the
  ObjectManager read path (`object-manager.ts:128,140`) but **no generated endpoint surfaces
  it** and it is TS-only. If that is ever built, it is the app-side-merge counterpart to this
  view-side join — the two are alternatives, and this design does not foreclose it.

## Evidence base

Claims here were verified at `9eede9dd9` rather than carried from the issue text. Four of the
issue's own statements did not survive:

1. **"No registry change"** — structurally true, but the byte-gated `description` prose must
   change in seven files (A6).
2. **The proposed `json_agg(json_build_object(…) ORDER BY …)` does not run on Postgres** —
   verified against a real engine (A4).
3. **"One relaxed rule"** understates it — member resolution, `@orderBy` re-pointing, a new
   column kind, and a changed empty default all follow.
4. **"`@objectRef` must target an `object.value`, which is already a loader rule from #210"** —
   it is not. That rule is payload-scoped and never reaches a projection-hosted field (A1).
   This is the most consequential of the four: relying on it would have shipped the branch with
   its main #270 guard simply absent.

Two claims from review that also did not survive checking: this is **not** the first non-scalar
projection column (`weekLabels` ships today, asserted against real PG and SQLite), and
`@distinct` is **not** blocked by either engine.
