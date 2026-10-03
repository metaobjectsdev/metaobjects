# Naming Conformance

A small, data-only gate for the cross-language contract that every port's
pluralization pair — the API/code-surface pluralizer and the frozen
default-physical-name pluralizer — agrees on the SAME inputs. See CLAUDE.md →
"Cross-language porting" for the general rule this specializes.

## Why this exists

An entity whose name is already a plural noun (`Stats`, `Settings`, `Series`)
used to get double-pluralized by every port's naming seam: the REST collection
path, generated hook/query/finder/list function names, and DbSet/collection
variable names all came out `ProgramPurchaseStatses` instead of
`ProgramPurchaseStats`. A real adopter shipped six such URLs.

The fix adds already-plural detection to each port's **API/code-
surface** pluralizer only — never to the **default physical table/column name**
fallback, which stays frozen at the old suffix-only rule so an adopter's live
database never sees `meta migrate` propose a rename for an entity it didn't
touch. That means every port now carries TWO pluralizers where it used to carry
one (or, in ports that already kept them physically separate — C#, Java,
Python — the already-plural fix lands on only one of the two existing
functions). This fixture is the single place that proves all five ports agree
on which pluralizer does what, for both axes, on the same input set.

## Schema

[`already-plural-pluralize.json`](./already-plural-pluralize.json):

```jsonc
{
  "cases": [
    { "name": "Stats", "apiPlural": "Stats", "legacyPlural": "Statses", "note": "..." }
  ]
}
```

- `name` — a PascalCase entity short name.
- `apiPlural` — what the API/code-surface pluralizer must return for `name`
  (REST collection segment, generated hook/finder/list names, DbSet/collection
  names — every generator-facing use).
- `legacyPlural` — what the FROZEN default-physical-name pluralizer must
  return for `name` (reached only when metadata declares no explicit physical
  name).

The case set deliberately covers three behavior classes in one pass:

1. **Already-plural** (`Stats`, `Settings`, `Series`) — `apiPlural` is
   unchanged from `name`; `legacyPlural` still doubles it (frozen).
2. **Looks similar but isn't** (`Status`, `Address`, `Alias` — each ends in
   "...s" preceded by one of the four excluded letters u/s/a) — both columns
   are IDENTICAL to each other and to the pre-fix behavior. These pin the
   "don't overcorrect" half of the fix: a genuinely singular word ending in
   "...us"/"...ss"/"...as" must still pluralize normally.
3. **Unaffected baseline** (`Category`, `Box`) — doesn't end in "s" at all
   before pluralizing, so neither axis is touched by this fix. Proves the
   already-plural check never fires on an ordinary word.

## Per-port runner

Each port's existing naming unit-test file reads this JSON and asserts both
columns against its own two pluralizers:

| Port | Test file |
|---|---|
| TypeScript | `server/typescript/packages/metadata/test/naming.test.ts` |
| C# | `server/csharp/MetaObjects.Codegen.Tests/CSharpNamingTests.cs` |
| Java / Kotlin | `server/java/codegen-base/src/test/java/com/metaobjects/generator/util/RouteNamingTest.java` (Kotlin inherits — `KotlinNaming.collectionSegment` delegates to the same `RouteNaming.pluralize`) |
| Python | `server/python/tests/codegen/test_route_path_naming.py` |

No HTTP server, no database — this corpus is intentionally a pure function
check, unlike `api-contract-conformance` (which is the right place for the
*route-spelling* half of this rule end-to-end over HTTP, see
`fixtures/api-contract-conformance/m2m/scenarios/route-spelling-multiword-collection.yaml`).
The DEFAULT PHYSICAL TABLE NAME axis has no HTTP-observable surface at all, so
it can only be proven at the pluralizer-function level — which is exactly what
this corpus does for both axes at once, in one data file.
