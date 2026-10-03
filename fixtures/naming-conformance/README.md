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

## Expected-collision cases

`collisionCases` (same file) covers the OTHER thing the already-plural fix
makes reachable: two DISTINCT entities in the same generation run whose
API-surface plural coincides.

```jsonc
{
  "collisionCases": [
    { "entityA": "Address", "entityB": "Addresses", "collidesOn": "Addresses", "note": "..." }
  ]
}
```

Before this fix, `Pluralize(singular)` always LENGTHENED its input, so a
singular/plural pair never coincided (`Pluralize("Address")` → `"Addresses"`,
`Pluralize("Addresses")` → `"Addresseses"` — distinct). After it,
`Pluralize("Addresses")` is a no-op (already-plural), landing on the exact
string `Pluralize("Address")` produces. Every port's codegen must REFUSE a
generation run containing such a pair — a named, cross-port error
(`ERR_COLLECTION_NAME_COLLISION`) naming both entities and the colliding
name — never silently let one win (a duplicate route, a duplicate generated
symbol, or in C# a `DbSet` property already declared under that name,
`CS0102`). This does NOT apply to the frozen `legacyPlural` (default
physical table name) axis: that rule still always lengthens its input, so it
cannot produce this collision — only the API-surface axis can, and only the
API-surface axis is checked here.

## Per-port runner

Each port's existing naming unit-test file reads this JSON and asserts both
`cases` columns against its own two pluralizers, and asserts each
`collisionCases` pair is REFUSED by that port's collision check:

| Port | Test file |
|---|---|
| TypeScript | `server/typescript/packages/metadata/test/naming.test.ts` (pluralizers); `server/typescript/packages/codegen-ts/test/naming/collection-name-collision.test.ts` (refusal — `assertNoCollectionNameCollisions`, wired into `runGen` in `runner.ts`) |
| C# | `server/csharp/MetaObjects.Codegen.Tests/CSharpNamingTests.cs` (pluralizers + refusal — `CSharpNaming.AssertNoCollectionNameCollisions`, wired into `CodegenRunner.Run`); `server/csharp/MetaObjects.Codegen.Tests/DbContextForeignKeyConfigTests.cs` (the historical Address/Addresses fixture, now an expected-error test at both the unit and `CodegenRunner.Run` integration level) |
| Java / Kotlin | `server/java/codegen-base/src/test/java/com/metaobjects/generator/util/RouteNamingTest.java` (pluralizers + refusal — `RouteNaming.assertNoCollectionNameCollisions`, wired into `MetaDataGeneratorMojo#executeGenerators`; Kotlin inherits both — it runs through the same Maven goal) |
| Python | `server/python/tests/codegen/test_route_path_naming.py` (pluralizers); `server/python/tests/codegen/test_collection_name_collision.py` (refusal — `assert_no_collection_name_collisions`, wired into `run_gen` in `runner.py`) |

No HTTP server, no database — this corpus is intentionally a pure function
check, unlike `api-contract-conformance` (which is the right place for the
*route-spelling* half of this rule end-to-end over HTTP, see
`fixtures/api-contract-conformance/m2m/scenarios/route-spelling-multiword-collection.yaml`).
The DEFAULT PHYSICAL TABLE NAME axis has no HTTP-observable surface at all, so
it can only be proven at the pluralizer-function level — which is exactly what
this corpus does for both axes at once, in one data file.
