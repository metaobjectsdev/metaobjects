# Java Per-Loader Type Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Java's child-acceptance validation resolve the type registry from the owning `MetaDataLoader` (with a singleton fallback) instead of always using the process-global singleton, matching TS/Python/C# and enabling correct multi-loader isolation.

**Architecture:** `MetaData.addChild` resolves `reg = getLoader()!=null ? getLoader().getTypeRegistry() : MetaDataRegistry.getInstance()` and uses `reg` for both validation sites (`acceptsChild` and constraint enforcement). A new public factory `MetaDataRegistry.createWithCoreProviders()` lets a consumer build an isolated, core-populated registry to hand a loader via the existing `setTypeRegistry(...)`. Backward-compatible: when no custom registry is set, `getTypeRegistry()` returns the singleton, so existing behavior is unchanged.

**Tech Stack:** Java 21, JUnit 4 (`@Test`, Parameterized), Maven (`server/java`).

**Spec:** `docs/superpowers/specs/2026-05-29-java-per-loader-registry-design.md`

---

## File Structure

- `server/java/metadata/src/main/java/com/metaobjects/registry/MetaDataRegistry.java` — **modify**: add public `createWithCoreProviders()` factory.
- `server/java/metadata/src/main/java/com/metaobjects/constraint/ConstraintEnforcer.java` — **modify**: add registry-parameterized `enforceConstraintsOnAddChild(parent, child, reg)`; old method delegates with the singleton.
- `server/java/metadata/src/main/java/com/metaobjects/MetaData.java` — **modify**: `addChild` resolves the loader registry and uses it for both validation sites.
- `server/java/metadata/src/test/java/com/metaobjects/registry/PerLoaderRegistryTest.java` — **create**: the multi-loader isolation test (TDD anchor + spec success-criterion #3).
- `server/java/metadata/src/test/java/com/metaobjects/conformance/ConformanceTest.java` — **modify**: use a per-fixture composed registry for the briefing fixture; delete `ensureBriefingRegistered`, the `briefingRegistered` static, and the ordering hack.

Run commands (from `server/java`):
- Single test: `mvn -q -pl metadata test -Dtest=PerLoaderRegistryTest`
- Conformance: `mvn -q -pl metadata test -Dtest=ConformanceTest`
- Full metadata module: `mvn -q -pl metadata test`

---

### Task 1: Public factory for an isolated, core-populated registry

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/registry/MetaDataRegistry.java` (after `getInstance()`, ~line 114)

- [ ] **Step 1: Add the factory**

Insert immediately after the `getInstance()` method (after line 114):

```java
    /**
     * Create a fresh, isolated registry pre-populated with the standard core
     * types via the same ServiceLoader bootstrap {@link #getInstance()} uses.
     *
     * <p>Unlike {@link #getInstance()} (a process-global singleton), each call
     * returns an independent registry. Hand it to a loader via
     * {@link com.metaobjects.loader.MetaDataLoader#setTypeRegistry} to run that
     * loader against an isolated type system (multi-tenant, plugin isolation,
     * tests). Register additional/extension types onto the returned instance
     * before use.</p>
     *
     * @return a new registry populated with the core type vocabulary
     */
    public static MetaDataRegistry createWithCoreProviders() {
        MetaDataRegistry registry = new MetaDataRegistry();
        registry.ensureInitialized();
        return registry;
    }
```

(`ensureInitialized()` is a private instance method on this class — callable here since this code is inside `MetaDataRegistry`.)

- [ ] **Step 2: Smoke-test the factory**

Create `server/java/metadata/src/test/java/com/metaobjects/registry/CreateWithCoreProvidersTest.java`:

```java
package com.metaobjects.registry;

import org.junit.Test;
import static org.junit.Assert.assertNotSame;
import static org.junit.Assert.assertTrue;

public class CreateWithCoreProvidersTest {

    @Test
    public void createsIsolatedCorePopulatedRegistry() {
        MetaDataRegistry a = MetaDataRegistry.createWithCoreProviders();
        MetaDataRegistry b = MetaDataRegistry.createWithCoreProviders();

        // Independent instances, neither is the global singleton.
        assertNotSame(a, b);
        assertNotSame(a, MetaDataRegistry.getInstance());

        // Core vocabulary present: object.entity accepts a field.string child
        // (a relationship guaranteed by the core providers).
        assertTrue("core registry should accept field.string under object.entity",
            a.acceptsChild("object", "entity", "field", "string", "someField"));
    }
}
```

- [ ] **Step 3: Run it**

Run: `mvn -q -pl metadata test -Dtest=CreateWithCoreProvidersTest`
Expected: PASS. (If `acceptsChild`'s exact core relationship differs, adjust the assertion to any known-valid core parent/child pair confirmed from an existing happy-path fixture — the point is "the registry has core types".)

- [ ] **Step 4: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/registry/MetaDataRegistry.java \
        server/java/metadata/src/test/java/com/metaobjects/registry/CreateWithCoreProvidersTest.java
git commit -m "feat(java-registry): add createWithCoreProviders() isolated-registry factory"
```

---

### Task 2: Failing multi-loader isolation test (the TDD anchor)

This proves the bug today and the fix later. It builds two loaders with different registries and loads the **same** known-valid metadata that references the test-only `template.briefing` subtype: the loader whose registry has briefing must succeed; the one without must fail with `ERR_UNKNOWN_SUBTYPE`. Today BOTH validate against the singleton, so the test fails.

**Files:**
- Create: `server/java/metadata/src/test/java/com/metaobjects/registry/PerLoaderRegistryTest.java`

Reuses the known-valid input from the existing fixture `fixtures/conformance/provider-extension-new-subtype-success/input/` and the `ConformanceTestProviders.BriefingTemplate` provider (package-private in `com.metaobjects.conformance`, so the test lives there or uses a local briefing registration — see Step 1).

- [ ] **Step 1: Write the failing test**

Create `server/java/metadata/src/test/java/com/metaobjects/conformance/PerLoaderRegistryTest.java` (placed in `com.metaobjects.conformance` to reuse the package-private `ConformanceTestProviders.BriefingTemplate`):

```java
package com.metaobjects.conformance;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.MetaDataSource;
import com.metaobjects.registry.MetaDataRegistry;
import org.junit.Test;

import java.util.List;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Proves two loaders with different type registries in one JVM validate
 * independently (spec success-criterion #3). A loader whose registry knows
 * {@code template.briefing} accepts it; a loader whose registry does not
 * rejects it with ERR_UNKNOWN_SUBTYPE — regardless of construction order.
 */
public class PerLoaderRegistryTest {

    // Minimal canonical metadata that declares a template.briefing node.
    // (Mirrors fixtures/conformance/provider-extension-new-subtype-success input.)
    private static final String META =
        "{ \"metadata.root\": { \"package\": \"t\", \"children\": ["
        + "  { \"template.briefing\": { \"name\": \"greeting\" } }"
        + "] } }";

    private static MetaDataLoader newLoader(String name, MetaDataRegistry reg) {
        LoaderOptions opts = LoaderOptions.create(false, false, true);
        MetaDataLoader loader = new MetaDataLoader(opts, MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.setTypeRegistry(reg);
        loader.init();
        return loader;
    }

    private static void load(MetaDataLoader loader) {
        List<MetaDataSource> sources =
            List.of(new InMemoryStringSource(META, "meta.t.json"));
        loader.load(sources);
    }

    /** Registry WITH briefing → load succeeds. */
    private static void assertAccepts(MetaDataRegistry reg) {
        MetaDataLoader loader = newLoader("with-briefing", reg);
        load(loader); // must not throw
    }

    /** Registry WITHOUT briefing → load fails with ERR_UNKNOWN_SUBTYPE. */
    private static void assertRejects(MetaDataRegistry reg) {
        MetaDataLoader loader = newLoader("without-briefing", reg);
        try {
            load(loader);
            fail("expected load to fail: template.briefing is unknown in this registry");
        } catch (MetaDataException expected) {
            assertTrue("expected ERR_UNKNOWN_SUBTYPE, got: " + expected.getMessage(),
                expected.getMessage().contains("UNKNOWN_SUBTYPE")
                || expected.getMessage().contains("does not accept child")
                || expected.getMessage().contains("template.briefing"));
        }
    }

    @Test
    public void twoLoadersValidateIndependently_withFirst() {
        MetaDataRegistry withBriefing = MetaDataRegistry.createWithCoreProviders();
        ConformanceTestProviders.BriefingTemplate.registerTypes(withBriefing);
        MetaDataRegistry withoutBriefing = MetaDataRegistry.createWithCoreProviders();

        assertAccepts(withBriefing);
        assertRejects(withoutBriefing);
    }

    @Test
    public void twoLoadersValidateIndependently_withoutFirst() {
        // Reverse order — proves no order dependency / no global contamination.
        MetaDataRegistry withoutBriefing = MetaDataRegistry.createWithCoreProviders();
        MetaDataRegistry withBriefing = MetaDataRegistry.createWithCoreProviders();
        ConformanceTestProviders.BriefingTemplate.registerTypes(withBriefing);

        assertRejects(withoutBriefing);
        assertAccepts(withBriefing);
    }
}
```

- [ ] **Step 2: Run it — verify it FAILS**

Run: `mvn -q -pl metadata test -Dtest=PerLoaderRegistryTest`
Expected: FAIL. Today `addChild` validates against the singleton, so `assertRejects` fails (the singleton may or may not have briefing depending on test order, but the loader's own `withoutBriefing` registry is ignored — the isolation guarantee is violated). This failure is the bug.

> If the minimal `META` string's `template.briefing` placement is rejected for a structural reason unrelated to subtype-registration even in `assertAccepts`, replace `META` by reading the existing valid input file at `fixtures/conformance/provider-extension-new-subtype-success/input/` (locate the corpus via the same `CorpusRoot.locate()` helper `ConformanceTest` uses) — that input is guaranteed structurally valid.

- [ ] **Step 3: Commit the failing test**

```bash
git add server/java/metadata/src/test/java/com/metaobjects/conformance/PerLoaderRegistryTest.java
git commit -m "test(java): failing multi-loader registry-isolation test (pre-fix)"
```

---

### Task 3: ConstraintEnforcer — registry-parameterized enforcement

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/constraint/ConstraintEnforcer.java:68` (the `enforceConstraintsOnAddChild` method)

- [ ] **Step 1: Extract a registry-parameterized overload; old method delegates**

Replace the method signature + first constraint-fetch (lines 68-74):

```java
    public void enforceConstraintsOnAddChild(MetaData parent, MetaData child) throws ConstraintViolationException {
        if (!isConstraintCheckingEnabled(parent)) {
            return;
        }
        
        // UNIFIED: Single enforcement path for all constraints
        List<Constraint> allConstraints = metaDataRegistry.getAllValidationConstraints();
```

with:

```java
    public void enforceConstraintsOnAddChild(MetaData parent, MetaData child) throws ConstraintViolationException {
        // Default registry-bound path (preserves all existing callers).
        enforceConstraintsOnAddChild(parent, child, this.metaDataRegistry);
    }

    /**
     * Registry-parameterized enforcement: reads constraints from the supplied
     * registry instead of the enforcer's singleton-bound one. Used when a loader
     * runs against its own {@code typeRegistry} (multi-loader isolation).
     */
    public void enforceConstraintsOnAddChild(MetaData parent, MetaData child,
                                             MetaDataRegistry registry) throws ConstraintViolationException {
        if (!isConstraintCheckingEnabled(parent)) {
            return;
        }

        // UNIFIED: Single enforcement path for all constraints
        List<Constraint> allConstraints = registry.getAllValidationConstraints();
```

Everything from the `if (allConstraints.isEmpty())` line through the end of the method body stays exactly as-is (it already operates on the local `allConstraints` variable — no other reference to `this.metaDataRegistry` inside the body).

- [ ] **Step 2: Verify the module still compiles + existing constraint tests pass**

Run: `mvn -q -pl metadata test -Dtest=*Constraint*`
Expected: PASS (behavior unchanged — the no-arg method delegates with the same singleton registry).

- [ ] **Step 3: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/constraint/ConstraintEnforcer.java
git commit -m "feat(java-constraints): registry-parameterized enforceConstraintsOnAddChild overload"
```

---

### Task 4: MetaData.addChild resolves the owning loader's registry

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/MetaData.java:1206-1219`

- [ ] **Step 1: Resolve the loader registry and use it at both sites**

Replace lines 1206-1219:

```java
        // v6.0.0: Unified registry validation before adding child
        MetaDataRegistry registry = MetaDataRegistry.getInstance();
        if (!registry.acceptsChild(this.getType(), this.getSubType(), 
                                 data.getType(), data.getSubType(), data.getName())) {
            String supportedChildren = registry.getSupportedChildrenDescription(this.getType(), this.getSubType());
            throw new InvalidMetaDataException(data, String.format(
                "%s.%s does not accept child '%s' of type %s.%s. %s",
                this.getType(), this.getSubType(), data.getName(),
                data.getType(), data.getSubType(), supportedChildren));
        }
        
        // v6.0.0: Constraint enforcement during construction
        ConstraintEnforcer constraintEnforcer = ConstraintEnforcer.getInstance();
        constraintEnforcer.enforceConstraintsOnAddChild(this, data);
```

with:

```java
        // Resolve the registry from the owning loader so a loader running against
        // its own typeRegistry (multi-tenant, plugin isolation, tests) validates in
        // isolation. Falls back to the global singleton for loader-detached nodes —
        // identical to prior behavior for every consumer that never sets a custom
        // registry (getTypeRegistry() defaults to getInstance()). See
        // docs/superpowers/specs/2026-05-29-java-per-loader-registry-design.md.
        MetaDataLoader owningLoader = getLoader();
        MetaDataRegistry registry = (owningLoader != null)
            ? owningLoader.getTypeRegistry()
            : MetaDataRegistry.getInstance();
        if (!registry.acceptsChild(this.getType(), this.getSubType(), 
                                 data.getType(), data.getSubType(), data.getName())) {
            String supportedChildren = registry.getSupportedChildrenDescription(this.getType(), this.getSubType());
            throw new InvalidMetaDataException(data, String.format(
                "%s.%s does not accept child '%s' of type %s.%s. %s",
                this.getType(), this.getSubType(), data.getName(),
                data.getType(), data.getSubType(), supportedChildren));
        }
        
        // Constraint enforcement during construction, against the resolved registry.
        ConstraintEnforcer constraintEnforcer = ConstraintEnforcer.getInstance();
        constraintEnforcer.enforceConstraintsOnAddChild(this, data, registry);
```

(`MetaDataLoader` is already imported at `MetaData.java:17`; `getLoader()` already exists at line 831.)

- [ ] **Step 2: Run the isolation test — verify it now PASSES**

Run: `mvn -q -pl metadata test -Dtest=PerLoaderRegistryTest`
Expected: PASS (both order variants). The bug is fixed.

- [ ] **Step 3: Run the FULL metadata suite — verify no regression**

Run: `mvn -q -pl metadata test`
Expected: all tests pass **except** the two known provider-extension fixtures may now behave differently (the success fixture relied on singleton mutation). If `ConformanceTest` fails on `provider-extension-*`, that is expected and fixed in Task 5. All other tests (≈194) must pass. If anything else regresses, STOP — the singleton-fallback should have preserved behavior; investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/MetaData.java
git commit -m "fix(java-core): addChild validates against the owning loader's registry

Resolves the type registry from getLoader().getTypeRegistry() (singleton
fallback) for both acceptsChild and constraint enforcement, matching the
instance-scoped model of the TS/Python/C# ports. Backward-compatible:
identical to prior behavior when no custom registry is set."
```

---

### Task 5: Refactor the conformance runner; delete the ordering hack

With Task 4 in place, the runner can give the success fixture its own registry (core + briefing) instead of mutating the singleton — and the fail fixture, using the default singleton (no briefing), still yields `ERR_UNKNOWN_SUBTYPE`, now order-independently.

**Files:**
- Modify: `server/java/metadata/src/test/java/com/metaobjects/conformance/ConformanceTest.java`

- [ ] **Step 1: Replace the singleton-mutation block in `runConformanceChecks`**

Replace lines 283-291:

```java
        MetaDataLoader loader = new MetaDataLoader(opts, MetaDataLoader.SUBTYPE_MANUAL, loaderName);
        // Lazy-register the test-only template.briefing subtype into the
        // singleton on first encounter. See {@link #ensureBriefingRegistered}
        // for the alphabetical-ordering rationale that keeps this safe.
        if (fix.hasProvidersJson
                && fix.requiredProviders.contains("example-template-briefing")) {
            ensureBriefingRegistered();
        }
        loader.init();
```

with:

```java
        MetaDataLoader loader = new MetaDataLoader(opts, MetaDataLoader.SUBTYPE_MANUAL, loaderName);
        // A fixture that requires the test-only example-template-briefing provider
        // gets its OWN registry (core + briefing) — no global-singleton mutation,
        // so this is order-independent and isolated (see PerLoaderRegistryTest and
        // the per-loader-registry design doc).
        if (fix.hasProvidersJson
                && fix.requiredProviders.contains("example-template-briefing")) {
            MetaDataRegistry fixtureRegistry = MetaDataRegistry.createWithCoreProviders();
            ConformanceTestProviders.BriefingTemplate.registerTypes(fixtureRegistry);
            loader.setTypeRegistry(fixtureRegistry);
        }
        loader.init();
```

(Add the import `import com.metaobjects.registry.MetaDataRegistry;` if not already present — it is referenced elsewhere in the file via fully-qualified name, so either add the import or use `com.metaobjects.registry.MetaDataRegistry` inline to match local style.)

- [ ] **Step 2: Delete the now-unused `ensureBriefingRegistered` + flag**

Remove the `briefingRegistered` field and the `ensureBriefingRegistered()` method (the block at lines ~670-696, including its javadoc). Nothing else references them after Step 1 (verify with a grep below).

- [ ] **Step 3: Verify no dangling references**

Run: `grep -n "ensureBriefingRegistered\|briefingRegistered" server/java/metadata/src/test/java/com/metaobjects/conformance/ConformanceTest.java`
Expected: no output.

- [ ] **Step 4: Run conformance — verify green WITHOUT the hack**

Run: `mvn -q -pl metadata test -Dtest=ConformanceTest`
Expected: all 98 fixtures pass (196 parameterized cases), including both `provider-extension-new-subtype-success` and `provider-extension-missing-provider-fails`, with no dependency on fixture ordering.

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/test/java/com/metaobjects/conformance/ConformanceTest.java
git commit -m "test(java-conformance): use per-loader registry for briefing fixture; drop ordering hack

Closes the R5 pass-by-accident hazard: the provider-extension success fixture
now gets its own composed registry via setTypeRegistry instead of mutating the
global singleton, so the success/fail pair is order-independent."
```

---

### Task 6: Full Java module verification

**Files:** none modified.

- [ ] **Step 1: Run the full metadata module test suite**

Run: `mvn -q -pl metadata test`
Expected: BUILD SUCCESS, all tests pass (the prior count + the new `PerLoaderRegistryTest` (2) + `CreateWithCoreProvidersTest` (1)).

- [ ] **Step 2: Build the dependent modules that consume metadata (catch downstream breakage)**

Run: `mvn -q -pl metadata,om,omdb,codegen-spring,render -am test`
Expected: BUILD SUCCESS. (`addChild` is core; this confirms no consumer relied on the global-singleton-only behavior.)

- [ ] **Step 3: Final commit if any follow-up fixes were needed**

If Steps 1-2 surfaced and required fixes, commit them with a clear message. Otherwise no commit (verification only).

---

## Post-implementation

- **ADR:** record "type-registry resolution is loader-scoped, not process-global" as an ADR (it is the implicit contract TS/Python/C# already honor; Java now matches). Add to `spec/decisions/` + the ADR index.
- **Conformance-hardening backlog:** mark R5 resolved in `docs/superpowers/specs/2026-05-29-conformance-hardening-review.md` (the ordering hazard is gone) and in the conformance-suite-gaps memory.
- **Push:** `git push origin main` (fast-forward; shared/forward-only main — never force).

## Self-review

- **Spec coverage:** component 1 (addChild registry resolution) → Task 4; component 2 (ConstraintEnforcer overload) → Task 3; component 3 (conformance runner + delete hack) → Task 5; success-criterion #1 (full suite green) → Task 6; #2 (provider-extension without hack) → Task 5 Step 4; #3 (two-loader isolation, order-independent) → Task 2 + Task 4 Step 2; #4 (single-registry unchanged) → Task 4 Step 3 + Task 6. The factory (`createWithCoreProviders`) is a spec refinement Task 1 introduces because `ensureInitialized()` is private — it is the public API that makes per-loader registries usable by consumers and tests.
- **Placeholders:** none — every code step shows exact before/after; commands show expected output. The one conditional (Task 2 Step 2 fallback to reading the fixture input) is a guarded alternative, not a placeholder.
- **Consistency:** `createWithCoreProviders()`, `enforceConstraintsOnAddChild(parent, child, registry)`, `getLoader()`, `getTypeRegistry()`, `setTypeRegistry()` used identically across tasks; the resolved-registry variable is named `registry` in `MetaData.addChild` and `fixtureRegistry` in the runner (distinct scopes, no collision).
