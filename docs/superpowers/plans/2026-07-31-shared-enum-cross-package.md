# Shared enum across packages (#246) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Fix the Kotlin table-generator dropping a cross-package shared-`field.enum` import (#246 Bug 1), and add a cross-port loader error when a `field.enum` both `extends` a shared package-level abstract enum and declares its own `values` (#246 Bug 2 — today silently dropped).

**Architecture:** Two independent halves. (A) Kotlin-only: `KotlinExposedTableGenerator` keeps the package-qualified `ClassName` and emits its cross-package import, mirroring the FK-import machinery already in the file. (B) Cross-port loader validation: a new `ERR_ENUM_EXTENDS_VALUES_CONFLICT` enforced in the Java/Python/C#/TypeScript loaders (Kotlin inherits the JVM loader), gated by a shared conformance fixture.

**Tech Stack:** Kotlin (codegen-kotlin, Exposed, `KotlinCompilation` test harness), Java/Python/C#/TypeScript loaders, the `fixtures/conformance/` corpus.

**Design spec:** `docs/superpowers/specs/2026-07-31-shared-enum-cross-package-design.md`

## Global Constraints

- **Byte-identical for any model without a cross-package shared enum.** The Kotlin enum-import addition fires ONLY when the enum's `ClassName.packageName` is non-empty and ≠ the table's package. The load error fires ONLY on the precise condition (own `values` + `extends` resolves to a shared root-level abstract enum). Over-rejection (firing on a concrete/non-shared super) is a task failure.
- **New error code name:** `ERR_ENUM_EXTENDS_VALUES_CONFLICT` (all ports, verbatim).
- **Cross-port scope:** the load error lands in all four loaders (Java, Python, C#, TypeScript); Kotlin needs NO loader change (inherits the JVM loader). The Kotlin table-import fix is Kotlin-only.
- **ADR-0039 own-accessor discipline:** read the field's own `values` with the own-only accessor already used at each validation site; read the super via the resolving super accessor.
- **Named constants:** reuse each port's existing enum/type constants (`EnumField.ATTR_VALUES`, `TYPE_METADATA`, etc.) — no inlined metamodel strings.
- **Git:** stage explicit paths only, NEVER `git add -A` (untracked `.serena/` must never be committed). Commit to branch `fix/246-shared-enum-cross-package`.
- **Public-repo hygiene:** fixtures use `acme::*` example packages; no private/other-project names, no absolute home paths in committed files or commit messages.
- Each task runs its port's own toolchain FOREGROUND/blocking and must be green before commit. NO `-T` on Maven.

---

### Task 1: Kotlin table-generator cross-package enum import (#246 Bug 1)

**Files:**
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt` (enum emit sites ~`:586-589` vanilla, ~`:617-620` TPH-fold; import assembly ~`:467-517`)
- Create fixture: `fixtures/codegen-conformance/enum-xpkg/input/meta.common.json`, `meta.orders.json`, `meta.billing.json`
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableCrossPackageEnumTest.kt` (new)

**Interfaces:**
- Consumes: `KotlinTypeMapper.enumTypeName(field, entity): ClassName?` (returns the package-qualified enum `ClassName`, walking to the shared abstract super); `KotlinTphPlan.collectSubtypeFields(...)`; the `KotlinCompilation` harness pattern from `KotlinExtractTierCollisionTest.kt` (its private `compile(outDir): KotlinCompilation.Result` helper).
- Produces: nothing consumed by later tasks (Kotlin-only, self-contained).

- [ ] **Step 1: Write the failing fixture.** Create a two-package (plus a common package) cross-package shared-enum model modeled on `fixtures/codegen-conformance/enum/input/meta.enum.json`:
  - `meta.common.json` — package `acme::common`, one root-level `field.enum` `RecordStatus` with `abstract: true`, `@values: ["DRAFT","ACTIVE","CLOSED"]`.
  - `meta.orders.json` — package `acme::orders`, `object.entity` `Order` with `source.rdb @table:"orders"`, an `identity.primary`, and a `field.enum` `status` with `extends: "acme::common::RecordStatus"` (no own values).
  - `meta.billing.json` — package `acme::billing`, `object.entity` `Invoice` with `source.rdb @table:"invoices"`, an `identity.primary`, and a `field.enum` `status` with `extends: "acme::common::RecordStatus"`.
  Validate each parses: `node -e "JSON.parse(require('fs').readFileSync('<f>'))"`.

- [ ] **Step 2: Write the failing test.** In `KotlinExposedTableCrossPackageEnumTest.kt`, load the `enum-xpkg` fixture directory, run `KotlinEntityGenerator` + `KotlinExposedTableGenerator` + `KotlinEnumEmitter` into a temp `outDir` (follow the generator-invocation + directory-walking pattern in `KotlinExtractTierCollisionTest.kt`), then assert:

```kotlin
// OrderTable.kt is generated in package acme.orders and references the shared enum:
val orderTable = readGenerated(outDir, "acme/orders/OrderTable.kt")
assertTrue(orderTable.contains("import acme.common.RecordStatus"),
    "OrderTable must import the cross-package shared enum")
assertTrue(orderTable.contains("RecordStatus::class"),
    "OrderTable still references the enum in enumerationByName")
val invoiceTable = readGenerated(outDir, "acme/billing/InvoiceTable.kt")
assertTrue(invoiceTable.contains("import acme.common.RecordStatus"))
// Compile-gate: the whole generated tree must compile (catches any import variant)
val result = compile(outDir)   // reuse the KotlinCompilation helper pattern
assertEquals(KotlinCompilation.ExitCode.OK, result.exitCode, result.messages)
```

- [ ] **Step 3: Run the test to verify it fails.** Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinExposedTableCrossPackageEnumTest` (NO `-T`). Expected: FAIL — the `import acme.common.RecordStatus` assertion fails and/or `KotlinCompilation` returns `COMPILATION_ERROR` with `Unresolved reference: RecordStatus`.

- [ ] **Step 4: Implement the fix.** In `KotlinExposedTableGenerator.kt`:
  - At the two enum-column emit sites (~`:586`, ~`:617`): retain the full `ClassName` returned by `KotlinTypeMapper.enumTypeName(field, entity)` in a local (e.g. `val enumCn = ... ?: error(...)`); use `enumCn.simpleName` for the `enumerationByName("...", LEN, ${enumCn.simpleName}::class)` token (unchanged output), and collect `enumCn` for import emission.
  - In the import-assembly block (~`:467-517`), add a pass over enum-typed fields — iterate `entity.metaFields` filtered to `EnumField`, plus (for the TPH path) `KotlinTphPlan.collectSubtypeFields(...)` — resolving each via `KotlinTypeMapper.enumTypeName(field, entity)`; for each resolved `cn`, add `"${cn.packageName}.${cn.simpleName}"` to the import set **only when** `cn.packageName.isNotEmpty() && cn.packageName != <the table's package>`.
  - Emit those imports in the existing `for (imp in ...) append("import $imp\n")` block alongside `crossPackageTableImports`.

- [ ] **Step 5: Run the new test — expect PASS.** Run: `cd server/java && mvn -pl codegen-kotlin test -Dtest=KotlinExposedTableCrossPackageEnumTest`. Expected: PASS (imports present + `KotlinCompilation.ExitCode.OK`).

- [ ] **Step 6: Run the full codegen-kotlin suite for byte-identity.** Run: `cd server/java && mvn -pl codegen-kotlin test`. Expected: all existing tests PASS unchanged (same-package enum fixtures — `enumFieldEmitsEnumerationByName`, `KotlinEnumConformanceTest` — emit byte-identical output because same-package enums add no import).

- [ ] **Step 7: Commit.**

```bash
git add server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableGenerator.kt \
        fixtures/codegen-conformance/enum-xpkg \
        server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinExposedTableCrossPackageEnumTest.kt
git commit -m "fix(#246): Kotlin table generator emits cross-package shared-enum import"
```

---

### Task 2: Add `ERR_ENUM_EXTENDS_VALUES_CONFLICT` to the cross-port error ledger

**Files:**
- Modify: `fixtures/conformance/ERROR-CODES.json`
- Modify: `server/typescript/packages/metadata/src/errors.ts`
- Modify: `server/python/src/metaobjects/errors.py`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/ErrorCode.java`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/util/ErrorMessageConstants.java`
- Modify: `server/csharp/MetaObjects/Errors.cs`
- Test: `server/typescript/packages/metadata/test/errors.test.ts` (existing, must stay green), `server/python/tests/unit/test_errors.py` (existing, must stay green)

**Interfaces:**
- Produces: the string `ERR_ENUM_EXTENDS_VALUES_CONFLICT` present in every port's error-code ledger; consumed by Tasks 3-7.

- [ ] **Step 1: Add the JSON ledger entry.** In `fixtures/conformance/ERROR-CODES.json`, add to the `codes` object (match the existing entry format):

```json
"ERR_ENUM_EXTENDS_VALUES_CONFLICT": "A field.enum both extends a shared package-level abstract enum and declares its own @values. One shared enum type has one member set — the own @values would be silently dropped in codegen. Remove the own @values to inherit the shared set, or extend a concrete (non-shared) enum instead."
```

- [ ] **Step 2: Add the TS entry.** In `errors.ts`, add a `//`-commented string literal `"ERR_ENUM_EXTENDS_VALUES_CONFLICT",` to the `ERROR_CODES` array (near the other enum-related codes).

- [ ] **Step 3: Add the Python entry.** In `errors.py`, add the enum member `ERR_ENUM_EXTENDS_VALUES_CONFLICT = "ERR_ENUM_EXTENDS_VALUES_CONFLICT"` to `class ErrorCode`.

- [ ] **Step 4: Add the Java entries (BOTH files).** In `ErrorCode.java` add `ERR_ENUM_EXTENDS_VALUES_CONFLICT,` to the enum. In `ErrorMessageConstants.java` add `public static final String ERR_ENUM_EXTENDS_VALUES_CONFLICT = "ERR_ENUM_EXTENDS_VALUES_CONFLICT";`.

- [ ] **Step 5: Add the C# entry.** In `Errors.cs` add `ERR_ENUM_EXTENDS_VALUES_CONFLICT,` to the `ErrorCode` enum.

- [ ] **Step 6: Run the ledger-completeness tests.** Run: `cd server/typescript && bun test packages/metadata/test/errors.test.ts` (the exact-bidirectional check — passes only because Steps 1 AND 2 are both done) and `cd server/python && uv run --extra integration pytest tests/unit/test_errors.py`. Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add fixtures/conformance/ERROR-CODES.json \
        server/typescript/packages/metadata/src/errors.ts \
        server/python/src/metaobjects/errors.py \
        server/java/metadata/src/main/java/com/metaobjects/ErrorCode.java \
        server/java/metadata/src/main/java/com/metaobjects/util/ErrorMessageConstants.java \
        server/csharp/MetaObjects/Errors.cs
git commit -m "feat(#246): register ERR_ENUM_EXTENDS_VALUES_CONFLICT in the cross-port error ledger"
```

---

### Task 3: TypeScript loader validation

**Files:**
- Modify: `server/typescript/packages/metadata/src/attr-schema-validate.ts` (Check 4, the `field.enum @values` content block, own-values branch ~`:304-350`, insertion inside the `if (Array.isArray(rawValues)) { … }` at ~`:312`)
- Test: `server/typescript/packages/metadata/test/enum-extends-values-conflict.test.ts` (new)

**Interfaces:**
- Consumes: `node.ownAttrs().get(FIELD_ATTR_VALUES)` (own values, already read here); `node.superData` (resolved super, `meta-data.ts:175`); `sup.isAbstract` (`:39`); `sup.parent` (`:392`); `TYPE_METADATA` constant; `ERROR_CODES`/the error-emitting helper this file already uses.
- Produces: TS loader rejects the conflict with `ERR_ENUM_EXTENDS_VALUES_CONFLICT`.

- [ ] **Step 1: Write the failing test.** In the new test, build two in-memory metadata roots via the existing loader test helpers (mirror the style in `packages/metadata/test/` enum tests):
  - CONFLICT case: package `acme`, root-level `field.enum Status { abstract: true, values: ["A","B"] }` + an `object.entity` with `field.enum status { extends: "acme::Status", values: ["A","B","C"] }`. Assert loading produces an error whose code is `ERR_ENUM_EXTENDS_VALUES_CONFLICT` on the `status` field node.
  - LEGAL case: an entity `field.enum` extending a CONCRETE (non-abstract or non-root) enum field AND declaring own values → assert NO `ERR_ENUM_EXTENDS_VALUES_CONFLICT` error.

- [ ] **Step 2: Run to verify it fails.** Run: `cd server/typescript && bun test packages/metadata/test/enum-extends-values-conflict.test.ts`. Expected: FAIL (no such error produced yet).

- [ ] **Step 3: Implement.** Inside the own-values branch of Check 4, after the existing content checks, add:

```ts
const sup = node.superData;
if (
  sup !== undefined &&
  sup.isAbstract === true &&
  sup.parent?.type === TYPE_METADATA
) {
  // #246: own @values on a field extending a shared package-level abstract enum
  // would be silently dropped by the shared-enum codegen collapse.
  pushError(ERROR_CODES.ERR_ENUM_EXTENDS_VALUES_CONFLICT, node /* + source loc as the file's other errors do */);
}
```
(Use this file's existing error-push mechanism and source-location plumbing — match the sibling `field.enum` errors in the same block.)

- [ ] **Step 4: Run the test — expect PASS.** Run: `cd server/typescript && bun test packages/metadata/test/enum-extends-values-conflict.test.ts`. Expected: PASS (both the conflict and the legal case).

- [ ] **Step 5: Run the metadata package suite.** Run: `cd server/typescript && bun test packages/metadata`. Expected: all green (no over-rejection of existing enum-extends fixtures, which have no own values).

- [ ] **Step 6: Commit.**

```bash
git add server/typescript/packages/metadata/src/attr-schema-validate.ts \
        server/typescript/packages/metadata/test/enum-extends-values-conflict.test.ts
git commit -m "feat(#246): TS loader rejects extends-shared-enum with own values"
```

---

### Task 4: Python loader validation

**Files:**
- Modify: `server/python/src/metaobjects/loader/validation_passes.py` (`_validate_enum_values`, own-values branch ~`:541-601`; add one import of `TYPE_METADATA` from `metaobjects.shared.base_types`)
- Test: `server/python/tests/loader/test_enum_extends_values_conflict.py` (new)

**Interfaces:**
- Consumes: `node.attr(FIELD_ATTR_VALUES)` (own values, already read at `:556`); `node.super_data`; `node.is_abstract` (used at `:445`); `node.parent`; `TYPE_METADATA`; `ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT`; the `errors.append(...)` mechanism this pass already uses.
- Produces: Python loader rejects the conflict.

- [ ] **Step 1: Write the failing test.** Mirror the TS test's two cases (conflict + legal) using the Python loader test helpers (see other tests under `server/python/tests/loader/`). Assert the conflict case yields an error with `code == ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT` and the legal (concrete-super + own values) case does not.

- [ ] **Step 2: Run to verify it fails.** Run: `cd server/python && uv run --extra integration pytest tests/loader/test_enum_extends_values_conflict.py`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add `from metaobjects.shared.base_types import TYPE_METADATA` (if not already imported). Inside the own-values branch of `_validate_enum_values`, add:

```python
sup = node.super_data
if sup is not None and sup.is_abstract and sup.parent is not None and sup.parent.type == TYPE_METADATA:
    # #246: own values + extends a shared package-level abstract enum -> silently dropped by codegen collapse
    errors.append(make_error(ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT, node))  # match this pass's error helper
```
(Use the exact error-append helper/signature `_validate_enum_values` already uses for its other enum errors, including source location.)

- [ ] **Step 4: Run the test — expect PASS.** Run: `cd server/python && uv run --extra integration pytest tests/loader/test_enum_extends_values_conflict.py`. Expected: PASS.

- [ ] **Step 5: Run the loader + codegen suites.** Run: `cd server/python && uv run --extra integration pytest tests/loader tests/codegen`. Expected: green (no over-rejection).

- [ ] **Step 6: Commit.**

```bash
git add server/python/src/metaobjects/loader/validation_passes.py \
        server/python/tests/loader/test_enum_extends_values_conflict.py
git commit -m "feat(#246): Python loader rejects extends-shared-enum with own values"
```

---

### Task 5: Java loader validation (also covers Kotlin)

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java` (`validateEnumNode`, own-values branch `:516-529`, insert before its `return`; reuse the file's own `isAbstract(MetaData)` helper at `:2669-2677`)
- Test: `server/java/metadata/src/test/java/com/metaobjects/loader/EnumExtendsValuesConflictTest.java` (new)

**Interfaces:**
- Consumes: `node.hasMetaAttr(EnumField.ATTR_VALUES, false)` (own values, already checked); `node.getSuperData()`; the private `isAbstract(MetaData)` helper (`:2669`); `MetaRoot` (imported `:21`); `ErrorMessageConstants.ERR_ENUM_EXTENDS_VALUES_CONFLICT` + `ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT`; the file's existing error-emit call used in `validateEnumNode`.
- Produces: Java (and therefore Kotlin) loader rejects the conflict.

- [ ] **Step 1: Write the failing test.** In `EnumExtendsValuesConflictTest.java`, load two in-memory models (conflict + legal) via the Java loader test helpers (mirror an existing `ValidationPhase` enum test). Assert the conflict model fails to load with `ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT`, and the legal (concrete-super) model loads without it.

- [ ] **Step 2: Run to verify it fails.** Run: `cd server/java && mvn -pl metadata test -Dtest=EnumExtendsValuesConflictTest`. Expected: FAIL.

- [ ] **Step 3: Implement.** Inside the own-values branch of `validateEnumNode`, before the `return`, add:

```java
MetaData sup = node.getSuperData();
if (sup != null && isAbstract(sup) && sup.getParent() instanceof MetaRoot) {
    // #246: own @values + extends a shared package-level abstract enum -> silently dropped by codegen collapse
    addError(node, ErrorMessageConstants.ERR_ENUM_EXTENDS_VALUES_CONFLICT,
             ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT /* + message text/loc as sibling errors do */);
}
```
(Match the exact error-emission call `validateEnumNode` already uses for `ERR_BAD_ATTR_VALUE`, passing both the message-prefix constant and the structured `ErrorCode`.)

- [ ] **Step 4: Run the test — expect PASS.** Run: `cd server/java && mvn -pl metadata test -Dtest=EnumExtendsValuesConflictTest`. Expected: PASS.

- [ ] **Step 5: Run the metadata suite.** Run: `cd server/java && mvn -pl metadata test`. Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/loader/ValidationPhase.java \
        server/java/metadata/src/test/java/com/metaobjects/loader/EnumExtendsValuesConflictTest.java
git commit -m "feat(#246): Java loader rejects extends-shared-enum with own values (covers Kotlin)"
```

---

### Task 6: C# loader validation

**Files:**
- Modify: `server/csharp/MetaObjects/Loader/ValidationPasses.cs` (`WalkEnumValues`, Pass 10, the `members is not null` block `:2287-2325`)
- Test: `server/csharp/MetaObjects.Tests/EnumExtendsValuesConflictTests.cs` (new)

**Interfaces:**
- Consumes: `field.EnumValues` (own values, already read); core `MetaData.SuperData` (`:209`), `MetaData.IsAbstract` (`:44`), `MetaData.Parent` (`:388`); `BaseTypes.TYPE_METADATA`; `ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT`; the `errors.Add(...)` mechanism this pass uses.
- Produces: C# loader rejects the conflict.

- [ ] **Step 1: Write the failing test.** In `EnumExtendsValuesConflictTests.cs`, load two models (conflict + legal) via the C# loader test helpers (mirror an existing `ValidationPasses` enum test). Assert the conflict model yields `ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT`, the legal model does not.

- [ ] **Step 2: Run to verify it fails.** Run: `cd server/csharp && dotnet test MetaObjects.Tests/MetaObjects.Tests.csproj --filter EnumExtendsValuesConflict`. Expected: FAIL.

- [ ] **Step 3: Implement.** Inside the `members is not null` block of `WalkEnumValues`, after the existing content checks, add:

```csharp
var sup = node.SuperData;
if (sup is not null && sup.IsAbstract && sup.Parent is {} p && p.Type == BaseTypes.TYPE_METADATA)
{
    // #246: own values + extends a shared package-level abstract enum -> silently dropped by codegen collapse
    errors.Add(new MetaError(ErrorCode.ERR_ENUM_EXTENDS_VALUES_CONFLICT, node /* + source loc as siblings do */));
}
```
(Match the exact `MetaError` construction `WalkEnumValues` already uses for its other enum errors.)

- [ ] **Step 4: Run the test — expect PASS.** Run: `cd server/csharp && dotnet test MetaObjects.Tests/MetaObjects.Tests.csproj --filter EnumExtendsValuesConflict`. Expected: PASS.

- [ ] **Step 5: Run the core + conformance test projects.** Run: `cd server/csharp && dotnet test MetaObjects.Tests/MetaObjects.Tests.csproj`. Expected: green.

- [ ] **Step 6: Commit.**

```bash
git add server/csharp/MetaObjects/Loader/ValidationPasses.cs \
        server/csharp/MetaObjects.Tests/EnumExtendsValuesConflictTests.cs
git commit -m "feat(#246): C# loader rejects extends-shared-enum with own values"
```

---

### Task 7: Shared conformance fixtures — cross-port gate

**Files:**
- Create: `fixtures/conformance/error-enum-extends-values-conflict/input/meta.enums.json` + `expected-errors.json`
- Create: `fixtures/conformance/enum-extends-concrete-with-own-values/input/meta.enums.json` + `expected.json`

**Interfaces:**
- Consumes: Tasks 2-6 (the code + all four loaders reject the conflict). Auto-discovered by every port's `FixtureDiscovery` — no runner code changes.
- Produces: the cross-port gate proving all ports agree (same code, same jsonPath, negative loads clean).

- [ ] **Step 1: Author the ERROR fixture.** In `error-enum-extends-values-conflict/`, model `input/meta.enums.json` on `fixtures/conformance/error-enum-duplicate-member/input/meta.enums.json`: a root-level `field.enum` `Status { abstract: true, @values:[...] }` plus an `object.entity` whose `field.enum status` has `extends` the shared `Status` AND its own `@values`. Write `expected-errors.json` mirroring `error-enum-duplicate-member/expected-errors.json`, with `code: "ERR_ENUM_EXTENDS_VALUES_CONFLICT"` and a `source.jsonPath` pointing at the offending `field.enum` node (compute the path the same way the sibling fixture does).

- [ ] **Step 2: Author the NEGATIVE (legal) fixture.** In `enum-extends-concrete-with-own-values/`, `input/meta.enums.json` = a CONCRETE enum field (e.g. an entity-nested `field.enum` that is NOT abstract-at-root) extended by another `field.enum` that declares its own differing `@values`; add `expected.json` (a happy-path fixture, mirror any existing `fixtures/conformance/enum-*/expected.json`) so it must load clean. Validate both JSON files parse.

- [ ] **Step 3: Run the conformance suites on all four ports.** Run FOREGROUND:
  - `cd server/typescript && bun test packages/conformance`
  - `cd server/python && uv run --extra integration pytest tests/conformance`
  - `cd server/java && mvn -pl metadata test -Dtest=ConformanceTest`
  - `cd server/csharp && dotnet test MetaObjects.Conformance.Tests/MetaObjects.Conformance.Tests.csproj`
  Expected: all green — the error fixture's code-set matches in every port (same jsonPath), and the negative fixture loads with zero errors under strict mode. If a port reports a different jsonPath, fix that port's error location (Task 3-6) to target the offending `field.enum` node, then re-run.

- [ ] **Step 4: Commit.**

```bash
git add fixtures/conformance/error-enum-extends-values-conflict \
        fixtures/conformance/enum-extends-concrete-with-own-values
git commit -m "test(#246): cross-port conformance fixtures for extends-shared-enum values conflict"
```

---

### Task 8: Docs + CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`
- Modify: the enum authoring docs that describe "reuse a constraint set across entities with an abstract `field.enum` + `extends`" (locate via `grep -rl "reuse a constraint set" docs/ spec/` and the enum feature doc under `docs/features/`)

- [ ] **Step 1: CHANGELOG.** Add a `## [Unreleased]` section (or append to it): (a) `#246` Kotlin table generator now emits the cross-package shared-`field.enum` import (was `Unresolved reference` under a cross-package shared enum) — Kotlin-only, byte-identical for same-package models, gated by a new `enum-xpkg` fixture + a `KotlinCompilation` compile-gate; (b) new cross-port loader error `ERR_ENUM_EXTENDS_VALUES_CONFLICT` — a `field.enum` that both `extends` a shared package-level abstract enum and declares its own `values` now fails to load (was silently dropped) in all five ports, gated by a shared conformance fixture. Note the C# materialized-enum cross-namespace sibling and the enum-PK-as-String issue are tracked separately.

- [ ] **Step 2: Authoring docs.** In the enum authoring guidance, clarify that (a) sharing one enum across packages via an abstract `field.enum` + `extends` now works cross-package, and (b) a child extending a shared abstract enum must NOT declare its own `values` (it is now a load error — the shared enum is one type with one member set; extend a concrete enum if you need an independent set).

- [ ] **Step 3: Commit.**

```bash
git add CHANGELOG.md <the enum doc file(s)>
git commit -m "docs(#246): CHANGELOG + enum authoring guidance for cross-package shared enums"
```

---

## Self-Review

**Spec coverage:** Bug 1 (Kotlin import) → Task 1; new error code → Task 2; the load error in all four loaders → Tasks 3-6 (Kotlin covered by Task 5); cross-port conformance (error + negative) → Task 7; byte-identity → pinned in Task 1 Step 6 (Kotlin) and by the negative fixture + each port's full-suite run; docs → Task 8. Out-of-scope items (C# materialized-enum, enum-PK, Python latent) are explicitly deferred in the spec and not tasked.

**Type/name consistency:** `ERR_ENUM_EXTENDS_VALUES_CONFLICT` used identically in Tasks 2-7. The detection predicate is the same across ports (own-values-present AND super resolves AND super is abstract AND super's parent is the metadata root), expressed with each port's own accessors (`superData`/`super_data`/`getSuperData()`/`SuperData`; `isAbstract`/`is_abstract`/`isAbstract(...)`/`IsAbstract`; parent-is-root via `instanceof MetaRoot` or `parent.type == TYPE_METADATA`). The Kotlin fix consumes only `KotlinTypeMapper.enumTypeName` (existing).

**Ordering:** Task 1 (Kotlin, independent) first — the urgent filed bug. Task 2 (ledger) before Tasks 3-6 (each loader references the code). Tasks 3-6 (each port, independently testable via a port-local unit test — no shared fixture yet, so no cross-port breakage). Task 7 (shared fixtures) LAST among the Part-B tasks, once all four loaders reject the conflict, so the shared corpus is green when it lands. Task 8 docs last.

**Byte-identity guardrail:** every enum-import addition (Task 1) is gated on `packageName != table-package`; the load error (Tasks 3-6) fires only on the precise shared-abstract-root condition and is proven not to over-reject by the negative fixture (Task 7) + each port's full-suite run.
