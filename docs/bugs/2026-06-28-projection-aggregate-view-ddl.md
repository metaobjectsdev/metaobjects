---
name: Bug report
about: Report a defect
title: "Projection origin.aggregate columns dropped from generated view DDL (inverse-FK @via + aggregate filter)"
labels: bug
---

> **RESOLVED.** Both gaps are fixed and gated. The inverse-FK `@via` join
> resolution and the `origin.aggregate` `@filter` rendering landed in
> `7619002b` ("fix(codegen-ts): render origin.aggregate @filter in projection
> view DDL", #90); `@filter` is now registered in all five ports with an
> `origin-aggregate-filtered` registry-conformance fixture. Kept as a written
> record of the failure mode — the contract-vs-DDL divergence class it describes
> is worth recognising again.

**Affected port(s):** TypeScript (codegen-ts view-SQL builder)
**Package + version:** `@metaobjectsdev/codegen-ts` 0.12.5 (`projection/extract-view-spec.ts`), surfaced via `@metaobjectsdev/migrate-ts` 0.12.0 + `@metaobjectsdev/cli` 0.12.5, dialect postgres.

**What happened**

A `object.projection` with an `origin.aggregate` column over a **one-to-many (inverse-FK)** relationship has that column **silently dropped** from the generated `CREATE VIEW` DDL. The column IS present in the generated TS contract (Zod + types), so the contract and the actual DB view disagree — querying the view fails (the column doesn't exist) while the types claim it does.

Two distinct gaps, both in `codegen-ts` `extract-view-spec.ts` → `view-ddl-emit.ts`:

1. **Inverse-FK `@via` not resolved into the join tree.** When `origin.aggregate @via` points at a `relationship.composition` whose FK lives on the *target* side (the 1→many inverse — parent has many children, child holds the FK), the join-tree builder doesn't add the child table, so `findAliasInTree(joinTree, entityName)` returns `undefined` and the aggregate branch hits `continue` — the column is dropped entirely. (`extract-view-spec.ts`, the `else if (origin.subType === ORIGIN_SUBTYPE_AGGREGATE)` block.) This drops *every* aggregate over an inverse relationship, including a plain `count`.

2. **Aggregate `filter` not rendered.** `origin.aggregate` accepts a `filter` (an `attr.filter` desugar — e.g. `filter: { status: { eq: active } }`) and the loader accepts it without error, but `view-ddl-emit.ts` emits `AGG(src) AS alias` with **no `FILTER (WHERE …)`** clause. So even when the join resolves, a filtered aggregate (`max(version) where status='active'`) computes over *all* rows, returning the wrong value. (`meta types origin.aggregate` also doesn't list `filter` as an attr, though the loader honors it.)

**What you expected**

The generated view SQL should include the aggregate column with the join and the filter, e.g.:

```sql
CREATE VIEW v_behavior_definition AS
SELECT
  b.id, b.name, ...,
  COUNT(DISTINCT v.id)                              AS version_count,
  MAX(v.version) FILTER (WHERE v.status = 'active') AS active_version
FROM behavior_definitions b
LEFT JOIN behavior_versions v ON v.behavior_id = b.id
GROUP BY b.id, b.name, ...;
```

**Reproduction**

Minimal metadata: a parent entity, a child entity holding the FK back to the parent, an inverse `relationship.composition` on the parent, and a projection that aggregates over it.

```yaml
- object.entity:
    name: BehaviorDefinition
    children:
    - source.rdb: { table: behavior_definitions }
    - field.string: { name: name }
    # inverse of behavior_versions.behavior_id (FK is on the child):
    - relationship.composition: { name: versions, objectRef: BehaviorVersion, cardinality: many }
    extends: AuditedEntity
- object.entity:
    name: BehaviorVersion
    children:
    - source.rdb: { table: behavior_versions }
    - field.uuid:   { name: behaviorId, column: behavior_id }
    - field.int:    { name: version }
    - field.string: { name: status }
    - identity.reference: { name: fk_b, fields: [behaviorId], references: BehaviorDefinition }
- object.projection:
    name: BehaviorDefinitionView
    children:
    - source.rdb: { kind: view, view: v_behavior_definition }
    - field.uuid:   { name: id, extends: BehaviorDefinition.id }
    - field.string: { name: name, children: [ origin.passthrough: { from: BehaviorDefinition.name } ] }
    - field.int:    { name: version_count,
                      children: [ origin.aggregate: { agg: count, of: BehaviorVersion.id, via: BehaviorDefinition.versions } ] }
    - field.int:    { name: active_version,
                      children: [ origin.aggregate: { agg: max, of: BehaviorVersion.version,
                                                      via: BehaviorDefinition.versions,
                                                      filter: { status: { eq: active } } } ] }
    - identity.primary: { extends: BehaviorDefinition.pk }
```

Steps: `meta gen` (the TS contract gets `version_count` + `active_version` — correct), then `meta migrate --dialect postgres` → the generated `CREATE VIEW` has **only the passthrough columns**; both aggregate columns are absent (no `LEFT JOIN`, no `GROUP BY`).

**Root-cause pointers**
- `codegen-ts/src/projection/extract-view-spec.ts`: the aggregate branch `continue`s when `findAliasInTree` can't find the target — the join-tree builder needs to resolve an inverse (target-side-FK, cardinality `many`) composition into a `LEFT JOIN child ON child.fk = parent.pk`.
- `codegen-ts/src/projection/view-ddl-emit.ts`: the aggregate emitter needs a postgres `FILTER (WHERE …)` (or per-dialect equivalent) when the `origin.aggregate` carries a `filter`.
- A conformance fixture exercising an inverse-FK aggregate + a filtered aggregate would pin both.

**Environment**
Linux, Node 24, pnpm 10. Found while migrating a downstream consumer's admin UI to a generated projection view; worked around by hand-authoring the view SQL body.

---

## Resolution (2026-06-28)

**Gap 1 (inverse-FK join) was already fixed on `main`** — the `ProgramSummary` test
(`extract-view-spec.test.ts`) covers an aggregate `count` over an inverse-FK `weeks`
relationship and passes. The reporter hit it only on the published 0.12.0 the CLI
pins; latest `main` resolves the inverse join. No code change needed.

**Gap 2 (aggregate filter) is fixed here** (codegen-ts only — no cross-port metamodel
change, see scoping note):
- `projection/view-spec.ts` — new `ViewFilterClause` type; `aggregate` SelectColumn
  gains an optional `filter`.
- `projection/extract-view-spec.ts` — reads the aggregate's `@filter` attr, **desugars**
  it (scalar→eq, array→in, null→isNull, and/or recurse), and resolves each field to
  `<sourceAlias>.<column>` on the aggregated entity.
- `projection/view-ddl-emit.ts` — renders postgres `AGG(src) FILTER (WHERE …)` /
  `COUNT(DISTINCT src) FILTER (WHERE …)`, and the portable `AGG(CASE WHEN … THEN src END)`
  form for sqlite (no aggregate FILTER pre-3.30).
- Tests: `build-projection-views.test.ts` — postgres FILTER, scalar-shorthand desugar,
  and sqlite CASE WHEN. Full codegen-ts suite green (863).

**Scoping note:** the `@filter` attr is read codegen-locally (a const in
extract-view-spec) rather than declared in the `origin.aggregate` metamodel
(`spec/metamodel/origin.json`). Declaring it there is the "proper" home but ripples to
all five ports' registry-conformance + the embedded/manifest/docs drift gates — a
separate cross-port change. The loader already stores the undeclared attr; codegen
desugars it, so the feature works today without the metamodel churn. Follow-up: declare
`@filter` on `origin.aggregate` across all ports when convenient (then codegen can drop
its local desugar and rely on the framework's).
