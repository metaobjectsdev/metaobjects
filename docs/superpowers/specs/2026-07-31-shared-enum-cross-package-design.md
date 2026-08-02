# Shared enum across packages — Kotlin table-generator import fix (#246) + cross-port `extends`/`values` load error

**Date:** 2026-07-31
**Issues:** [#246](https://github.com/metaobjectsdev/metaobjects/issues/246) (primary) + the secondary observation in that issue (`extends` + own `values` silently dropped).
**Status:** design approved; proceeding to plan + implementation.

## Problem

The documented reuse mechanism — "reuse a constraint set across entities with an abstract `field.enum` + `extends`" — is broken in two ways when the sharing entities live in **different packages**. Both are instances of the cross-package bare-name bug class (a cross-package reference resolved/named/imported by bare short name instead of package-qualified), the same family #228 closed in the payload/extract tier. This work targets two siblings in the entity/enum tier.

Reproduction (canonical example packages):

```yaml
# acme::common
field.enum: { name: RecordStatus, abstract: true, values: ["DRAFT","ACTIVE","CLOSED"] }
# acme::orders   → field.enum: { name: status, extends: "acme::common::RecordStatus" }
# acme::billing  → field.enum: { name: status, extends: "acme::common::RecordStatus" }
```

### Bug 1 — Kotlin `<Entity>Table` drops the cross-package enum import (reproduces at HEAD)

`KotlinExposedTableGenerator` is a deliberately string-hand-rolled emitter (its class doc explains it bypasses KotlinPoet because Exposed's `Column<T>` types are inferred). At the two enum-column emit sites — `KotlinExposedTableGenerator.kt:586-589` (vanilla entity) and `:617-620` (TPH subtype-fold) — it does:

```kotlin
val enumName = KotlinTypeMapper.enumTypeName(field, entity)?.simpleName ?: error(...)
"enumerationByName(\"$colName\", ${KotlinTypeMapper.ENUM_VARCHAR_LEN}, $enumName::class)"
```

`enumTypeName()` (`KotlinTypeMapper.kt:175-205`) correctly resolves a **package-qualified `ClassName`** (walking to the shared abstract super at `:192-196`), but the table generator immediately discards the package via `.simpleName`. The file's manual import passes — `columnFunctionImports` (`:467-482`) and `crossPackageTableImports` (`:507-517`) — explicitly skip `EnumField` (`:476`) and only walk FK targets, so no import is ever added for the enum's own `ClassName.packageName`. Result: `OrderTable.kt` (package `acme.orders`) emits bare `RecordStatus::class` with **no `import acme.common.RecordStatus`** → `Unresolved reference`. In the reporter's tree this produced 214 compile errors.

The **data class** (`KotlinEntityGenerator.resolveElementType`, `:351-377`) gets it right only because it keeps the full `ClassName` and hands it to KotlinPoet, whose `FileSpec.writeTo()` auto-emits imports. The `<Entity>RepositoryBase` is **not** affected (it uses type-inferred bare property access — the issue text's claim about `RepositoryBase` does not hold).

### Bug 2 — `extends` + own `values` silently dropped (codegen collapse, not a loader defect)

The loader intentionally treats an own `@values` as authoritative when present (`ValidationPhase` `validateEnumNode`, own-wins per ADR-0039) — there is no error for declaring both `extends` and own `values`. The silent drop happens in **codegen's shared-enum collapse**: `KotlinTypeMapper.enumTypeName()` names every field extending the same abstract super after that super, and `KotlinEnumEmitter.emitEnumFile()` dedupes by that shared `ClassName` — so only the **first** field processed (in loader iteration order) has its `values` read; a later field's differing own `values` are skipped before they are ever consulted. One shared type cannot satisfy two member sets, so this is a structural conflict, not merely an ordering quirk. It surfaces only when exactly one extending field declares differing own `values` — and it is silent (the reporter's two copies diverged 10 vs 12 members, causing a runtime record-drop).

## Scope

**In scope:**
1. Fix Bug 1 — the Kotlin table-generator cross-package enum import (both the vanilla and TPH-fold emit sites).
2. Fix Bug 2 — a new **cross-port load error** when a `field.enum` both `extends` a shared package-level abstract enum and declares its own `values`.

**Out of scope (flagged, tracked separately — not dropped):**
- **C# materialized shared-enum cross-namespace reference** (`Fr019SharedEnum.cs:118-120` returns the bare name assuming one namespace; under `GenConfig.PackageNamespaces` splitting entities across namespaces it would go unresolved, and it hits the primary entity class). Its own follow-up: it needs a `PackageNamespaces` compile-repro before the exact fix is known, and it is arguably more severe.
- **Enum-typed primary key mistyped as `String`** in `KotlinRepositoryGenerator.primaryKeyParamType` (`:369-374`, uses `kotlinTypeName` not `enumTypeName`). Narrow, different bug class (enum PKs are an edge case). Separate item.
- **Python latent same-premise** (`fr019_shared_enum.py` relative `from .enums import Name`) — correct today because Python emits entity files flat; only a risk if a nested per-package layout is ever added. No change now.
- TypeScript is already correct (`enum-import.ts` computes a real relative module specifier); it is the reference design. No change.
- Java (`codegen-spring`) is immune — no generated typed persistence class (OMDB is runtime); its DTO tier already uses an inline-FQN fallback.
- **Kotlin `enumTypeName` collapse lacks the `isAbstract` leg** (`KotlinTypeMapper.kt`). After #259 the collapse keys on the *immediate* super having no declaring object (root-level), but — unlike the TS/C#/Python `resolveSharedEnumDecl` resolvers, which also require the super to be **abstract** — it does not check `isAbstract`. So a root-level *concrete* enum extended with own `@values` collapses onto the super's name on Kotlin (with a first-wins FQN dedupe that silently drops one member set under multiple extenders), where the other three ports emit an independent per-field enum. Pre-existing (the old `resolveSuperRoot` keying had the same hole); output-changing to fix (renames the collapsed enum for existing consumers), so it is a separate follow-up, not part of the #246/#259 PATCH. Surfaced by the Fable whole-branch review 2026-08-02.

## Design

### Part A — Kotlin table-generator import fix

Surgical fix mirroring the existing FK cross-package import machinery:
1. At `KotlinExposedTableGenerator.kt:586` and `:617`, keep the full `ClassName` from `KotlinTypeMapper.enumTypeName(field, entity)` rather than taking `.simpleName` immediately (still use `simpleName` for the `enumerationByName(... , <Name>::class)` token, but retain the `ClassName` for import collection).
2. In the import-assembly block (`:467-517`), add a pass over enum-typed fields — `entity.metaFields` plus `KotlinTphPlan.collectSubtypeFields` for the TPH path — that, for each resolved enum `ClassName cn`, adds `"${cn.packageName}.${cn.simpleName}"` to the import set **only when `cn.packageName.isNotEmpty() && cn.packageName != <table package>`**. Same-package enums add nothing → **byte-identical output for every existing single-package fixture/snapshot**.
3. Emit those imports in the existing `import $imp` loop alongside `crossPackageTableImports`.

**Alternatives rejected:** a unified all-type-reference import collector (larger, risks byte-identity now) and converting the generator to KotlinPoet (would eliminate the class of bug, but the generator hand-rolls strings for a documented Exposed reason — too big/risky here). Recorded so a future maintainer knows the surgical choice was deliberate.

### Part B — cross-port `extends` + `values` load error

A new **loader validation** in the shared loader (Java / Python / C# / TypeScript; Kotlin inherits the JVM loader), emitting a new error code **`ERR_ENUM_EXTENDS_VALUES_CONFLICT`** (name may be refined during implementation to match ledger conventions).

**Trigger condition (precise):** a `field.enum` node that (a) has an `extends` that resolves to a **shared, package-level abstract enum** — the same "abstract AND a direct child of the metadata root" condition the shared-enum codegen (`ResolveSharedEnumDecl` / `Fr019SharedEnum`) uses to decide collapse — AND (b) declares its own `values` (own-only check, per ADR-0039 own-accessor discipline).

**Explicitly still legal (must NOT fire):** own `values` on a field whose `extends` targets a **concrete, non-shared** enum (e.g. a projection extending `ActiveNpc.status`). That path already produces an independent per-object type with no collapse and no conflict.

The code is added to the shared error-code ledger (`packages/metadata/src/errors.ts`, `server/python/src/metaobjects/errors.py`, Java `ErrorCode`, `fixtures/conformance/ERROR-CODES.json`) so all five ports enforce it identically (ADR-0023: new validation, human-agreed, cross-port, conformance-gated).

## Testing

- **Bug 1 (Kotlin):** a new **two-package** cross-package-enum fixture (`acme::common` abstract enum + `acme::orders` / `acme::billing` entities extending it, each with `source.rdb`), asserting `import acme.common.RecordStatus` appears in the generated `OrderTable.kt` / `InvoiceTable.kt`, **plus a `KotlinCompilation` compile-gate** (the harness the #228 `KotlinExtractTierCollisionTest` already uses) that compiles the generated table + data class + enum together so the test fails on *any* variant of the missing import, not just a text mismatch. Kotlin currently has no compile-gate for generated table output; this closes that gap. A same-package no-churn assertion pins byte-identity.
- **Bug 2 (load error):** a cross-port loader-error conformance fixture (extends-a-shared-abstract-enum + own `values` → `ERR_ENUM_EXTENDS_VALUES_CONFLICT`) plus a **negative** fixture (extends-a-concrete-enum + own `values` → still valid) so the scoping cannot regress into over-rejection.

## Cross-language contract

- The new `ERR_ENUM_EXTENDS_VALUES_CONFLICT` is a cross-port error code (all five ports; conformance-gated).
- Bug 1 is Kotlin-only (the other ports are unaffected or immune, per Scope).
- **Byte-identity guardrail throughout:** nothing changes for a model without a cross-package shared enum. Every enum-import addition is gated on `packageName != table-package`; the load error fires only on the precise shared-abstract-plus-own-values condition.
