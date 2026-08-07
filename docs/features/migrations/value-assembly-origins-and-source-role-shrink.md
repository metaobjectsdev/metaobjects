# Migrating value-hosted assembly origins (#210) and retired `@role` members (#212)

This release line carries two coordinated breaking metamodel changes. Both fail
at **load time** with a clear error — nothing changes silently — and both have a
mechanical rewrite.

1. **Assembly origins leave `object.value` (#210).** A field hosted on an
   `object.value` may no longer carry `origin.aggregate`, `origin.computed`,
   `origin.collection` or `origin.first`. Re-host the payload as a
   **sourceless `object.projection`** — `@payloadRef`/`@responseRef` now accept
   one.
2. **`source.rdb @role` shrinks to `primary | replica` (#212).** The
   `index` / `cache` / `publish` / `mirror` members are retired
   (reserved-not-registered, the ADR-0040 treatment).

---

## 1. Assembly origins leave `object.value` (#210)

### What changed

The *assembly* origins — `origin.aggregate`, `origin.computed`,
`origin.collection`, `origin.first` — are now illegal on a field hosted by an
`object.value`, in all four loaders. **`origin.passthrough` stays legal on a
value**: there it declares FR-015 *parameter lineage* (e.g. a stored-proc
argument tracing back to an entity column), not an assembly path, and it keeps
its `ERR_PASSTHROUGH_TYPE_MISMATCH` type-preservation check.

In exchange, the template-level payload references widen:
`template.* @payloadRef` and `@responseRef` now accept a **sourceless
`object.projection`** (no `source.*` child, own or inherited) in addition to an
`object.value`. A *sourced* projection as a payload target remains illegal.
**Nested** payload targets — a payload field's `field.object @objectRef` — stay
value-only.

### Why

The durable rule (ADR-0028, amended): **passthrough on a value is lineage;
assembly origins live on projections.** A value is a pure shape — constructed by
a caller or by embedding, never populated from a backing store. Rolling up,
computing, or collecting from related rows is *derivation*, and derivation is
what `object.projection` exists for. A payload that declares its fields'
derivations is a *read model assembled on the wire* — which is exactly a
sourceless projection.

### The errors you'll see

```
ERR_SUBTYPE_RULE_VIOLATION: value object 'acme::ai::AuthorReport' field 'postCount'
hosts origin.aggregate — assembly origins (aggregate, computed, collection, first)
live on object.projection; a value is constructed by a caller or by embedding,
never assembled from a backing store. Re-host this field on a sourceless
object.projection; origin.passthrough (FR-015 parameter lineage) remains legal
on a value (#210, ADR-0028)
```

A nested payload `field.object @objectRef` pointing at anything other than an
`object.value` (an entity, or a projection) also fails:

```
ERR_SUBTYPE_RULE_VIOLATION: payload 'acme::ai::ReviewRequest' field 'author'
@objectRef 'acme::Author' resolves to object.entity — a nested payload target
must be an object.value (…)
```

### Rewrite rule

Change the payload's host subtype from `object.value` to `object.projection`.
Fields, origins, and the template's `@payloadRef` all stay as they are. One
addition may be needed: an origin **without an explicit `@via`** derives its
base entity from the projection's extends anchors, so `extends`-bind at least
one field (or declare an extended identity) to name the base.

**Before:**

```jsonc
{ "object.value": {
    "name": "AuthorReport",
    "children": [
      { "field.string": { "name": "name", "children": [
        { "origin.passthrough": { "@from": "Author.name" } } ] } },
      { "field.long": { "name": "postCount", "children": [
        { "origin.aggregate": { "@agg": "count", "@of": "Post.id", "@via": "Author.posts" } } ] } }
    ]
}},
{ "template.prompt": { "name": "AuthorBio", "@payloadRef": "AuthorReport", "@textRef": "ai/bio" } }
```

**After:**

```jsonc
{ "object.projection": {
    "name": "AuthorReport",
    "children": [
      { "field.string": { "name": "name", "extends": "Author.name", "children": [
        { "origin.passthrough": { "@from": "Author.name" } } ] } },
      { "field.long": { "name": "postCount", "children": [
        { "origin.aggregate": { "@agg": "count", "@of": "Post.id", "@via": "Author.posts" } } ] } }
    ]
}},
{ "template.prompt": { "name": "AuthorBio", "@payloadRef": "AuthorReport", "@textRef": "ai/bio" } }
```

(The `extends: "Author.name"` anchor is what lets the no-`@via` passthrough
derive `Author` as the base entity; every explicit-`@via` origin needs no
anchor.)

A value that carries **only** `origin.passthrough` (an FR-015 parameter VO)
needs no change. Generated payload records/interfaces are byte-identical across
the re-host — every port's payload emitter is declared-type-authoritative
(#270), so the host subtype does not affect payload typing.

### What does NOT change

- `origin.passthrough` on `object.value` (parameter lineage).
- Assembly origins on `object.projection` and on `object.entity` read-views.
- Nested payload shapes (`field.object @objectRef` → `object.value`).
- Physical schema: a sourceless projection has no DDL, so `meta migrate` emits
  nothing for it.

---

## 2. `source.rdb @role` shrinks to `primary | replica` (#212)

### What changed

The `@role` enum on `source.rdb` is now exactly `primary | replica`. The four
retired members — `index`, `cache`, `publish`, `mirror` — are **reserved, not
registered** (the ADR-0040 treatment): documented for future re-entry, rejected
by every loader today. A role member re-enters the registry only when a
shipping consumer dispatches on it (ADR-0007 amendment).

### The error you'll see

```
ERR_BAD_ATTR_VALUE: source.rdb attribute '@role' has value 'publish' which is
not one of the allowed values: primary, replica
```

(A single-source object with a retired role also reports `ERR_SOURCE_NO_PRIMARY`
— the retired member no longer counts as any role.)

### Rewrite rule

Every read of `@role` in every port is an equality test against `primary`, so
the four retired members were always indistinguishable from `replica` to every
consumer. The rewrite is mechanical: replace the retired member with `replica`.

**Before:**

```jsonc
{ "source.rdb": { "@kind": "view", "@view": "v_orders_search", "@role": "index" } }
```

**After:**

```jsonc
{ "source.rdb": { "@kind": "view", "@view": "v_orders_search", "@role": "replica" } }
```

`@role: primary` (or omitting `@role` — `primary` is the default) is unchanged.
No migration SQL is emitted for either change: `@role` never affected DDL.
