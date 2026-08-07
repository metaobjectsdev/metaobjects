# Migrating value-hosted assembly origins (#210) and retired `@role` members (#212)

This release line carries **three** coordinated breaking metamodel changes. All
three fail at **load time** with a clear error — nothing changes silently — and
each has a mechanical rewrite.

1. **Assembly origins leave `object.value` (#210).** A field hosted on an
   `object.value` may no longer carry `origin.aggregate`, `origin.computed`,
   `origin.collection` or `origin.first`. Re-host the payload as a
   **sourceless `object.projection`** — `@payloadRef`/`@responseRef` now accept
   one.
2. **Nested payload targets are value-only, loader-enforced (#210).** A payload
   field's `field.object @objectRef` must resolve to an `object.value`.
   TypeScript, C# and Python previously accepted a non-value target here and
   emitted a nested shape from it — that metadata now fails load.
3. **`source.rdb @role` shrinks to `primary | replica` (#212).** The
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
needs no change. The host subtype change **alone** does not affect payload
typing — every port's payload emitter is declared-type-authoritative (#270) —
but **adding an `extends` anchor is not typing-neutral: the field then inherits
the anchored field's properties, which can flip its optionality** (e.g. a
`title` anchored to a `@required` entity field becomes required in the
generated record). Regenerate and review the payload diff rather than assuming
byte-identity; this repo's own canonical example changed
`title?: string` → `title: string` under exactly this rewrite.

### What does NOT change

- `origin.passthrough` on `object.value` (parameter lineage).
- Assembly origins on `object.projection` and on `object.entity` read-views.
- Nested payload shapes already targeting an `object.value`.
- Physical schema: a sourceless projection has no DDL, so `meta migrate` emits
  nothing for it.

---

## 2. Nested payload targets are value-only (#210)

### What changed

Every `field.object @objectRef` reachable from a template-level payload target
(the `@payloadRef`/`@responseRef` closure) must resolve to an `object.value` —
now enforced by the loader in all four ports. Before this release the loader
did not constrain the target's subtype: Kotlin and Java codegen filtered
non-value targets out, but **TypeScript, C# and Python accepted the shape and
emitted a nested interface/record from the entity** — so a payload field
pointing at an `object.entity` (or a projection) previously loaded and
generated code, and now fails.

### The error you'll see

```
ERR_SUBTYPE_RULE_VIOLATION: payload 'acme::ai::ReviewRequest' field 'author'
@objectRef 'acme::Author' resolves to object.entity — a nested payload target
must be an object.value (template-level refs may also target a sourceless
object.projection, nested refs may not) (#210, ADR-0028, ADR-0044)
```

### Rewrite rule

Declare an `object.value` mirroring the subset of the entity the payload
actually needs — optionally `extends`-binding the entity's fields to reuse
their shape — and repoint the `@objectRef` at it. Embedding a full entity in a
payload was always payload bloat (every entity column shipped to the LLM); the
curated value makes the exposure an explicit, reviewable list.

**Before:**

```jsonc
{ "object.value": {
    "name": "ReviewRequest",
    "children": [
      { "field.string": { "name": "instructions" } },
      { "field.object": { "name": "author", "@objectRef": "Author" } }
    ]
}}
```

**After:**

```jsonc
{ "object.value": {
    "name": "AuthorBrief",
    "children": [
      { "field.string": { "name": "name", "extends": "Author.name" } }
    ]
}},
{ "object.value": {
    "name": "ReviewRequest",
    "children": [
      { "field.string": { "name": "instructions" } },
      { "field.object": { "name": "author", "@objectRef": "AuthorBrief" } }
    ]
}}
```

(The widen does NOT extend here: a nested `@objectRef` at a sourceless
projection is also rejected — only the **template-level**
`@payloadRef`/`@responseRef` accept a projection.)

---

## 3. `source.rdb @role` shrinks to `primary | replica` (#212)

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

(Wording varies by port — Java, for example, emits `… is not a valid value;
allowed: primary, replica` — but the code and the allowed set are identical in
all four loaders.)

A single-source object with a non-`primary` role also reports
`ERR_SOURCE_NO_PRIMARY`. That error is not new — a single source declaring
`@role: index` failed the one-primary rule before the shrink too; what changes
is that you now see **both** errors, since the retired member additionally
fails the `allowedValues` check.

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
