> **Superseded by `metaforge/docs/superpowers/plans/2026-05-19-java-h3b2-conformance-harness.md` (private). This file is the original draft and is no longer the source of truth.**

# Java Conformance Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Java conformance harness that runs the shared `fixtures/conformance/` corpus as `mvn test`, plus port the five loader-side validation passes that the corpus depends on. After this plan: Java has byte-identical-to-TS conformance with all 43 fixtures green and a ledger maintained the same way C# does it.

**Architecture:** Two oracles. The TypeScript implementation at `typescript/packages/metadata/src/` and `typescript/packages/conformance/src/` is the **behavior oracle** (Tier 1: byte-identical output, identical error-codes/vocabularies, identical pass semantics). The C# port at `csharp/MetaObjects.Conformance.Tests/` is the **shape oracle** for the harness itself — a proven, faithful translation of the TS conformance engine that the Java port mirrors. Java's already-shipped Loader / parser / serializer / `MetaDataSource` pipeline (H3a + H3b-1) is the foundation — this plan does NOT touch them.

**Tech Stack:** Java 17+, JUnit 5 (`@ParameterizedTest` + `@MethodSource` for the auto-discovering theories), Gson (already used by `CanonicalJsonSerializer`/`CanonicalJsonParser`), Maven (the existing `java/` multi-module build).

---

## Background — current Java state (from the H3b-1 / H3a survey)

What Java already has (do NOT re-port):
- **`com.metaobjects.loader.parser.json.CanonicalJsonParser`** — full canonical JSON reader (`type.subType` fused-key format), 100% registry-driven, handles typed attr child nodes + stringarray desugar. ~688 lines.
- **`com.metaobjects.io.json.CanonicalJsonSerializer`** — canonical JSON writer; `canonicalSerialize(MetaData)` and `canonicalSerializeEffective(MetaData)`. Tests claim byte-identical to TS — **verify this with the first happy-path fixture once the harness lands**; do not assume.
- **`com.metaobjects.loader.MetaDataLoader`** + **`MetaDataSource`** / **`InMemoryMetaDataSource`** / **`URIMetaDataSource`** + **`FileMetaDataLoader`** + **`FileMetaDataSources`** (H3a) — multi-source load pipeline. **All loads route through `load(List<MetaDataSource>)`.**
- **Super resolution** — H3a wired this in; cross-file `extends:` resolves correctly.
- **`com.metaobjects.registry.MetaDataRegistry`** + **`MetaDataTypeProvider`** SPI. Core types registered via SPI (`META-INF/services`).

What Java does NOT have (this plan adds):
- The **5 loader validation passes** (subtype rules / dataGrid sort field / filterable-no-index / origin paths / attr-schema). Java has a separate constraint framework but the TS passes are missing — the corpus's `error-*` and `warning-*` fixtures cannot pass without them.
- A **conformance harness** at all — no `FixtureDiscovery`, no `ConformanceAdapter`, no fixture-driven `@ParameterizedTest`, no expected-failures ledger.
- The **capability script execution** path (`Result`, `Navigator`, `CapabilityBinding`) — needed for the one fixture (`extends-abstract-base`) that ships a `script.json`.

This plan builds those in three vertical slices, each ending with `mvn test` green and the ledger maintained empirically.

---

## Tier discipline (the same rules that governed the C# port)

- **Tier 1 — Invariant, never change:** metamodel vocabulary, canonical wire format, error codes, loader pipeline semantics, validation-pass semantics (per the TS source files).
- **Tier 2 — Idiomatic, make native to Java:** camelCase method names (not PascalCase like C#), `RuntimeException` subclasses for parser/loader errors, `Optional<T>` vs C#'s `T?`, JUnit 5 idioms (`@ParameterizedTest`/`@MethodSource`/`MethodSource` returning `Stream<Arguments>`), Java records for value carriers, `Collections.unmodifiableList`/`Map` for the read-only-view contract.
- **Tier 3 — Free:** internal helper shape, file layout under `loader/validation/` vs `loader/validation_pass/` etc., per-fixture parallelism (probably leave off; the corpus is tiny).

The corpus is the oracle — when a fixture goes red the port is wrong, never the fixture. Never edit a `fixtures/conformance/<name>/expected*.json` file to make tests pass. If a fixture's expected output appears stale, stop and escalate.

---

## Two-oracle porting strategy

Every task below names **three sources** to read:
1. **TS oracle** — the authoritative behavior spec (TypeScript file at `typescript/packages/metadata/src/...` or `typescript/packages/conformance/src/...`).
2. **C# proven port** — the corresponding C# file at `csharp/MetaObjects/...` or `csharp/MetaObjects.Conformance.Tests/...` — a working faithful translation that flushed out the porting decisions (numeric range checks, scalar-equality edge cases, `expected-warnings.json` handling, etc.). Use it to skip pitfalls the TS-only read would re-discover.
3. **Existing Java code** — the H3a/H3b-1 surface to call into.

The C# port is on `main`; reference it freely. The C# plan at `docs/superpowers/plans/2026-05-19-csharp-conformance-port.md` documents the audit trail (deliberate divergences, e.g. checking warnings) — preserve those decisions in Java.

---

## File Structure

All new code goes under `java/metadata/`. Validation passes live alongside the loader; the conformance harness lives under `src/test/java/`. No new Maven module needed.

```
java/metadata/
├── pom.xml                                                          # modify: add JUnit 5 + Gson test deps if missing
└── src/
    ├── main/java/com/metaobjects/loader/validation/
    │   ├── SubtypeRulesValidator.java                              # Slice 1 Task 1.1 — port of subtype-rules.ts
    │   ├── DataGridSortFieldValidator.java                         # Slice 1 Task 1.2 — port of validateDataGridSortFields
    │   ├── FilterableHasIndexValidator.java                        # Slice 1 Task 1.3 — port of validateFilterableHasIndex
    │   ├── OriginPathValidator.java                                # Slice 1 Task 1.4 — port of validateOriginPaths
    │   ├── AttrSchemaValidator.java                                # Slice 1 Task 1.5 — port of attr-schema-validate.ts
    │   └── ValidationResult.java                                   # small record carrying errors + warnings
    └── test/java/com/metaobjects/conformance/
        ├── CorpusRoot.java                                          # Slice 2 Task 2.1
        ├── Fixture.java                                             # record — Slice 2 Task 2.2
        ├── FixtureDiscovery.java                                    # Slice 2 Task 2.2
        ├── OperationScript.java                                     # Slice 2 Task 2.3 — ParseExpectedErrors + ParseOperationScript
        ├── FixtureLint.java                                         # Slice 2 Task 2.4
        ├── ConformanceAdapter.java                                  # Slice 2 Task 2.5 — LoadFixture + (Slice 3) Navigate/Invoke
        ├── ExpectedFailures.java                                    # Slice 2 Task 2.6 — ledger classifier
        ├── ConformanceTest.java                                     # Slice 2 Task 2.7 — the @ParameterizedTest pair
        ├── Result.java                                              # Slice 3 Task 3.1 — NormalizedResult + ResultsEqual
        ├── Navigator.java                                           # Slice 3 Task 3.2
        ├── CapabilityBinding.java                                   # Slice 3 Task 3.3
        └── resources/
            └── conformance-expected-failures.json                  # Slice 2 Task 2.6 — the ledger (loaded via classpath)
```

**Ledger placement note:** unlike C# (`<None CopyToOutputDirectory>`), Java loads JSON resources from the classpath. Put the ledger under `src/test/resources/` so it lands on `target/test-classes/` automatically. `CorpusRoot.PATH` resolves the corpus path on the filesystem (walking up from `target/test-classes/` or a `METAOBJECTS_CONFORMANCE_CORPUS` env override — same pattern as C#).

---

## Reference map

| Source file (TS oracle) | Proven C# port | New Java file |
|---|---|---|
| `typescript/packages/metadata/src/subtype-rules.ts` | `csharp/MetaObjects/Loader/ValidationPasses.cs` (ValidateSubtypeRules) | `loader/validation/SubtypeRulesValidator.java` |
| `typescript/packages/metadata/src/loader/validation-passes.ts` (3 passes) | `csharp/MetaObjects/Loader/ValidationPasses.cs` (rest) | `loader/validation/{DataGridSortField,FilterableHasIndex,OriginPath}Validator.java` |
| `typescript/packages/metadata/src/attr-schema-validate.ts` | `csharp/MetaObjects/Loader/ValidationPasses.cs` (ValidateAttrSchema) | `loader/validation/AttrSchemaValidator.java` |
| `typescript/packages/conformance/src/fixture.ts` | `csharp/MetaObjects.Conformance.Tests/FixtureDiscovery.cs` | `conformance/FixtureDiscovery.java` + `Fixture.java` |
| `typescript/packages/conformance/src/operation-script.ts` | `csharp/MetaObjects.Conformance.Tests/OperationScript.cs` | `conformance/OperationScript.java` |
| `typescript/packages/conformance/src/fixture-lint.ts` | `csharp/MetaObjects.Conformance.Tests/FixtureLint.cs` | `conformance/FixtureLint.java` |
| `typescript/packages/conformance/src/adapter.ts` + `test/conformance/adapter.ts` | `csharp/MetaObjects.Conformance.Tests/ConformanceAdapter.cs` | `conformance/ConformanceAdapter.java` |
| `typescript/packages/conformance/src/expected-failures.ts` | `csharp/MetaObjects.Conformance.Tests/ExpectedFailures.cs` | `conformance/ExpectedFailures.java` |
| `typescript/packages/conformance/src/runner.ts` + `typescript/packages/metadata/test/conformance.test.ts` | `csharp/MetaObjects.Conformance.Tests/ConformanceTests.cs` | `conformance/ConformanceTest.java` |
| `typescript/packages/conformance/src/result.ts` | `csharp/MetaObjects.Conformance.Tests/Result.cs` | `conformance/Result.java` |
| `typescript/packages/metadata/test/conformance/navigator.ts` | `csharp/MetaObjects.Conformance.Tests/Navigator.cs` | `conformance/Navigator.java` |
| `typescript/packages/metadata/test/conformance/binding.ts` | `csharp/MetaObjects.Conformance.Tests/CapabilityBinding.cs` | `conformance/CapabilityBinding.java` |

For each task below: open the TS file, open the C# file, read both, then translate to idiomatic Java.

---

## Slice 0 — Pre-flight (read-only sanity checks)

Before slicing in: verify the assumptions this plan depends on. Do NOT skip — a wrong assumption here forces backtracking later.

### Task 0.1: Confirm the Java foundation works

**Files:** none (read-only)

- [ ] **Step 1: Confirm baseline `mvn test` is green on `java/metadata` and `java/core`**

Run: `cd /home/doug/Development/metaobjects/java && mvn -pl metadata,core test`
Expected: BUILD SUCCESS for both modules.

If `metadata`/`core` tests fail at baseline, **stop and escalate** — this plan assumes the existing pipeline works. The wider Java build may have unrelated failures (the survey noted `codegen-base` has unrelated failures); only the `metadata` and `core` modules matter here.

- [ ] **Step 2: Confirm the canonical serializer is byte-identical to the TS oracle on at least one fixture**

The C# port verified this empirically before relying on it. Java's `CanonicalJsonSerializer` tests claim byte parity — verify by writing a throwaway main or a one-off test in `java/metadata/src/test/java/com/metaobjects/io/json/`:

```java
@Test
void canonicalSerialize_matches_ts_oracle_for_loader_basic_single_entity() throws Exception {
    var corpusRoot = /* walk up to fixtures/conformance/ from target/test-classes */;
    var fixtureDir = corpusRoot.resolve("loader-basic-single-entity");
    var inputFile = Files.list(fixtureDir.resolve("input"))
        .filter(p -> p.toString().endsWith(".json")).findFirst().orElseThrow();
    var loader = new FileMetaDataLoader();
    loader.load(List.of(new URIMetaDataSource(inputFile.toUri())));
    var actual = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
    var expected = Files.readString(fixtureDir.resolve("expected.json"));
    assertEquals(expected.replace("\r\n", "\n"), actual);
}
```

Run it. If it passes, **the byte-identical contract holds** — proceed to Slice 1. Delete the throwaway test after; the conformance harness will cover it permanently in Slice 2.

If it FAILS with a whitespace/escaping/number-formatting diff, the serializer is NOT byte-identical despite the H3b-1 claim. **Stop this plan** and open a focused investigation — fixing the serializer is a prerequisite, not a slice of this plan. (Likely diagnostic: Gson's `setPrettyPrinting` indent vs the corpus's 2-space, or `HtmlEscaping` mode, or trailing-newline handling.)

- [ ] **Step 3: Confirm Gson + JUnit 5 are already on the test classpath**

Run: `cd /home/doug/Development/metaobjects/java/metadata && mvn dependency:tree -DskipTests | grep -E "(gson|junit-jupiter)" | head -10`

Expected: both `com.google.code.gson:gson` and `org.junit.jupiter:junit-jupiter` appear. They almost certainly do (the existing parser/serializer use Gson; H3b tests presumably use JUnit 5). If either is missing, add the missing dep to `java/metadata/pom.xml` as a `test`-scope dependency before continuing.

- [ ] **Step 4: Note the JUnit version**

Run: `cd /home/doug/Development/metaobjects/java/metadata && mvn dependency:tree -DskipTests | grep -E "junit-jupiter"`

Record: JUnit version (e.g. 5.10.x). Use the matching `@ParameterizedTest` + `@MethodSource` API throughout this plan.

If JUnit 4 is in use instead of 5, **stop and escalate** — `@ParameterizedTest` is a JUnit 5 feature; downgrading to JUnit 4's `@Parameterized` is doable but the test class shape differs and this plan would need a rewrite of every Slice-2 task.

---

## Slice 1 — Validation passes

Goal: port the five loader validation passes the TS reference runs after super resolution. Wire them into `MetaDataLoader.load(List<MetaDataSource>)`. **After Slice 1, `mvn test` still passes** because the existing tests don't exercise these passes — the proof that they work comes in Slice 2 when the conformance harness lights up the `error-*` and `warning-*` fixtures.

### Task 1.1: ValidationResult record

**Files:**
- Create: `java/metadata/src/main/java/com/metaobjects/loader/validation/ValidationResult.java`

- [ ] **Step 1: Write the file**

```java
package com.metaobjects.loader.validation;

import java.util.List;

/** Errors + warnings produced by a single validation pass. */
public record ValidationResult(List<String> errors, List<String> warnings) {
    public static final ValidationResult EMPTY = new ValidationResult(List.of(), List.of());
}
```

(If the Java codebase already has an idiomatic `LoadError` carrier with a stable `code` field — likely from H3b — use that instead of raw `List<String>` for `errors`. Read `MetaDataLoader.load` to see what its `LoadResult` accumulator uses; match it. The TS pushes `ParseError` instances with `.code` fields; the C# uses a `MetaError` record. Java equivalent is most likely a `LoadError` or `MetaError` class — match the existing convention.)

- [ ] **Step 2: Confirm the project compiles**

Run: `cd /home/doug/Development/metaobjects/java/metadata && mvn -DskipTests compile`
Expected: BUILD SUCCESS.

- [ ] **Step 3: Commit**

```bash
cd /home/doug/Development/metaobjects && git add java/metadata/src/main/java/com/metaobjects/loader/validation/ && git commit -m "feat(java): ValidationResult carrier for loader validation passes

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.2: SubtypeRulesValidator

**Files:**
- Create: `java/metadata/src/main/java/com/metaobjects/loader/validation/SubtypeRulesValidator.java`
- Test: `java/metadata/src/test/java/com/metaobjects/loader/validation/SubtypeRulesValidatorTest.java`

**Read first:**
- TS oracle: `typescript/packages/metadata/src/subtype-rules.ts` (~58 lines)
- C# port: `csharp/MetaObjects/Loader/ValidationPasses.cs` — the `ValidateSubtypeRules` method

Behavior to port (Tier 1):
- Recursive walk over `OwnChildren()` of every node.
- For object nodes only: compute `hasPrimary` from EFFECTIVE `Children()` (uses inherited identities via super chain).
- `value`-object + has-primary → error code `ERR_SUBTYPE_RULE_VIOLATION` with message `value object '<fqn>' must not have a primary identity (use subType: "entity" for records with identity)`.
- `entity`-object + no-primary + NOT `isAbstract` → warning string `entity object '<fqn>' has no primary identity (add an identity child or mark @isAbstract: true)`.
- `base`-subtype objects: no rule.
- The walk recurses unconditionally (into ALL nodes, not just objects).

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.loader.validation;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class SubtypeRulesValidatorTest {
    // Build a small tree by hand using the existing MetaData factory APIs.
    // Read e.g. CanonicalJsonParserTest to see how tests construct trees.

    @Test
    void value_object_with_primary_identity_is_an_error() {
        // Construct: a metadata root with a value object that has an identity.primary child.
        // Call SubtypeRulesValidator.validate(root).
        // Assert exactly one error, error code ERR_SUBTYPE_RULE_VIOLATION, no warnings.
    }

    @Test
    void entity_object_without_primary_identity_is_a_warning_unless_abstract() {
        // Construct: a metadata root with an entity object lacking identity.primary, not abstract.
        // Call SubtypeRulesValidator.validate(root).
        // Assert exactly one warning matching the "no primary identity" text, no errors.
        // Then mark the object abstract; assert zero warnings.
    }

    @Test
    void entity_with_primary_identity_inherited_via_extends_satisfies_the_rule() {
        // Construct: Base (entity) with identity.primary; Sub (entity) extends Base with no own identity.
        // Resolve supers (or set super directly), then call SubtypeRulesValidator.validate(root).
        // Assert zero warnings — inherited identity counts (use effective Children()).
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /home/doug/Development/metaobjects/java/metadata && mvn -pl metadata test -Dtest=SubtypeRulesValidatorTest`
Expected: FAIL (compile error — `SubtypeRulesValidator` does not exist).

- [ ] **Step 3: Implement `SubtypeRulesValidator.java`**

```java
package com.metaobjects.loader.validation;

import com.metaobjects.MetaData;
// ... (the rest of the imports you need — MetaObject, MetaIdentity, constants)

public final class SubtypeRulesValidator {
    private SubtypeRulesValidator() {}

    /**
     * Cross-language subtype rules for object subtypes — port of
     * typescript/packages/metadata/src/subtype-rules.ts.
     *
     * - value objects MUST NOT have a primary identity (error: ERR_SUBTYPE_RULE_VIOLATION).
     * - entity objects SHOULD have a primary identity unless @isAbstract (warning).
     * - base objects have no rule.
     */
    public static ValidationResult validate(MetaData root) {
        var errors = new java.util.ArrayList<String>();   // or LoadError if that's the project type
        var warnings = new java.util.ArrayList<String>();
        walk(root, errors, warnings);
        return new ValidationResult(errors, warnings);
    }

    private static void walk(MetaData node, java.util.List<String> errors, java.util.List<String> warnings) {
        // Translate from subtype-rules.ts walk() exactly:
        //  1. If node.getType().equals(TYPE_OBJECT):
        //       boolean hasPrimary = node.children().stream()
        //           .anyMatch(c -> c.getType().equals(TYPE_IDENTITY)
        //                      && c.getSubType().equals(IDENTITY_SUBTYPE_PRIMARY));
        //       if (OBJECT_SUBTYPE_VALUE.equals(node.getSubType()) && hasPrimary) {
        //           errors.add(new LoadError("value object '" + node.fqn() + "' must not have a primary identity ...",
        //                                    ErrorCode.ERR_SUBTYPE_RULE_VIOLATION));
        //       } else if (OBJECT_SUBTYPE_ENTITY.equals(node.getSubType()) && !hasPrimary && !node.isAbstract()) {
        //           warnings.add("entity object '" + node.fqn() + "' has no primary identity ...");
        //       }
        //  2. Recurse into node.ownChildren() (NOT children() — TS walks ownChildren).
    }
}
```

The exact method names on Java `MetaData` (`children()` vs `getChildren()`, `subType()` vs `getSubType()`, `ownChildren()` vs `getOwnChildren()`, `fqn()` vs `getFqn()`, `isAbstract()` vs `getIsAbstract()`) depend on the existing Java conventions — match them. Use `Constants.TYPE_OBJECT` etc. for the metamodel strings (they exist in Java; if the constants class has a different name like `MetaDataConstants`, use that).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /home/doug/Development/metaobjects/java/metadata && mvn -pl metadata test -Dtest=SubtypeRulesValidatorTest`
Expected: PASS, 3 tests green.

- [ ] **Step 5: Commit**

```bash
cd /home/doug/Development/metaobjects && git add java/metadata && git commit -m "feat(java): subtype-rules validation pass

Port of typescript/packages/metadata/src/subtype-rules.ts.
Value objects with primary identity → ERR_SUBTYPE_RULE_VIOLATION.
Entity objects without primary identity (and not abstract) → warning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.3: DataGridSortFieldValidator

**Files:**
- Create: `java/metadata/src/main/java/com/metaobjects/loader/validation/DataGridSortFieldValidator.java`
- Test: `java/metadata/src/test/java/com/metaobjects/loader/validation/DataGridSortFieldValidatorTest.java`

**Read first:**
- TS oracle: `typescript/packages/metadata/src/loader/validation-passes.ts` — the `validateDataGridSortFields` function (~30 lines).
- C# port: `csharp/MetaObjects/Loader/ValidationPasses.cs` — the `ValidateDataGridSortFields` method.

Behavior to port (Tier 1):
- Iterate root's `ownChildren()` filtered to `TYPE_OBJECT`.
- For each object: build `fieldNames` from EFFECTIVE `children()` filtered to `TYPE_FIELD`; check every effective `layout` child whose subType is `dataGrid` for its `@defaultSortField` attribute. When `defaultSortField` is a string and not in `fieldNames`, error code `ERR_BAD_DEFAULT_SORT_FIELD` with message `dataGrid layout "<layoutName>" on entity "<entityName>" has @defaultSortField "<value>" but no such field exists on "<entityName>". Available fields: <comma-joined list>`.

- [ ] **Step 1: Write the failing test**

Two tests: (a) a layout with `@defaultSortField` pointing to a non-existent field → one error; (b) a layout with `@defaultSortField` pointing to a real (inherited) field → zero errors. Use the `error-data-grid-bad-sort-field` corpus fixture's input as a reference for the metadata shape (read it: `cat fixtures/conformance/error-data-grid-bad-sort-field/input/*.json`).

- [ ] **Step 2: Run it to verify it fails**

Run: `mvn -pl metadata test -Dtest=DataGridSortFieldValidatorTest`. Expected: FAIL (class missing).

- [ ] **Step 3: Implement `DataGridSortFieldValidator.java`**

Match the C# `ValidateDataGridSortFields` structure: a single `public static ValidationResult validate(MetaData root)` (warnings always empty for this pass). Loop nesting is exactly as the TS function.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `mvn -pl metadata test -Dtest=DataGridSortFieldValidatorTest`. Expected: PASS, 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add java/metadata && git commit -m "feat(java): dataGrid @defaultSortField validation pass

Port of validateDataGridSortFields from
typescript/packages/metadata/src/loader/validation-passes.ts.
Unknown sort field → ERR_BAD_DEFAULT_SORT_FIELD.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.4: FilterableHasIndexValidator

**Files:**
- Create: `java/metadata/src/main/java/com/metaobjects/loader/validation/FilterableHasIndexValidator.java`
- Test: `java/metadata/src/test/java/com/metaobjects/loader/validation/FilterableHasIndexValidatorTest.java`

**Read first:**
- TS oracle: `typescript/packages/metadata/src/loader/validation-passes.ts` — the `validateFilterableHasIndex` function.
- C# port: `csharp/MetaObjects/Loader/ValidationPasses.cs` — the `ValidateFilterableHasIndex` method.

Behavior to port (Tier 1):
- Iterate root's `ownChildren()` filtered to `TYPE_OBJECT`.
- For each object: build `indexedFieldNames` from EFFECTIVE identity children's `@fields` attribute (note: `@fields` may arrive as a `String` or a `List<String>` — the parser desugars bare strings into single-element lists for `stringArray`-declared attrs; handle BOTH paths defensively, as the C# port does).
- For each effective field with `@filterable: true` (boolean), skip if `@db.indexed: true` OR if its name is already in `indexedFieldNames`; otherwise emit a warning string `[filterable-without-index] field "<entityName>.<fieldName>" has @filterable: true but is not part of any identity. Filtering on this field will sequential-scan. Add @db.indexed: true to the field (when supported), or remove @filterable: true.`

**The exact warning text matters** — `warning-filterable-no-index/expected-warnings.json` is a literal byte match.

- [ ] **Step 1: Write the failing test**

Two tests using fixtures `warning-filterable-no-index` (expects exactly one warning) and `loader-filterable-on-indexed-no-warning` (expects zero warnings — the filterable field IS part of an identity).

- [ ] **Step 2: Run it to verify it fails** — Expected: class missing.

- [ ] **Step 3: Implement**

Returns `ValidationResult(errors=[], warnings=...)`. Match the warning string EXACTLY (load `fixtures/conformance/warning-filterable-no-index/expected-warnings.json` and compare to your produced output to confirm).

- [ ] **Step 4: Run the tests to verify they pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add java/metadata && git commit -m "feat(java): filterable-without-index drift warning pass

Port of validateFilterableHasIndex from
typescript/packages/metadata/src/loader/validation-passes.ts.
@filterable fields not part of an identity and not @db.indexed → warning.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.5: OriginPathValidator

**Files:**
- Create: `java/metadata/src/main/java/com/metaobjects/loader/validation/OriginPathValidator.java`
- Test: `java/metadata/src/test/java/com/metaobjects/loader/validation/OriginPathValidatorTest.java`

**Read first:**
- TS oracle: `typescript/packages/metadata/src/loader/validation-passes.ts` — the `validateOriginPaths` function PLUS the four private helpers `_findObject`, `_findField`, `_findRelationship`, `_validateFromPath`, `_validateViaPath`. Read all of them.
- C# port: `csharp/MetaObjects/Loader/ValidationPasses.cs` — the `ValidateOriginPaths` method and its helpers.

Behavior to port (Tier 1):
- Walk root's own object children; for each object's OWN field children, for each OWN origin child:
  - `passthrough`: `@from` required (split on the first `.` into `entity.field`; validate both entity exists in root's own children and field exists on entity via effective children). Then optional `@via` — when present, validate via the relationship chain.
  - `aggregate`: `@of` required (same entity.field validation, label is `origin.aggregate.@of`). Then `@via` REQUIRED (aggregates need a relationship path); when missing, separate error message `origin.aggregate on <obj>.<field>: missing @via (aggregates require a relationship path).`
- `_validateViaPath`: split on `.`; first segment is entity name, rest are relationship names. Walk each relationship via its `@objectRef` to the next entity. Errors on: malformed path (`< 2` segments), missing entity, missing relationship, relationship with no `@objectRef`, `@objectRef` pointing to nonexistent entity.
- All errors: code `ERR_INVALID_ORIGIN`. Match the TS error messages exactly — the corpus's `error-origin-*` fixtures don't check messages, but matching aids diagnosability.

This is the longest validator port — ~280 lines in the TS, similar in C#. Mirror the helper-method decomposition exactly: `findObject` / `findField` / `findRelationship` (private statics), `validateFromPath` (used by both passthrough and aggregate with different labels), `validateViaPath`.

- [ ] **Step 1: Write the failing test**

Three tests covering the corpus's three origin error fixtures (`error-origin-bad-via-path`, `error-origin-bad-aggregate-fn` — note this one is actually caught by `AttrSchemaValidator` via `allowedValues`, not here; verify by reading the TS), plus a happy-path test for `origin-passthrough-simple` (expects zero errors).

- [ ] **Step 2: Run it to verify it fails** — Expected: class missing.

- [ ] **Step 3: Implement**

Returns `ValidationResult(errors=..., warnings=[])`. The five private helpers are the bulk of the implementation; port them verbatim. C# also has them — cross-reference both.

- [ ] **Step 4: Run the tests to verify they pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add java/metadata && git commit -m "feat(java): origin-path validation pass

Port of validateOriginPaths from
typescript/packages/metadata/src/loader/validation-passes.ts.
passthrough.@from / aggregate.@of / @via path verification.
All errors → ERR_INVALID_ORIGIN.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.6: AttrSchemaValidator

**Files:**
- Create: `java/metadata/src/main/java/com/metaobjects/loader/validation/AttrSchemaValidator.java`
- Test: `java/metadata/src/test/java/com/metaobjects/loader/validation/AttrSchemaValidatorTest.java`

**Read first:**
- TS oracle: `typescript/packages/metadata/src/attr-schema-validate.ts` (~190 lines).
- C# port: `csharp/MetaObjects/Loader/ValidationPasses.cs` — the `ValidateAttrSchema` method.

Behavior to port (Tier 1):
- Recursive walk; for each node, fetch `registry.attrsOf(node.getType(), node.getSubType())`. If empty, skip.
- **Check 1 (required attrs present):** use EFFECTIVE `attrs()` (an inherited required attr counts as satisfied). Missing → `ERR_MISSING_REQUIRED_ATTR` with message `<nodeLabel> is missing required attribute '@<name>'`.
- **Check 2 (declared own attrs are well-typed):** iterate OWN `ownAttrs()`. For each attr whose name matches a schema entry with `valueType` set, verify the runtime value type matches. `valueMatchesType` mapping: `string`/`class`/`properties` → `String`; `int`/`long`/`double` → numeric (Java `Long` or `Double` in Java's AttrValue model — confirm by reading Java's `MetaAttribute.getValue()` return type); `boolean` → `Boolean`; `stringarray` → `List<String>` with all-string elements; `base` or absent → accept anything. Mismatch → `ERR_BAD_ATTR_VALUE` with message `<nodeLabel> attribute '@<name>' must be of type '<valueType>' but got <runtimeType>`. On type mismatch SKIP the allowedValues check for this attr.
- **Check 3 (allowedValues membership):** for declared own attrs with non-empty `allowedValues`, the value must be a member. Otherwise → `ERR_BAD_ATTR_VALUE` with message `<nodeLabel> attribute '@<name>' has value '<value>' which is not one of the allowed values: <comma-joined list>`.
- **Undeclared attrs are NOT flagged** — open policy. `ERR_UNKNOWN_ATTR` is NEVER emitted by this pass (it comes from the parser for non-`@`-prefixed unknown keys, which Java's parser handles separately).
- Returns `ValidationResult(errors=..., warnings=[])` — warnings always empty.

The C# port took a fix round to get this right (the first draft incorrectly flagged undeclared attrs). The TS reference is unambiguous: undeclared = open policy. Get this right on the first pass by reading the TS file's header comment carefully.

- [ ] **Step 1: Write the failing test**

Four tests covering: required-attr-missing (`error-attr-missing-required`), wrong-type (`error-attr-wrong-type`), bad-allowed-value (`error-attr-bad-allowed-value`, e.g. `@agg: "foo"` not in the aggregate-function allow-list), and a positive test that an undeclared `@-attr` does NOT produce an error (`attr-default-polymorphic` or any happy-path fixture).

- [ ] **Step 2: Run it to verify it fails** — Expected: class missing.

- [ ] **Step 3: Implement**

`public static ValidationResult validate(MetaData root, MetaDataRegistry registry)`. Read both the TS and C# versions side by side; the `valueMatchesType` helper is the trickiest part because Java's runtime types (Integer/Long/Double, autoboxing) differ from JavaScript and C#. Confirm against the Java `MetaAttribute.getValue()` return type.

- [ ] **Step 4: Run the tests to verify they pass** — Expected: PASS, 4 tests green.

- [ ] **Step 5: Commit**

```bash
git add java/metadata && git commit -m "feat(java): attribute-schema validation pass (Phase A3)

Port of typescript/packages/metadata/src/attr-schema-validate.ts.
Required attrs (via effective attrs()), well-typed declared own attrs,
allowedValues membership. Undeclared attrs are NOT flagged (open policy).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 1.7: Wire the five passes into `MetaDataLoader.load`

**Files:**
- Modify: `java/metadata/src/main/java/com/metaobjects/loader/MetaDataLoader.java`
- Test: `java/metadata/src/test/java/com/metaobjects/loader/MetaDataLoaderValidationTest.java`

**Read first:**
- TS reference: `typescript/packages/metadata/src/loader/meta-data-loader.ts` — see the `// Pass 2: ... // Pass 7:` ordering after `resolveDeferredSupers`.
- C# port: `csharp/MetaObjects/Loader/MetaDataLoader.cs` — `Load()` method, the validation-pass block.

The Java `MetaDataLoader.load(List<MetaDataSource>)` already runs super-resolution. After super-resolution and before any freeze/finalization step, call the five new passes IN THIS ORDER (matching the TS pipeline exactly):
1. `SubtypeRulesValidator.validate(root)` — append both errors and warnings.
2. `DataGridSortFieldValidator.validate(root)` — append errors.
3. `FilterableHasIndexValidator.validate(root)` — append warnings.
4. `OriginPathValidator.validate(root)` — append errors.
5. `AttrSchemaValidator.validate(root, registry)` — append errors.

If the loader currently has no warning accumulator, add one and expose it via `LoadResult` (mirror C#'s `LoadResult(root, warnings, errors)` record shape). Without a warnings accumulator the conformance harness can't compare `expected-warnings.json` — this is a prerequisite for Slice 2.

- [ ] **Step 1: Write the failing test**

```java
@Test
void load_collects_attr_schema_errors_via_validation_pass_pipeline() throws Exception {
    var corpusRoot = /* walk-up helper */;
    var loader = new FileMetaDataLoader();
    var result = loader.load(List.of(/* sources from error-attr-missing-required/input */));
    assertTrue(result.errors().stream().anyMatch(e -> e.code().equals(ErrorCode.ERR_MISSING_REQUIRED_ATTR)));
}

@Test
void load_collects_filterable_warning_via_validation_pass_pipeline() throws Exception {
    var loader = new FileMetaDataLoader();
    var result = loader.load(List.of(/* sources from warning-filterable-no-index/input */));
    assertFalse(result.warnings().isEmpty());
}
```

- [ ] **Step 2: Run it to verify it fails** — Expected: the validation passes aren't wired yet → no errors/warnings collected, test fails.

- [ ] **Step 3: Wire the passes**

In `MetaDataLoader.load(...)`, after super-resolution and before freeze, append the five `validate(...)` calls. Match the TS pipeline ordering exactly. If `LoadResult` needs a `warnings` field, add it and update existing call sites accordingly.

- [ ] **Step 4: Run the tests to verify they pass** — Expected: PASS. ALSO run `mvn -pl metadata,core test` to confirm no existing tests broke (especially tests that compared `LoadResult` shape).

- [ ] **Step 5: Commit**

```bash
git add java/metadata && git commit -m "feat(java): wire 5 validation passes into MetaDataLoader pipeline

After super-resolution and before freeze, run (in TS order):
  subtype rules, dataGrid sort field, filterable-no-index,
  origin paths, attr-schema validation.

Adds warnings accumulator to LoadResult (mirrors TS/C# shape) if not
already present.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Slice 2 — Conformance harness

Goal: run the entire `fixtures/conformance/` corpus as `mvn test`. After Slice 2, ~33 of the 43 fixtures should pass (happy-path + extends-* + overlay + the now-validated error-* and warning-* fixtures since Slice 1 already landed). The lone `extends-abstract-base` fixture has a `script.json` whose check we silently skip (Slice-3 marker), so it passes via its `expected.json` check alone.

### Task 2.1: CorpusRoot

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/CorpusRoot.java`

**Read first:** `csharp/MetaObjects.Conformance.Tests/CorpusRoot.cs`.

- [ ] **Step 1: Implement**

```java
package com.metaobjects.conformance;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;

/** Resolves the conformance corpus root once, via env var or walk-up. */
public final class CorpusRoot {
    private CorpusRoot() {}
    public static final Path PATH = resolve();

    private static Path resolve() {
        String env = System.getenv("METAOBJECTS_CONFORMANCE_CORPUS");
        if (env != null && !env.isEmpty()) return Paths.get(env);
        // Walk up from the test classpath base until we find a directory containing fixtures/conformance/
        Path start = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        Path cur = start;
        while (cur != null) {
            Path candidate = cur.resolve("fixtures").resolve("conformance");
            if (Files.isDirectory(candidate)) return candidate;
            cur = cur.getParent();
        }
        throw new IllegalStateException("fixtures/conformance not found walking up from " + start);
    }
}
```

(The walk-up may need adjustment — `user.dir` when running under Maven is the project module's directory, e.g. `java/metadata`. Walking up 3 levels reaches the repo root. Verify by running a one-off test that prints `CorpusRoot.PATH`.)

- [ ] **Step 2: Confirm it compiles**

Run: `cd /home/doug/Development/metaobjects/java/metadata && mvn -DskipTests test-compile`. Expected: BUILD SUCCESS.

- [ ] **Step 3: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): CorpusRoot helper for conformance harness

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.2: Fixture + FixtureDiscovery (with providers.json support)

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/Fixture.java`
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/FixtureDiscovery.java`

**Read first:** `typescript/packages/conformance/src/fixture.ts`, `csharp/MetaObjects.Conformance.Tests/FixtureDiscovery.cs`.

- [ ] **Step 1: Write `Fixture.java`**

```java
package com.metaobjects.conformance;

import java.nio.file.Path;
import java.util.List;

/** A discovered conformance fixture. */
public record Fixture(
    String name,
    Path dir,
    Path inputDir,
    List<String> providers,
    boolean hasExpected,
    boolean hasExpectedEffective,
    boolean hasExpectedErrors,
    boolean hasExpectedWarnings,
    boolean hasScript
) {}
```

- [ ] **Step 2: Write `FixtureDiscovery.java`**

Port `fixture.ts`'s `discoverFixtures` + the providers-default constant. Public API:

```java
public final class FixtureDiscovery {
    private static final List<String> DEFAULT_PROVIDERS = List.of("metaobjects-core-types");
    public static List<Fixture> discoverFixtures(Path corpusRoot) throws IOException { ... }
}
```

Behavior:
- List `corpusRoot` immediate subdirectories, sort by name (`Comparator.naturalOrder()` on `Path::getFileName`).
- For each subdir: require `input/` directory exists (throw `IllegalStateException` if missing). Check for each expectation file's existence.
- If `providers.json` exists, parse as a JSON array of strings (use Gson: `gson.fromJson(reader, String[].class)`) and use those; otherwise default.

- [ ] **Step 3: Write a quick sanity test**

```java
@Test
void discoverFixtures_finds_all_43_corpus_fixtures() throws IOException {
    var fixtures = FixtureDiscovery.discoverFixtures(CorpusRoot.PATH);
    assertEquals(43, fixtures.size());
    // Spot-check one known fixture
    assertTrue(fixtures.stream().anyMatch(f -> f.name().equals("loader-basic-single-entity")));
}
```

Run it. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): Fixture + FixtureDiscovery (with providers.json support)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.3: OperationScript (ParseExpectedErrors + ParseOperationScript)

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/OperationScript.java`

**Read first:** `typescript/packages/conformance/src/operation-script.ts`, `csharp/MetaObjects.Conformance.Tests/OperationScript.cs`.

Port both `parseExpectedErrors(raw) → List<String>` (the `code` strings) and `parseOperationScript(raw) → OperationScript`. The capability-id regex is `^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$`. Both parsers throw `IllegalArgumentException` (or a project-specific `MalformedFixtureException`) on schema violations with clear messages.

```java
public final class OperationScript {
    public record Operation(List<String> navigate, String invoke,
                            Map<String, Object> args, JsonObject expect) {}
    public record Script(List<Operation> operations) {}

    public static List<String> parseExpectedErrors(JsonElement raw) { ... }
    public static Script parseOperationScript(JsonElement raw) { ... }
}
```

Use Gson `JsonElement`/`JsonObject`/`JsonArray` for the parsed-tree shape.

- [ ] **Step 1: Implement + small unit tests**

Two tests: `parseExpectedErrors` validates correct shape and throws on malformed; `parseOperationScript` validates correct shape and throws on bad capability-id.

- [ ] **Step 2: Run** — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): OperationScript — parse expected-errors.json and script.json

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.4: FixtureLint

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/FixtureLint.java`

**Read first:** `typescript/packages/conformance/src/fixture-lint.ts`, `csharp/MetaObjects.Conformance.Tests/FixtureLint.cs`.

Three corpus-integrity checks: (a) every `expected-errors.json` code must be a key of `ERROR-CODES.json`; (b) `script.json` must parse successfully; (c) each navigate `type:name` segment must name a node present in `expected.json` (collected via a recursive `namesIn` walker — `type[subType]` bracket segments are accepted without verification because nameless nodes can't be cheaply verified).

```java
public final class FixtureLint {
    public static List<String> lintFixture(Fixture fix, Set<String> registeredErrorCodes) { ... }
}
```

Load `ERROR-CODES.json` once in the calling test class (parse the `.codes` object's keys into a `Set<String>`).

- [ ] **Step 1: Implement**

The `namesIn` recursive walker — read the C# `CollectNames` for the proven idiom (strings recursing into non-string values only; do not recurse into string `name` values themselves).

- [ ] **Step 2: Write a small unit test**

```java
@Test
void lintFixture_clean_on_loader_basic_single_entity() throws IOException {
    var fixtures = FixtureDiscovery.discoverFixtures(CorpusRoot.PATH);
    var fix = fixtures.stream().filter(f -> f.name().equals("loader-basic-single-entity")).findFirst().orElseThrow();
    var codes = /* load ERROR-CODES.json key set */;
    assertEquals(List.of(), FixtureLint.lintFixture(fix, codes));
}
```

- [ ] **Step 3: Run** — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): FixtureLint — corpus-integrity checks

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.5: ConformanceAdapter (LoadFixture)

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/ConformanceAdapter.java`

**Read first:** `typescript/packages/conformance/src/adapter.ts`, `typescript/packages/metadata/test/conformance/adapter.ts`, `csharp/MetaObjects.Conformance.Tests/ConformanceAdapter.cs`.

Public surface:

```java
public final class ConformanceAdapter {
    public record LoadOutcome(MetaData tree, List<String> errorCodes, List<String> warnings) {}

    /** Provider-id → provider object. Composes a per-fixture registry. */
    private static final Map<String, MetaDataTypeProvider> PROVIDERS = Map.of(
        "metaobjects-core-types", /* the core types provider — match Java's actual entrypoint */
    );

    public static LoadOutcome loadFixture(Path inputDir, List<String> providers) throws IOException {
        var resolved = providers.stream()
            .map(id -> {
                var p = PROVIDERS.get(id);
                if (p == null) throw new IllegalArgumentException("Unknown provider id \"" + id + "\"");
                return p;
            })
            .toList();
        // Compose a MetaDataRegistry from resolved providers (use the project's compose API)
        var registry = /* compose */;
        var loader = new FileMetaDataLoader(registry);   // or whatever the registry-accepting constructor is
        var result = loader.loadDirectory(inputDir.toString());   // OR build URIMetaDataSources from input dir
        return new LoadOutcome(
            result.root(),
            result.errors().stream().map(e -> e.code().name()).toList(),
            result.warnings()
        );
    }

    public static String canonicalSerialize(MetaData tree)
        { return CanonicalJsonSerializer.canonicalSerialize(tree); }
    public static String canonicalSerializeEffective(MetaData tree)
        { return CanonicalJsonSerializer.canonicalSerializeEffective(tree); }

    // Slice 3 will add Navigate + Invoke here.
}
```

The provider-id-to-provider mapping is the bit you have to learn from Java's existing SPI setup. Java uses `ServiceLoader<MetaDataTypeProvider>` via `META-INF/services/com.metaobjects.registry.MetaDataTypeProvider`. The adapter needs to either: (a) call the SPI loader and filter to the requested ids; or (b) maintain its own explicit map mirroring C#'s pattern. Option (b) is simpler and matches the TS adapter — use it.

The "Java's actual entrypoint" for core types: check existing classes like `CoreTypeMetaDataProvider` / `FieldTypesMetaDataProvider` etc. The TS/C# expose ONE provider id `"metaobjects-core-types"` that registers everything. Java's SPI seems to split it into ~8 providers. **Decision needed:** either compose all 8 under a single virtual `"metaobjects-core-types"` adapter entry, or call each one in turn when that id is requested. The simpler option is a single virtual entry that registers all 8 — the fixture corpus treats `"metaobjects-core-types"` as the atomic unit.

- [ ] **Step 1: Implement**

If the registry-composition API does not accept a `List<MetaDataTypeProvider>` directly, you may need to call them one at a time. Read `MetaDataRegistry` source to find the public API.

- [ ] **Step 2: Sanity test**

```java
@Test
void loadFixture_loads_loader_basic_single_entity() throws IOException {
    var fix = /* discover loader-basic-single-entity */;
    var outcome = ConformanceAdapter.loadFixture(fix.inputDir(), fix.providers());
    assertEquals(List.of(), outcome.errorCodes());
    assertNotNull(outcome.tree());
}
```

Run. Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): ConformanceAdapter — load fixture + canonical serialize

Per-fixture registry composition from declared providers.
Navigate/Invoke for the script branch land in Slice 3.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.6: ExpectedFailures + ledger seed

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/ExpectedFailures.java`
- Create: `java/metadata/src/test/resources/conformance-expected-failures.json` (initial empty content: `{ "language": "java", "fixtures": [] }`)

**Read first:** `typescript/packages/conformance/src/expected-failures.ts`, `csharp/MetaObjects.Conformance.Tests/ExpectedFailures.cs`.

Port `classifyAgainstLedger` exactly (the three-rule classifier: listed+fail → `"known-gap"`, listed+pass → `"fixed-but-listed"`, unlisted+fail → `"fail"`, unlisted+pass → `"pass"`). Plus `loadLedger(InputStream)` returning the empty list when the resource is missing.

```java
public final class ExpectedFailures {
    public static Set<String> loadLedger() {
        try (var in = ExpectedFailures.class.getResourceAsStream("/conformance-expected-failures.json")) {
            if (in == null) return Set.of();
            var json = new Gson().fromJson(new InputStreamReader(in, StandardCharsets.UTF_8), JsonObject.class);
            var arr = json.getAsJsonArray("fixtures");
            return arr == null ? Set.of()
                : arr.asList().stream().map(JsonElement::getAsString).collect(Collectors.toSet());
        } catch (Exception e) { return Set.of(); }
    }

    public static String classify(boolean passed, String fixtureName, Set<String> ledger) {
        boolean listed = ledger.contains(fixtureName);
        if (!passed) return listed ? "known-gap" : "fail";
        return listed ? "fixed-but-listed" : "pass";
    }
}
```

- [ ] **Step 1: Implement**

- [ ] **Step 2: Quick unit test**

Two tests for the four classifier outcomes.

- [ ] **Step 3: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): ExpectedFailures ledger classifier + empty seed

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 2.7: ConformanceTest — the @ParameterizedTest pair

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/ConformanceTest.java`

**Read first:** `typescript/packages/conformance/src/runner.ts`, `typescript/packages/metadata/test/conformance.test.ts`, `csharp/MetaObjects.Conformance.Tests/ConformanceTests.cs` (`RunChecks` method especially).

The test class runs TWO parameterized theories over every discovered fixture: `lint` and `conformance`. The `conformance` theory does what `runner.ts`'s `runFixture` does, mirroring the C# `RunChecks` ordering:

1. If `hasExpectedErrors`: parse via `OperationScript.parseExpectedErrors`; compare sorted to `outcome.errorCodes()`.
2. If `hasExpected`: assert `outcome.errorCodes()` is empty; canonical-serialize the tree; compare **trimmed-exact** to `expected.json`.
3. If `hasExpectedEffective`: canonical-effective-serialize; compare trimmed-exact to `expected-effective.json`.
4. If `hasExpectedWarnings`: compare sorted to `outcome.warnings()`. **This is a DELIBERATE divergence from the TS runner** — the TS runner currently does not check warnings (the C# port added it per the corpus spec, and TS was brought up to spec at commit `d978628` on `main`). Java follows the corpus spec and checks them. On a happy-path fixture with no `expected-warnings.json`, assert `outcome.warnings()` is empty.
5. If `hasScript`: Slice 3 wires this. Until then, leave a `// Slice 3` marker.
6. No expectation files at all → failed check (configuration error).

```java
public class ConformanceTest {
    private static final Set<String> LEDGER = ExpectedFailures.loadLedger();
    private static final Set<String> ERROR_CODES = loadCorpusErrorCodeKeys();

    static Stream<Fixture> fixtures() throws IOException {
        return FixtureDiscovery.discoverFixtures(CorpusRoot.PATH).stream();
    }

    @ParameterizedTest(name = "lint: {0}")
    @MethodSource("fixtures")
    void lint(Fixture fix) {
        var problems = FixtureLint.lintFixture(fix, ERROR_CODES);
        assertEquals(List.of(), problems);
    }

    @ParameterizedTest(name = "conformance: {0}")
    @MethodSource("fixtures")
    void conformance(Fixture fix) throws Exception {
        var outcome = ConformanceAdapter.loadFixture(fix.inputDir(), fix.providers());
        var detail = new StringBuilder();
        boolean passed = runChecks(fix, outcome, detail);
        String status = ExpectedFailures.classify(passed, fix.name(), LEDGER);
        assertTrue(status.equals("pass") || status.equals("known-gap"),
            () -> fix.name() + " [" + status + "]: " + detail);
    }

    private boolean runChecks(Fixture fix, ConformanceAdapter.LoadOutcome outcome, StringBuilder detail) {
        // Port runner.ts logic exactly; mirror C# RunChecks ordering.
        // Return true when every applicable check passed.
    }

    private static Set<String> loadCorpusErrorCodeKeys() {
        // Read ERROR-CODES.json from CorpusRoot.PATH and return its .codes key set.
    }
}
```

JUnit 5's `Fixture` parameter needs `toString()` for the `{0}` placeholder — Java records auto-generate a `toString`. To get a clean test display name use `@MethodSource` returning `Stream<Arguments>` with `Arguments.of(fix, fix.name())` and reference `{1}` instead, OR provide a `@MethodSource` `Stream<Fixture>` and accept the default display.

- [ ] **Step 1: Implement the test class with the lint theory + the conformance theory (script branch deferred)**

- [ ] **Step 2: Run the full corpus**

Run: `cd /home/doug/Development/metaobjects/java && mvn -pl metadata test -Dtest=ConformanceTest`
Expected: every `lint` test passes (the corpus is clean — the C# / TS harnesses both verified this). The `conformance` tests fail for fixtures that aren't yet handled by Java. Note the OBSERVED failing set.

Since Slice 1 already ported the five validation passes, the expected failing set is small — most/all fixtures should pass at this point except the script-only check on `extends-abstract-base` (which is silently skipped, so it still passes via the `expected.json` check). Realistic expectation: **0 failures**, ledger stays empty.

If the observed set is NOT empty, investigate each failure:
- A canonical-diff failure means Java's `CanonicalJsonSerializer` is not byte-identical to TS on that fixture — fix the serializer, don't ledger it (and don't edit the fixture).
- An error-code mismatch on an `error-*` fixture means a validation pass produces a different set of codes than the TS — fix the validator.
- A warning-set mismatch — adjust the warning string or the pass logic; the corpus is the oracle.

For any fixture that genuinely needs deferred work, add to the ledger and commit a follow-up issue.

- [ ] **Step 3: Finalize the ledger to the observed failing set**

Update `src/test/resources/conformance-expected-failures.json` to contain `{"language": "java", "fixtures": [<observed failures>]}`. Re-run `mvn test`; expect all green now (each ledger entry classifies as `"known-gap"`).

- [ ] **Step 4: Confirm the wider test suite still passes**

Run: `cd /home/doug/Development/metaobjects/java && mvn -pl metadata test`
Expected: ALL Java metadata tests pass, including the new conformance theories.

- [ ] **Step 5: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): conformance harness (lint + conformance) + ledger

Two parameterized JUnit 5 theories over the shared fixtures/conformance/
corpus. Lint enforces corpus integrity; conformance runs the full
canonical-serialize + error/warning comparison through ConformanceAdapter.
Empirically-seeded ExpectedFailures ledger keeps the build green during
remaining slice work.

DELIBERATE divergence: checks expected-warnings.json (the TS runner now
does too as of d978628; original TS runner didn't despite the spec).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Slice 3 — Capability script

Goal: wire up the script execution path for the one fixture (`extends-abstract-base`) that ships a `script.json`. After Slice 3, the script check runs for real (not silently skipped) and the corpus is genuinely fully verified.

### Task 3.1: Result + ResultsEqual

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/Result.java`

**Read first:** `typescript/packages/conformance/src/result.ts`, `csharp/MetaObjects.Conformance.Tests/Result.cs`.

The `NormalizedResult` closed-set vocabulary: `{names: List<String>}`, `{name: String}`, `{absent: true}`, `{scalar: String|Long|Double|Boolean|null}`, `{subtype: String}`, `{"effective-tree": String}`, `{error: {code: String}}`.

Java idiom: a `sealed interface NormalizedResult permits ...` with one record per variant. Plus a static `fromJson(JsonElement)` factory and a static `resultsEqual(NormalizedResult, NormalizedResult)`.

```java
public sealed interface NormalizedResult
    permits NamesResult, NameResult, AbsentResult, ScalarResult, SubtypeResult, EffectiveTreeResult, ErrorResult {

    static NormalizedResult fromJson(JsonElement el) { /* dispatch by present key */ }
    static boolean equal(NormalizedResult a, NormalizedResult b) { /* port resultsEqual */ }
}

record NamesResult(List<String> names) implements NormalizedResult {}
record NameResult(String name) implements NormalizedResult {}
record AbsentResult() implements NormalizedResult { public static final AbsentResult INSTANCE = new AbsentResult(); }
record ScalarResult(Object value) implements NormalizedResult {}   // String/Long/Double/Boolean/null
record SubtypeResult(String subtype) implements NormalizedResult {}
record EffectiveTreeResult(String effectiveTree) implements NormalizedResult {}
record ErrorResult(String code) implements NormalizedResult {}
```

`resultsEqual` notes (from the TS spec):
- `names` element-wise ORDERED equality (not set equality).
- `name`/`subtype`/`effective-tree` exact string equality.
- `absent` both-present → true (no value to compare).
- `scalar` value equality — `Objects.equals(a.value, b.value)` handles null/null and most cases; numeric edge case (`Long` vs `Double` for the same numeric value) — TS treats `2` and `2.0` differently; Java should match TS (same-type equality only). Document this if a fixture ever runs into the edge.
- `error` equality by `code` ONLY.
- Different variant types → false.

- [ ] **Step 1: Implement** + small unit tests covering the seven shapes + round-trip via `fromJson`.

- [ ] **Step 2: Run** — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): NormalizedResult + resultsEqual (conformance script vocabulary)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.2: Navigator

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/Navigator.java`

**Read first:** `typescript/packages/metadata/test/conformance/navigator.ts`, `csharp/MetaObjects.Conformance.Tests/Navigator.cs`.

```java
public final class Navigator {
    private static final Pattern BRACKET = Pattern.compile("^([a-z]+)\\[([a-zA-Z]+)]$");
    public static MetaData navigate(MetaData root, List<String> path) {
        MetaData cur = root;
        for (String seg : path) {
            MetaData next = matchChild(cur, seg);
            if (next == null) return null;
            cur = next;
        }
        return cur;
    }

    private static MetaData matchChild(MetaData node, String segment) {
        Matcher m = BRACKET.matcher(segment);
        if (m.matches()) {
            String type = m.group(1), subType = m.group(2);
            return node.children().stream()
                .filter(c -> c.getType().equals(type) && c.getSubType().equals(subType))
                .findFirst().orElse(null);
        }
        int colon = segment.indexOf(':');
        if (colon < 0) return null;
        String type = segment.substring(0, colon), name = segment.substring(colon + 1);
        return node.children().stream()
            .filter(c -> c.getType().equals(type) && c.getName().equals(name))
            .findFirst().orElse(null);
    }
}
```

(Adjust accessor names — `children()` / `getChildren()` etc. — to match Java's actual `MetaData` API.)

- [ ] **Step 1: Implement** + a small unit test on a hand-built tree (two colon segments + one bracket segment + a missing segment returns null).

- [ ] **Step 2: Run** — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): Navigator — script.json navigate-path interpreter

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.3: CapabilityBinding

**Files:**
- Create: `java/metadata/src/test/java/com/metaobjects/conformance/CapabilityBinding.java`

**Read first:** `typescript/packages/metadata/test/conformance/binding.ts`, `csharp/MetaObjects.Conformance.Tests/CapabilityBinding.cs`.

Eight capabilities (the TS binding ships all eight; C# matches; Java does too):
- `object.effective-fields` → `names(asObject(node).fields())`
- `object.own-fields` → `names(asObject(node).ownFields())`
- `object.find-field` (arg `name`) → field-or-Absent
- `object.primary-identity` → `Subtype(id.subType)` or Absent
- `field.effective-validators` → `names(asField(node).validators())`
- `field.is-required` → `Scalar(asField(node).isRequired())`
- `field.max-length` → `Scalar((long) maxLength)` or Absent
- `field.effective-tree` → `EffectiveTree(CanonicalJsonSerializer.canonicalSerialize(asField(node)))`

```java
public final class CapabilityBinding {
    public static class UnknownCapabilityException extends RuntimeException {
        public final String capabilityId;
        public UnknownCapabilityException(String id) { super("No binding for capability '" + id + "'"); this.capabilityId = id; }
    }

    @FunctionalInterface
    interface Capability { NormalizedResult invoke(MetaData node, Map<String, Object> args); }

    private static final Map<String, Capability> BINDINGS = Map.of(
        "object.effective-fields", (node, args) -> new NamesResult(names(asObject(node).fields())),
        // ... 7 more ...
    );

    public static NormalizedResult invoke(MetaData node, String capabilityId, Map<String, Object> args) {
        Capability c = BINDINGS.get(capabilityId);
        if (c == null) throw new UnknownCapabilityException(capabilityId);
        return c.invoke(node, args);
    }

    private static MetaObject asObject(MetaData node) { ... }
    private static MetaField asField(MetaData node) { ... }
    private static List<String> names(List<? extends MetaData> nodes) {
        return nodes.stream().map(MetaData::getName).toList();
    }
    private static String stringArg(Map<String, Object> args, String key) {
        Object v = args.get(key);
        if (!(v instanceof String s)) throw new IllegalArgumentException("capability arg \"" + key + "\" must be a string");
        return s;
    }
}
```

(Java method names again — `MetaField.isRequired()` vs `MetaField.getRequired()` — match the actual API.)

- [ ] **Step 1: Implement** + a small unit test for one or two capabilities on a hand-built tree.

- [ ] **Step 2: Run** — Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): CapabilityBinding — script dispatch for 8 capabilities

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

### Task 3.4: Wire script execution into the conformance theory

**Files:**
- Modify: `java/metadata/src/test/java/com/metaobjects/conformance/ConformanceAdapter.java` — add `navigate` + `invoke`
- Modify: `java/metadata/src/test/java/com/metaobjects/conformance/ConformanceTest.java` — replace the Slice-3 marker with the real script-execution branch
- Modify: `java/metadata/src/test/resources/conformance-expected-failures.json` — should already be `{"language": "java", "fixtures": []}` after Slice 2; confirm it stays empty.

**Read first:** `typescript/packages/conformance/src/runner.ts` (the `if (fix.hasScript ...)` block), `csharp/MetaObjects.Conformance.Tests/ConformanceTests.cs` (`RunChecks` script branch).

- [ ] **Step 1: Add `navigate` + `invoke` static methods to `ConformanceAdapter`**

```java
public static MetaData navigate(MetaData tree, List<String> path) {
    return Navigator.navigate(tree, path);
}
public static NormalizedResult invoke(MetaData node, String capabilityId, Map<String, Object> args) {
    return CapabilityBinding.invoke(node, capabilityId, args);
}
```

- [ ] **Step 2: Replace the `// Slice 3` marker in `ConformanceTest.runChecks` with the script branch**

For each operation in the parsed script: navigate the path; if null → failed check (`navigate [seg…] did not resolve`). Otherwise invoke; catch `UnknownCapabilityException` → failed check (`unbound capability '<id>'`); catch other → failed check (`invoke threw: <msg>`). Compare actual to expected via `NormalizedResult.equal`; on mismatch → failed check (`operation N: expected … got …` with raw JSON strings for debug).

- [ ] **Step 3: Run the full corpus**

Run: `cd /home/doug/Development/metaobjects/java && mvn -pl metadata test`
Expected: ALL conformance tests pass, ledger remains empty. `extends-abstract-base` now actually runs its 5 script operations (the C# review confirmed these are not tautological — they genuinely exercise super-chain inheritance).

If the script check fails for `extends-abstract-base`, the binding is wrong — fix the binding. **Do not edit the fixture.** Read `extends-abstract-base/script.json` + `expected.json` + the binding code to debug.

- [ ] **Step 4: Cross-language parity check**

Run all three runners and compare:
```bash
cd typescript && bun test packages/metadata/test/conformance.test.ts 2>&1 | tail -3
cd csharp && dotnet test --nologo 2>&1 | tail -3
cd java && mvn -pl metadata test 2>&1 | tail -10
```

All three should enumerate the same 43 fixtures (×2 theories each for TS and C#, ×2 theories for Java now) and be fully green. Confirm.

- [ ] **Step 5: Commit**

```bash
git add java/metadata/src/test && git commit -m "feat(java): wire capability script execution; full conformance corpus green

After Slice 1 (validation passes), Slice 2 (harness + lint), and Slice 3
(script branch), Java now runs the full fixtures/conformance/ corpus at
parity with the TS reference and the C# port. Ledger empty.

The one fixture with a script.json (extends-abstract-base) executes all
5 operations against the CapabilityBinding (object.effective-fields,
object.own-fields, object.find-field, object.find-field negative, and
object.primary-identity) and they exercise super-chain inheritance —
not tautological.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Slice 4 — Docs

### Task 4.1: README + CLAUDE.md + roadmap update

**Files:**
- Modify: `java/README.md` (if it exists — otherwise create at the right module level)
- Modify: `CLAUDE.md` line 21 (currently says "Java port is in progress" — update to reflect conformance shipped)
- Modify: `spec/roadmap.md` — move the Java port to indicate conformance is done

- [ ] **Step 1: Update `java/README.md`** (or the Java module README) to document the conformance harness — how to run it (`mvn -pl metadata test`), the `METAOBJECTS_CONFORMANCE_CORPUS` env var, the ledger location, and the rule that fixtures are the oracle.

- [ ] **Step 2: Update `CLAUDE.md` Status section** — replace `Java port is in progress (H3 on the roadmap)` with `Java port is in progress (H3 on the roadmap); **loader + conformance shipped** with the full shared corpus green`.

- [ ] **Step 3: Update `spec/roadmap.md`** — in the H3 line, note conformance landed; or add a sub-bullet under H3 marking the conformance milestone.

- [ ] **Step 4: Commit**

```bash
git add java/README.md CLAUDE.md spec/roadmap.md && git commit -m "docs: Java loader + conformance shipped; corpus green at parity

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage.** Every piece of the survey's "what's missing" list is covered:
- 5 validation passes → Slice 1, tasks 1.2–1.6.
- Wiring into the loader pipeline → Task 1.7.
- Fixture discovery + lint + adapter + ledger + theory → Slice 2, tasks 2.1–2.7.
- Script execution path → Slice 3, tasks 3.1–3.4.
- Cross-language docs sync → Slice 4.

The pre-flight (Slice 0) protects against the "but does the existing serializer really byte-match TS?" assumption — if it doesn't, this plan halts early with a clear escalation rather than chasing red fixtures across Slice 2.

**Placeholder scan.** Every code block in this plan is either complete syntax-correct Java or an explicit instruction to read named TS + C# files and translate (legitimate per the cross-language-porting skill — the named files ARE the spec). No "TODO" or "implement appropriately" instructions. The two places where the exact Java method-name convention is unknown (`children()` vs `getChildren()` etc.) call this out and instruct the executor to match the existing Java conventions — that's a real concrete instruction, not a placeholder.

**Type consistency.** `ValidationResult(List<String> errors, List<String> warnings)` is defined in Task 1.1 and used unchanged through Tasks 1.2–1.7. `Fixture` record (Task 2.2) is consumed by every Slice 2 + 3 task. `LoadOutcome(tree, errorCodes, warnings)` shape in `ConformanceAdapter` (Task 2.5) is the type passed to `runChecks` (Task 2.7) and updated only by Slice 3 (`navigate` + `invoke` methods added). `NormalizedResult` sealed hierarchy (Task 3.1) is the return type of `CapabilityBinding.invoke` (Task 3.3) and the value `runChecks` compares (Task 3.4). All signatures line up.

**Two known risks during execution.**
1. **Serializer drift.** If Slice 0 Task 0.2 surfaces a real serializer diff (Java's `CanonicalJsonSerializer` not byte-identical to TS), this plan stops and the executor opens a focused investigation — likely a Gson indent/escaping/trailing-newline mismatch. Don't try to compensate in the harness (e.g. don't normalize whitespace before comparison) — fix the serializer.
2. **Provider mapping.** Java's SPI splits core types across ~8 provider classes; the conformance corpus treats `"metaobjects-core-types"` as one atomic id. Task 2.5 needs the executor to decide whether to (a) compose a single virtual provider that delegates to all 8 SPI providers, or (b) hand-list the 8 classes in the map under that one id. Either works; pick the simpler option and document it inline.

---

## Audit trail — what this plan inherits from the C# experience

- **Empirical ledger seeding** (not predictive). The C# plan first tried to enumerate the expected failing set; the audit caught two fixtures that already passed at the first checkpoint. This plan instructs the executor to seed the ledger from observed failures, with a cross-check expectation only as a sanity gate.
- **Warnings are checked.** The C# plan added the warnings check (the TS runner originally didn't); this was upstreamed to TS at commit `d978628`. Java follows the same policy — `LoadOutcome` carries warnings, `runChecks` compares them. Documented in the Slice 2 Task 2.7 commit message.
- **Lint is a separate theory.** Don't fold lint into the conformance theory — keep them parallel `@ParameterizedTest`s so a lint break (corpus integrity) is diagnosed separately from a conformance break (port behavior).
- **No fixture editing, ever.** Multiple Slice 2 + Slice 3 steps repeat this — every code-review and execution checkpoint reminds the executor.
- **Provider-driven invariant.** Java's `CanonicalJsonParser` already enforces this (the survey confirmed). This plan doesn't touch the parser — it only adds passes and a harness. So the invariant is preserved by construction.

---

## Execution order summary (for an executor running this plan)

```
Slice 0: pre-flight (read-only sanity)         — confirms foundation; bail-fast on serializer drift
Slice 1: 5 validation passes + loader wiring   — Tasks 1.1–1.7  (7 commits)
Slice 2: conformance harness + empirical ledger — Tasks 2.1–2.7  (7 commits)
Slice 3: capability script execution            — Tasks 3.1–3.4  (4 commits)
Slice 4: docs sync                              — Task 4.1        (1 commit)
```

Total: ~19 commits across 3 working days for a focused executor. Closes Java conformance to TS-reference parity.
