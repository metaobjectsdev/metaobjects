# Migration — `origin.collection` is retired (`0.24.0` / Maven `7.24.0`)

**Breaking.** The `origin.collection` subtype is **deregistered** in all five ports.

| retired | now fails with |
|---|---|
| `origin.collection` (any use) | `ERR_UNKNOWN_SUBTYPE` |

Under the strict, sealed registry (ADR-0023) there is no deprecation shim — metadata still
declaring it fails the **load**, in every language port. The surviving origin subtypes are
`passthrough`, `aggregate`, `computed` and `first`.

## What it cost you: nothing that worked

This is the unusual retirement where the honest headline is that **the subtype never did
anything**. Before you plan a migration, check what you actually lose:

- No port's codegen dispatched on it — zero references in `codegen-ts`, `migrate-ts` or
  `runtime-ts` source, and no `collection` column kind in the projection view lowering. A
  declared `origin.collection` contributed **no DDL and no generated code**.
- Its one real consumer, the payload-VO typing edge in the Kotlin/Python/Java generators, was
  deleted in **0.20.16 (#270)** for being *actively wrong*: it discarded the field's declared
  `@objectRef` and substituted the `@via` relationship's target entity, silently turning a
  declared curated value object into the full entity.

So it was declarable-but-inert. Deleting the child changes no generated output.

## Why

It duplicated `origin.aggregate @agg: collect` on a strictly smaller attr set. Both walk `@via`
to a related set and yield an array per host row; `collection` registered only `@via` — no
`@filter`, no `@orderBy`, no `@distinct` — so the split was a capability *loss*, not a
distinction. Run in reverse, ADR-0037's step 2a says a structural variant of a reduction
belongs on the reduction's variant axis, and reductions already have one: `@agg`.

Reserved-not-registered, with the re-entry bar and designated re-entry shape recorded in
[ADR-0040](../../../spec/decisions/ADR-0040-index-type-and-secondary-key-purity.md).

## What to do

### 1. A scalar rollup → `origin.aggregate @agg: collect`

If the field collects a **column** from the related rows, this is a direct upgrade — and you
gain `@filter`, `@orderBy` and `@distinct`, none of which `collection` could express.

```jsonc
{ "field.string": {
    "name": "supplierNames", "isArray": true,
    "children": [
-     { "origin.collection": { "@via": "acme::catalog::Product.suppliers" } }
+     { "origin.aggregate": {
+         "@agg": "collect",
+         "@of": "acme::catalog::Supplier.name",
+         "@via": "acme::catalog::Product.suppliers" } }
    ]
}}
```

`collect` preserves the **element** type: the array field's own `field.<subType>` must equal
the `@of` column's, and the field must be `isArray: true`.

### 2. A whole-object rollup → delete the child

If the field collected whole nested value objects (`field.object @objectRef … isArray: true`),
**delete the `origin.collection` child and change nothing else**:

```jsonc
{ "field.object": {
    "name": "supplierBriefs", "isArray": true,
    "@objectRef": "acme::catalog::SupplierBrief",
-   "children": [
-     { "origin.collection": { "@via": "acme::catalog::Product.suppliers" } }
-   ]
}}
```

The declared shape is unchanged, and payload typing has been **declared-authoritative since
0.20.16** (#270) — the type came from `field.object` + `isArray` + `@objectRef`, never from the
origin. Generated payload records, output parsers and render helpers are byte-identical.

**State it plainly, because it is the one real gap:** no surviving origin expresses a
whole-object rollup along a relationship — `@agg: collect` reduces a *column* via `@of`. If
that field was on a `source.rdb @kind: view` **projection** and you were relying on the view
DDL, note that no port ever emitted DDL for `origin.collection` either, so nothing regresses;
but you also cannot now declare the provenance. That shape returns with
[#335](https://github.com/metaobjectsdev/metaobjects/issues/335), which makes `@of` **optional**
on `@agg: collect` (absent = whole-object rollup, typed by the declared `@objectRef` +
`isArray`, never derived from the `@via` target) and ships the view lowering with it. It is
**additive**, so it needs no breaking window.

### 3. `ASSEMBLY_ORIGIN_SUBTYPES` shrinks to three

If you consume the constant from a port's public surface, it is now
`aggregate | computed | first`. The #210 rule it governs — assembly origins are illegal on an
`object.value` host, `ERR_SUBTYPE_RULE_VIOLATION` — is unchanged for those three.

## How to find every use

```
grep -rn "origin\.collection" <your metadata dir>
```

There is no partial-adoption state: the load fails on the first one, in every port, so the
grep count is the exact size of the migration.
