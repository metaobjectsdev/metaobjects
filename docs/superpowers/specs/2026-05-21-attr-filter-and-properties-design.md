# Design: `attr.filter` and `attr.properties` attribute subtypes

**Date:** 2026-05-21
**Status:** Approved (design)
**Author:** Doug Mealing (with Claude)

## Problem

`layout.dataGrid` declares a preset filter via an `@filter` attribute whose value is an
**escaped JSON string**:

```jsonc
"layout.dataGrid": {
  "name": "active",
  "@filter": "{\"subscribed\":true}",
  "@columns": ["email", "firstName", "createdAt"]
}
```

This is a smell:

- Escaping noise — every nested `"` becomes `\"`.
- No JSON syntax highlighting or editor assistance inside the string.
- Validation is deferred all the way to **codegen time**: the string is `JSON.parse`d and
  checked against the entity's filter allowlist in
  `codegen-ts-tanstack/src/templates/columns-file.ts`. A typo surfaces 30 seconds into
  `meta gen`, not where the metadata lives.
- It violates the project principle that metadata is structural, not stringly-typed.

## Goals

1. Replace the escaped-string `@filter` with a typed, structural value.
2. Move filter validation from codegen time to **load time**.
3. Close a Java-parity gap by completing the half-built `attr.properties` subtype in TS.
4. Preserve cross-language wire format and vocabulary (TS / Java / C# / future Python).

## Non-goals (out of scope)

- "Maximal" shorthand: comma-split strings (`"active,pending"`) or operator-prefix syntax
  (`"gte:2024-01-01"`). Reinventing the URL filter grammar inside metadata is a footgun.
- Placing `attr.filter` on nodes other than `layout.dataGrid` (restricted for now — see
  Decision D2).
- The `@isArray`-modifier migration Java has done but TS has not (separate effort).
- Java/Python codegen consumers of `@filter` (Java codegen isn't ported yet).

## Decisions

- **D1 — Shorthand level: Standard.** Three desugaring rules only: scalar → `eq`,
  array → `in`, `null` → `isNull`. Canonical full form `{ field: { op: value } }` always
  accepted. No string-splitting or prefix magic.
- **D2 — `attr.filter` placement: restricted to `layout.dataGrid`.** Generalize to other
  nodes only when a real second consumer appears.
- **D3 — Migration: hard break.** The loader rejects the old escaped-string `@filter` with a
  clear error pointing to the new object syntax. Aligns with the project's
  "no backwards-compat hacks" rule and v0.x pre-stable status. In-repo metadata
  (downstream-consumer, fixtures) is converted by hand as part of the work.
- **D4 — Scope: both attrs together.** `attr.filter` (new, has a consumer) and
  `attr.properties` (Java parity, no consumer yet) ship in one project.
- **D5 — `grid-filter-validate` relocation: move into `@metaobjects/metadata`.** Filter
  operators are a metamodel concept (`FILTER_OPS` / `OPS_BY_SUBTYPE` already live in
  `metadata/src/constants.ts`), so the validator belongs there. Codegen imports from
  metadata rather than owning the logic.

## Key prior-art findings

- The filter operator vocabulary already lives in the metadata package:
  `FILTER_OPS` and `OPS_BY_SUBTYPE` in `server/typescript/packages/metadata/src/constants.ts`
  (line ~428). Load-time validation needs **nothing** from codegen.
- `attr.properties` is **half-wired** in TS already: the constant `ATTR_SUBTYPE_PROPERTIES`
  exists, it is registered as an attr subtype, and it maps to `DATA_TYPE_OBJECT` in
  `ATTR_DATA_TYPE` (`core-types.ts` line ~186). But `attr-schema-validate.ts` (line ~65)
  wrongly lumps it into `STRING_ATTR_SUBTYPES`, so a `properties` value is currently
  validated as requiring a string. This is a latent bug the work fixes.
- Java already ships `PropertiesAttribute` (`attr.properties`,
  `server/java/metadata/.../attr/PropertiesAttribute.java`); no `FilterAttribute` yet.
- The existing codegen validator `grid-filter-validate.ts` already handles `or`/`and`
  composition and `eq`-sugar, but does **not** validate array values (they currently fall
  through unchecked). The array → `in` case must be added.

## Design

### 1. `attr.filter` — shape and semantics

Canonical: `{ field: { op: value } }`. Standard shorthand:

```jsonc
"@filter": {
  "subscribed": true,                    // scalar  → { eq: true }
  "status": ["active", "pending"],       // array   → { in: [...] }
  "deletedAt": null,                     // null    → { isNull: true }
  "createdAt": { "gte": "2024-01-01" }   // explicit operator object
}
```

Desugaring (applied before validation and before the codegen const is emitted):

| Authored value      | Desugars to            |
|---------------------|------------------------|
| scalar `v`          | `{ eq: v }`            |
| array `[...]`       | `{ in: [...] }`        |
| `null`              | `{ isNull: true }`     |
| `{ op: v }` object  | unchanged              |

`or` / `and` composition keys are preserved and recursed.

Plumbing:
- New constant `ATTR_SUBTYPE_FILTER = "filter"` in `metadata/src/constants.ts`; added to
  `ATTR_SUBTYPES` and its `as const` union.
- `ATTR_DATA_TYPE` map in `core-types.ts` gains `[ATTR_SUBTYPE_FILTER]: DATA_TYPE_OBJECT`.
- `LAYOUT_DATA_GRID_ATTR_FILTER` in `core-attr-schemas.ts` changes `valueType` from
  `ATTR_SUBTYPE_STRING` → `ATTR_SUBTYPE_FILTER`; description updated.
- `MetaLayout.filter` accessor (`meta/meta-layout.ts`) returns the parsed object
  (`Record<string, unknown> | undefined`) instead of a string.

### 2. `attr.properties` — complete the wiring

A bag of string→string pairs, matching Java's `java.util.Properties` semantics. Authored as
a JSON object:

```jsonc
"@codegen": { "drizzle.indexHint": "btree", "drizzle.fillFactor": "70" }
```

Work:
- Remove `ATTR_SUBTYPE_PROPERTIES` from `STRING_ATTR_SUBTYPES` in `attr-schema-validate.ts`.
- Add an object-shaped validator: value must be an object whose values coerce to string.
- Add a `MetaAttr` accessor returning `Record<string, string> | undefined`.
- Add a canonical-serializer path (object, deterministic key order).

### 3. Load-time validation (the payoff)

Today: `@filter` validated at codegen time in `columns-file.ts` (`JSON.parse` +
`validateGridFilter`).

New: a deferred validation pass in `metadata/src/loader/validation-passes.ts`, alongside the
existing `validateDataGridSortFields` (same shape — runs after `extends:` resolution so
inherited `@filterable` fields are visible).

`validateDataGridFilterValues(root): ParseError[]`:
1. For each entity, build the filter allowlist from its `@filterable` fields using
   `OPS_BY_SUBTYPE` (already in metadata constants).
2. For each `layout.dataGrid` with `@filter`, desugar then validate: every key is a
   filterable field; every op is allowed for that field's subtype.
3. Emit structured errors (field-not-filterable, op-not-allowed) where the metadata lives.

### 4. Codegen simplification

- `columns-file.ts`: stop `JSON.parse` (value is already an object); stop re-validating
  (load-time covers it). Still emit the `<entity><Grid>Filter` const verbatim via
  `JSON.stringify(parsed, null, 2)`.
- `grid-hook-file.ts`: untouched (`l.filter !== undefined` still works).
- `grid-filter-validate.ts`: **moved** into `@metaobjects/metadata` (Decision D5); array →
  `in` validation added; codegen imports it from metadata.

### 5. Cross-language ports

- **Java**: add `FilterAttribute.java` (subtype `filter`, `DataTypes.CUSTOM`, JSON-object
  value) and register it in `AttributeTypesMetaDataProvider.java`. `PropertiesAttribute`
  already exists. Add the load-time filter-validation parity. No codegen wiring (Java codegen
  not ported).
- **C#**: loader + canonical serializer only (its charter). Add `filter` + `properties`
  handling in `MetaAttr.cs` / `CoreAttrSchemas.cs` so the shared conformance corpus passes.

### 6. Conformance fixtures (`fixtures/conformance/`)

New fixtures (all four languages verify identically):
- `attr-filter-shorthand` — scalar/array/null desugaring.
- `attr-filter-explicit-ops` — `gte` / `lte` / `like` operator objects.
- `attr-properties-basic` — key→value bag.
- `error-attr-filter-bad-field` — `@filter` references a non-filterable field.
- `error-attr-filter-bad-op` — disallowed op for field subtype (e.g. `like` on a boolean).
- `error-attr-filter-legacy-string` — the hard-break check: old `"{...}"` string form is
  rejected.

Update `CAPABILITIES.json` and `ERROR-CODES.json` accordingly.

### 7. Migration (hard break)

The loader rejects the old escaped-string `@filter` with an error naming the new object
syntax. Convert downstream-consumer's `meta.*.json` and in-repo fixtures by hand.

## Testing (TDD, tests first)

- **metadata**: subtype registration; desugaring; attr-schema validation (filter +
  properties, including the properties-as-string bug fix); the new load-time pass; serializer
  round-trip.
- **codegen-ts-tanstack**: regenerate golden snapshots; confirm const emitted from object
  value; confirm no codegen-time validation regressions.
- **Java**: `mvn test` registration + parity for `FilterAttribute`.
- **C#**: `dotnet test` conformance against the shared corpus.
- **shared fixtures**: the six new fixtures pass in every language.

## Affected files (reference)

TypeScript (`server/typescript/packages/`):
- `metadata/src/constants.ts` — `ATTR_SUBTYPE_FILTER`, add to `ATTR_SUBTYPES`.
- `metadata/src/core-types.ts` — `ATTR_DATA_TYPE` gains `filter → object`.
- `metadata/src/core-attr-schemas.ts` — `LAYOUT_DATA_GRID_ATTR_FILTER` valueType.
- `metadata/src/attr-schema-validate.ts` — fix properties; add object/filter validation.
- `metadata/src/parser-core.ts` — parse/coerce filter + properties values.
- `metadata/src/serializer-json.ts` — canonical object-valued attr serialization.
- `metadata/src/meta/meta-layout.ts` — `filter` accessor returns object.
- `metadata/src/loader/validation-passes.ts` — `validateDataGridFilterValues` pass.
- `metadata/src/grid-filter-validate.ts` — relocated here (from codegen-ts-tanstack); array→in.
- `codegen-ts-tanstack/src/templates/columns-file.ts` — drop JSON.parse + revalidation.
- `codegen-ts-tanstack/src/grid-filter-validate.ts` — removed (moved to metadata).

Java (`server/java/metadata/`):
- `.../attr/FilterAttribute.java` — new.
- `.../attr/AttributeTypesMetaDataProvider.java` — register filter.

C# (`server/csharp/MetaObjects/`):
- `Meta/MetaAttr.cs`, `CoreAttrSchemas.cs` — filter + properties loader/serializer support.

Fixtures (`fixtures/conformance/`):
- six new fixtures + `CAPABILITIES.json` / `ERROR-CODES.json` updates.
