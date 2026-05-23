# WA1 — Case-preserving (case-sensitive) registry — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Java metamodel registry **case-sensitive on the exact (canonical) type/subtype vocabulary** — remove the type/subtype lowercasing in `MetaDataTypeId` + `ChildRequirement` — so the standard's camelCase subtypes (`dbTable`, `dbView`, `dataGrid`) are matched and round-tripped faithfully, and non-canonical-case input is rejected rather than silently accepted.

**Architecture:** The lowercasing lives only in the **registry lookup key** (`MetaDataTypeId`, which keys the type-definition map + pattern matching) and **placement rules** (`ChildRequirement`). Node instances already store their subtype verbatim (`createInstance` passes the verbatim args; node classes hardcode their canonical subtype constant), so the canonical *output* casing comes from the registered constants — not the key. Removing the lowercasing makes lookups exact-match (case-sensitive), which (a) rejects non-canonical input instead of silently accepting it, and (b) eliminates the latent path where a parsed wrong-case subtype could leak to canonical output. Foundational for WA3 (camelCase `source.dbView`/`dbTable`).

**Tech Stack:** Java 21, Maven `metadata` module under `server/java/`, JUnit4.

**Spec:** `docs/superpowers/specs/2026-05-23-java-standard-alignment-and-loader-consolidation-design.md` (WA1). This is the first of several plans from that spec; WA2/WA3/WA4 follow.

**Scope note:** Today Java's entire registered vocabulary is single-word **lowercase** (`string`, `int`, `pojo`, `base`, …), which is already canonical — so removing the lowercasing is largely a **no-op for current types** and a **strictness + future-camelCase enabler**. The audit (Task 4) should therefore find few or no breakages; any it finds are genuine non-canonical-case usages to correct.

**Leave-list (do NOT change — these lowercase *names*/provider-ids, not type-keys):** `CanonicalJsonSerializer:439-440` (auto-name prefix for unnamed nodes), `BaseMetaDataParser:276-277` (auto-name prefix), `MetaField.java:383` (`switch(subType.toLowerCase())` — harmless: field subtypes are canonically lowercase), `MetaDataTypeProvider:93,97` (provider-id derivation).

**Worktree:** execute in this worktree (`java-casing-fix`); integrate by merging forward into `main` (never rewrite main).

---

## Task 1: `MetaDataTypeId` — case-sensitive key + pattern matching

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/MetaDataTypeId.java` (lines 43-44, 68-69, 104)
- Test: `server/java/metadata/src/test/java/com/metaobjects/MetaDataTypeIdCaseTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects;

import org.junit.Test;
import static org.junit.Assert.*;

public class MetaDataTypeIdCaseTest {

    @Test public void preserves_camelCase_subtype() {
        MetaDataTypeId id = new MetaDataTypeId("source", "dbView");
        assertEquals("source", id.type());
        assertEquals("dbView", id.subType());            // not "dbview"
        assertEquals("source.dbView", id.toQualifiedName());
    }

    @Test public void differs_by_case_is_not_equal() {
        assertNotEquals(new MetaDataTypeId("source", "dbView"),
                        new MetaDataTypeId("source", "dbview"));
    }

    @Test public void wildcard_pattern_matches_case_sensitively() {
        MetaDataTypeId id = new MetaDataTypeId("source", "dbView");
        assertTrue(id.matches("source.*"));
        assertTrue(id.matches("source.dbView"));
        assertFalse(id.matches("source.dbview"));        // exact case required
        assertFalse(id.matches("Source.dbView"));        // type case too
    }
}
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=MetaDataTypeIdCaseTest`
Expected: `preserves_camelCase_subtype` fails (`subType()` returns `"dbview"`); `differs_by_case_is_not_equal` fails (both lowercase to equal); `matches("source.dbview")` returns true (should be false).

- [ ] **Step 3: Remove the lowercasing (keep `trim()`)**

In `MetaDataTypeId.java`, the compact constructor (lines ~43-44):

```java
        type = type.trim();
        subType = subType.trim();
```

In `matches(String pattern)` (lines ~68-69):

```java
        String patternType = parts[0].trim();
        String patternSubType = parts[1].trim();
```

In `pattern(String type, String subType)` (line ~104):

```java
        return new MetaDataTypeId(type.trim(), subType.trim());
```

(Do not touch `fromQualifiedName` — it delegates to the constructor. Do not touch `matches(MetaDataTypeId)` — it already compares `type`/`subType` directly.)

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=MetaDataTypeIdCaseTest`
Expected: `Tests run: 3, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/MetaDataTypeId.java \
        server/java/metadata/src/test/java/com/metaobjects/MetaDataTypeIdCaseTest.java
git commit -m "fix(metadata): MetaDataTypeId case-sensitive on canonical type/subtype (no lowercasing)"
```
(End the commit message with the trailer line `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`.)

---

## Task 2: `ChildRequirement` — case-sensitive placement keys

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/registry/ChildRequirement.java` (lines 67-68)
- Test: `server/java/metadata/src/test/java/com/metaobjects/registry/ChildRequirementCaseTest.java`

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.registry;

import org.junit.Test;
import static org.junit.Assert.*;

public class ChildRequirementCaseTest {

    @Test public void preserves_camelCase_expected_subtype() {
        ChildRequirement r = new ChildRequirement(
            "*", "source", "dbView", false, null, null, null, null, null);
        assertEquals("source", r.getExpectedType());
        assertEquals("dbView", r.getExpectedSubType());   // not "dbview"
    }

    @Test public void null_becomes_wildcard() {
        ChildRequirement r = new ChildRequirement(
            "*", null, null, false, null, null, null, null, null);
        assertEquals("*", r.getExpectedType());
        assertEquals("*", r.getExpectedSubType());
    }
}
```

(Confirm the `ChildRequirement` constructor signature + the `getExpectedType()`/`getExpectedSubType()` accessor names by reading the class first; adjust the test to the real accessors. The contract: a camelCase `expectedSubType` is stored verbatim, and null still maps to `"*"`.)

- [ ] **Step 2: Run, verify it fails**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=ChildRequirementCaseTest`
Expected: `preserves_camelCase_expected_subtype` fails (`getExpectedSubType()` returns `"dbview"`).

- [ ] **Step 3: Remove the lowercasing**

In `ChildRequirement.java` (lines ~67-68), drop the `.toLowerCase()` (keep the null→`"*"` default):

```java
        this.expectedType = expectedType != null ? expectedType : "*";
        this.expectedSubType = expectedSubType != null ? expectedSubType : "*";
```

(Update the adjacent `// Normalize types to lowercase…` comment to reflect that types are now stored verbatim / matched case-sensitively.)

- [ ] **Step 4: Run, verify pass**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=ChildRequirementCaseTest`
Expected: `Tests run: 2, Failures: 0, Errors: 0`.

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/registry/ChildRequirement.java \
        server/java/metadata/src/test/java/com/metaobjects/registry/ChildRequirementCaseTest.java
git commit -m "fix(metadata): ChildRequirement placement keys case-sensitive (no lowercasing)"
```
(Append the `Co-Authored-By` trailer.)

---

## Task 3: End-to-end gate — a camelCase subtype round-trips, wrong-case is rejected

Proves the full pipeline (register → parse → registry lookup → canonical serialize) preserves camelCase casing and now rejects non-canonical case. Since no camelCase subtype exists yet, register a **test-only** one, mirroring the existing Open-Closed proof test.

**Files:**
- Test: `server/java/metadata/src/test/java/com/metaobjects/registry/CamelCaseSubtypeRoundTripTest.java`

- [ ] **Step 1: Read the Open-Closed proof harness**

Find the existing test that registers a one-off type via a class + a single `registry.registerType(...)` line and loads/serializes it (per ADR-0002 — search `server/java/metadata/src/test` for "Open-Closed", "fizz", or a registry-completeness/extensibility test). Reuse its registration + load + canonical-serialize harness. Confirm the canonical serializer entry point + how a test registers a transient type without polluting the shared registry.

- [ ] **Step 2: Write the failing test**

Behavioral contract (adapt to the real harness):

```java
// CamelCaseSubtypeRoundTripTest
// 1. Register a test field subtype with a CAMELCASE name, e.g. field.fizzBuzz, via the same
//    one-class + registerType pattern the Open-Closed proof test uses (a tiny MetaField subclass
//    with SUBTYPE = "fizzBuzz" and a registerTypes() that inheritsFrom field.base).
// 2. Load metadata declaring it:  { "metadata.root": { "package":"t::x", "children":[
//       { "object.pojo": { "name":"X", "children":[ { "field.fizzBuzz": { "name":"f" } } ] } } ] } }
//    (use object.pojo — entity/value arrive in WA2).
// 3. Canonical-serialize the loaded root; assert the output contains the fused key "field.fizzBuzz"
//    (camelCase preserved end-to-end), NOT "field.fizzbuzz".
// 4. Assert a wrong-case fixture { "field.fizzbuzz": {...} } now FAILS to load (unregistered type —
//    case-sensitive lookup rejects it): expect a load exception.
```

Write the full JUnit4 test against the real harness; the assertions in (3) + (4) are the contract.

- [ ] **Step 3: Run, verify it passes** (Tasks 1+2 already make the pipeline case-sensitive)

Run: `cd server/java && mvn -o -pl metadata test -Dtest=CamelCaseSubtypeRoundTripTest`
Expected: both assertions pass — `field.fizzBuzz` round-trips with case preserved; the wrong-case `field.fizzbuzz` fixture is rejected.
(If (3) fails because a node-creation path still normalizes the subtype, trace it and fix the normalization at its source — do **not** weaken the assertion. If (4) does NOT reject — i.e. wrong-case still loads — the lookup isn't fully case-sensitive yet; find the remaining case-insensitive lookup and fix it.)

- [ ] **Step 4: Commit**

```bash
git add server/java/metadata/src/test/java/com/metaobjects/registry/CamelCaseSubtypeRoundTripTest.java
git commit -m "test(metadata): camelCase subtype round-trips end-to-end; wrong-case rejected (WA1 gate)"
```
(Append the `Co-Authored-By` trailer.)

---

## Task 4: Audit + reactor green

- [ ] **Step 1: Run the full metadata suite; triage breakages**

Run: `cd server/java && mvn -o -pl metadata test 2>&1 | grep -E "Tests run: [0-9]+, Fail|<<< (FAIL|ERROR)|BUILD" | grep -vE "Time elapsed" | tail -30`
Expected baseline: the only pre-existing errors are the 2 known `CanonicalJsonParserTest` CWD-path NPEs (`corpusSpotCheck_loaderBasicEmptyPackage`, `corpusSpotCheck_smokeEmptyMetadata`). **Any other failure** is a case-sensitivity breakage from Tasks 1-2: a registration, fixture, or test that used a non-canonical-case type/subtype and relied on the old lowercasing.

- [ ] **Step 2: Fix each breakage to canonical casing**

For each new failure, the fix is to correct the offending type/subtype string to its **canonical** registered casing (e.g. a fixture `"field.String"` → `"field.string"`; a lookup `getType("Object","Base")` → `"object","base"`). Do **not** re-introduce lowercasing to paper over it — the canonical casing is the contract. Re-run the failing test after each fix.

- [ ] **Step 3: Downstream modules green (the registry change is module-wide)**

Run: `cd server/java && mvn -o install -pl core,metadata -DskipTests >/dev/null 2>&1 && mvn -o -pl omdb test 2>&1 | grep -E "Tests run:|BUILD" | tail -2 && mvn -o -pl core test 2>&1 | grep -E "Tests run:|BUILD" | tail -2 && mvn -o -pl maven-plugin test 2>&1 | grep -E "Tests run:|BUILD" | tail -2`
Expected: `omdb`, `core`, `maven-plugin` BUILD SUCCESS (case-sensitivity must not regress them; fix any case-breakage the same way as Step 2).

- [ ] **Step 4: Final commit (if any audit fixes) + ready for review**

```bash
git add -A && git commit -m "fix(metadata): audit — correct non-canonical type/subtype casing after case-sensitive registry"
```
(Append the `Co-Authored-By` trailer. Skip if Steps 1-3 found nothing to fix.)

---

## Self-Review

- **Spec coverage (WA1):** removes the lowercasing in `MetaDataTypeId` (Task 1) + `ChildRequirement` (Task 2) → case-sensitive on canonical vocabulary; the end-to-end gate (Task 3) proves camelCase round-trips + wrong-case is rejected; the audit (Task 4) corrects any non-canonical usage. The leave-list (auto-name prefixes, provider-id, field-subtype switch) is documented and untouched. ✓
- **Accurate root-cause:** the lowercasing is in the lookup *key* + placement rules, not the node's stored subtype (which comes from the verbatim ctor args / canonical class constants) — so this is a case-*sensitivity* fix, not an output-mangling fix; framed as such. ✓
- **Placeholder scan:** Tasks 1-2 carry full code + exact line targets; Task 3 is a behavioral contract + "read the Open-Closed proof harness first" (a real test that must be matched, per the accepted convention); Task 4 is an empirical audit with concrete commands + a concrete fix rule (correct to canonical casing). No TBDs. ✓
- **Type consistency:** `MetaDataTypeId.type()/subType()/toQualifiedName()/matches()`; `ChildRequirement.getExpectedType()/getExpectedSubType()` (verify exact accessor names in Task 2). ✓
- **Hygiene:** repo-relative paths; generic `t::x`/`source.dbView` examples; no home paths/private names. ✓
