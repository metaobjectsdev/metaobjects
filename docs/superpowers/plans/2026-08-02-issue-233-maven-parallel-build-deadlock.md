# #233 maven parallel-build deadlock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `mvn -T<N>` parallel reactor builds deadlocking in the metaobjects maven-plugin, and stop same-named loaders in different reactor modules sharing one load.

**Architecture:** (A) A deterministic single-thread warm-up (`RegistryBootstrap.warmUpDefaults()`) force-initializes the process-global registry singletons before any parallel load, so a concurrent first-init cannot deadlock on their independent locks; called from `MetaDataLoader.initWithConcurrencyProtection(...)` (library-wide) and the mojo `execute()`s (Maven's pre-`init()` eager registry touch). (B) `MetaDataLoader.buildLoaderKey()` gains a per-instance id so the `activeLoaders` dedup only coalesces the *same* instance. (C) generate/verify/docs mojos are marked `threadSafe = true` (honest labeling, ships atomically).

**Tech Stack:** Java 21, Maven 3.9, JUnit 4 (metadata module) / maven-plugin-testing-harness (maven-plugin), maven-invoker-plugin (new, for the reactor IT).

## Global Constraints

- PUBLIC repo — no private/other-project names, no absolute home paths in any committed file or commit message. Use repo-relative paths.
- Metamodel strings via constants where a constant exists; no `own*()` accessor misuse (not relevant here).
- No backwards-compat hacks; no `any`-equivalent shortcuts.
- Byte-identical generated output for existing single-module builds (same shared sealed registry).
- Commit author + the standard `Co-Authored-By` / `Claude-Session` trailers per the repo's commit convention.
- Scope: Java maven-plugin + metadata registry only (Maven `7.x` line). No TS/Python/C#/Kotlin product changes.
- Fix bugs in place; no new follow-up tickets.

## File Structure

- **Create** `server/java/metadata/src/main/java/com/metaobjects/registry/RegistryBootstrap.java` — the warm-up (one responsibility: deterministic one-time global-registry bootstrap).
- **Modify** `server/java/metadata/src/main/java/com/metaobjects/loader/MetaDataLoader.java` — instance id + `buildLoaderKey()`; warm-up call in `initWithConcurrencyProtection(...)`.
- **Modify** `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AbstractMetaDataMojo.java` — warm-up first line of `execute()`.
- **Modify** `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataVerifyMojo.java` — warm-up first line of its `execute()`.
- **Modify** `@Mojo(...)` on `MetaDataGeneratorMojo.java`, `MetaDataVerifyMojo.java`, `DocsMojo.java` — add `threadSafe = true`.
- **Create** `server/java/metadata/src/test/java/com/metaobjects/loader/LoaderKeyIsolationTest.java` — Part B white-box.
- **Create** `server/java/metadata/src/test/java/com/metaobjects/registry/RegistryBootstrapTest.java` — Part A warm-up.
- **Create** `server/java/maven-plugin/src/test/java/com/metaobjects/mojo/MojoThreadSafeDescriptorTest.java` — plugin.xml threadSafe assertion.
- **Create** `server/java/maven-plugin/src/it/` reactor fixture + wire `maven-invoker-plugin` into `maven-plugin/pom.xml` (Part A/B end-to-end guard).

---

### Task 1: Part B — per-instance loader key

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/MetaDataLoader.java` (`buildLoaderKey` ~1059; add instance-id field near the `name` field ~111)
- Test: `server/java/metadata/src/test/java/com/metaobjects/loader/LoaderKeyIsolationTest.java`

**Interfaces:**
- Produces: `String MetaDataLoader.buildLoaderKey()` becomes **package-private** (was private), returns a per-instance-unique, call-stable key.

- [ ] **Step 1: Write the failing test**

`LoaderKeyIsolationTest.java` (package `com.metaobjects.loader`, same package → can call package-private `buildLoaderKey()`):

```java
package com.metaobjects.loader;

import com.metaobjects.loader.LoaderOptions;
import org.junit.Test;
import static org.junit.Assert.*;

public class LoaderKeyIsolationTest {

    private static MetaDataLoader sameNamed() {
        // Same class + subType + name as any other instance from this factory.
        return new MetaDataLoader(LoaderOptions.create(false, false, true),
                                  MetaDataLoader.SUBTYPE_MANUAL, "shared-name");
    }

    @Test
    public void keyIsStableForOneInstance() {
        MetaDataLoader a = sameNamed();
        assertEquals("same instance must produce the same key (same-instance init dedup)",
                     a.buildLoaderKey(), a.buildLoaderKey());
    }

    @Test
    public void keyIsUniqueAcrossInstancesWithIdenticalIdentity() {
        MetaDataLoader a = sameNamed();
        MetaDataLoader b = sameNamed();
        assertNotEquals("two distinct loaders sharing class/subType/name must NOT share an activeLoaders key",
                        a.buildLoaderKey(), b.buildLoaderKey());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -q -pl metadata test -Dtest=LoaderKeyIsolationTest`
Expected: `keyIsUniqueAcrossInstancesWithIdenticalIdentity` FAILS (current key = `MetaDataLoader:manual:shared-name` for both) — and it won't compile until `buildLoaderKey` is package-private, so first make it package-private, expect the uniqueness assertion to fail.

- [ ] **Step 3: Implement the per-instance key**

In `MetaDataLoader.java`, add near the top-of-class fields (by `private final String name;` ~line 111):

```java
    // Process-unique instance discriminator. Used ONLY to scope the activeLoaders
    // concurrency-protection key to this instance (#233): two loaders sharing
    // class/subType/name (e.g. two reactor modules with the same <loader> name)
    // must NOT share one init() future — the future loads into whichever instance
    // won the race, leaving the other's tree empty. Not part of identity/equals/
    // hashCode/toString.
    private static final java.util.concurrent.atomic.AtomicLong INSTANCE_SEQ =
            new java.util.concurrent.atomic.AtomicLong();
    private final long instanceId = INSTANCE_SEQ.incrementAndGet();
```

Change `buildLoaderKey()` (drop `private` → package-private for the isolation test; append `instanceId`):

```java
    /**
     * Build a unique key for THIS loader instance for concurrent loading protection.
     * Includes {@link #instanceId} so the activeLoaders dedup only ever coalesces
     * concurrent init() on the same instance (#233). Package-private for
     * {@code LoaderKeyIsolationTest}.
     */
    String buildLoaderKey() {
        return String.format("%s:%s:%s:%d",
                getClass().getSimpleName(), getSubType(), getName(), instanceId);
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -q -pl metadata test -Dtest=LoaderKeyIsolationTest`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/loader/MetaDataLoader.java \
        server/java/metadata/src/test/java/com/metaobjects/loader/LoaderKeyIsolationTest.java
git commit -m "$(cat <<'MSG'
fix(#233): scope activeLoaders dedup key per-instance

Two reactor modules with the same <loader> name shared one init() future
(buildLoaderKey was class:subType:name, no instance discriminator) — module
B's init() rode module A's future and returned A, leaving B's tree empty.
Append a process-unique instanceId so dedup only coalesces the same instance.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: <session-url>
MSG
)"
```

---

### Task 2: Part A — `RegistryBootstrap.warmUpDefaults()`

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/registry/RegistryBootstrap.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/registry/RegistryBootstrapTest.java`

**Interfaces:**
- Produces: `static void RegistryBootstrap.warmUpDefaults()` — idempotent; after it returns, `MetaDataRegistry.getInstance()`, `RegistryManifest.defaultLoaderRegistry()`, `ConstraintEnforcer.getInstance()` are all built.

- [ ] **Step 1: Write the failing test**

`RegistryBootstrapTest.java`:

```java
package com.metaobjects.registry;

import com.metaobjects.constraint.ConstraintEnforcer;
import org.junit.Test;
import java.util.concurrent.*;
import static org.junit.Assert.*;

public class RegistryBootstrapTest {

    @Test
    public void warmUpInitializesAllThreeGlobals() {
        RegistryBootstrap.warmUpDefaults();
        assertNotNull(MetaDataRegistry.getInstance());
        assertNotNull(RegistryManifest.defaultLoaderRegistry());
        assertNotNull(ConstraintEnforcer.getInstance());
    }

    @Test
    public void warmUpIsIdempotent() {
        RegistryBootstrap.warmUpDefaults();
        MetaDataRegistry r1 = MetaDataRegistry.getInstance();
        MetaDataRegistry sealed1 = RegistryManifest.defaultLoaderRegistry();
        RegistryBootstrap.warmUpDefaults();
        assertSame(r1, MetaDataRegistry.getInstance());
        assertSame(sealed1, RegistryManifest.defaultLoaderRegistry());
    }

    @Test(timeout = 30_000)
    public void warmUpIsThreadSafeUnderConcurrentCallers() throws Exception {
        int n = 8;
        CyclicBarrier start = new CyclicBarrier(n);
        ExecutorService pool = Executors.newFixedThreadPool(n);
        CompletableFuture<?>[] fs = new CompletableFuture[n];
        for (int i = 0; i < n; i++) {
            fs[i] = CompletableFuture.runAsync(() -> {
                try { start.await(); } catch (Exception e) { throw new RuntimeException(e); }
                RegistryBootstrap.warmUpDefaults();
            }, pool);
        }
        CompletableFuture.allOf(fs).get(20, TimeUnit.SECONDS); // must not deadlock/throw
        pool.shutdown();
        assertNotNull(MetaDataRegistry.getInstance());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -q -pl metadata test -Dtest=RegistryBootstrapTest`
Expected: FAIL to compile — `RegistryBootstrap` does not exist.

- [ ] **Step 3: Implement `RegistryBootstrap`**

```java
package com.metaobjects.registry;

import com.metaobjects.constraint.ConstraintEnforcer;

/**
 * Deterministic one-time bootstrap of the process-global registry singletons the
 * load/codegen path lazily builds. See ADR/issue #233 and
 * docs/superpowers/specs/2026-08-02-issue-233-maven-parallel-build-deadlock-design.md.
 *
 * <p>Under a concurrent first init (e.g. a parallel Maven reactor, {@code mvn -T}),
 * two threads building {@link MetaDataRegistry#getInstance()},
 * {@link RegistryManifest#defaultLoaderRegistry()} and
 * {@link ConstraintEnforcer#getInstance()} can acquire their independent locks
 * (INSTANCE_LOCK / DEFAULT_LOCK / ServiceRegistryFactory.LOCK + JVM class-init) in
 * different orders and deadlock. This warms them ON A SINGLE THREAD, once, under one
 * lock — every other thread blocks on {@code WARMUP_LOCK} holding nothing, so no two
 * threads ever interleave the inner locks. After warm-up, every access is a lock-free
 * volatile read.</p>
 */
public final class RegistryBootstrap {

    private static volatile boolean warmedUp = false;
    private static final Object WARMUP_LOCK = new Object();

    private RegistryBootstrap() {}

    /** Idempotent. Safe to call from any thread; a warm-up failure propagates. */
    public static void warmUpDefaults() {
        if (warmedUp) return;
        synchronized (WARMUP_LOCK) {
            if (warmedUp) return;
            // Order is immaterial (all three are independent), but keep it fixed.
            MetaDataRegistry.getInstance();            // SPI singleton (+ ServiceRegistryFactory + provider class-inits)
            RegistryManifest.defaultLoaderRegistry();  // sealed loader registry
            ConstraintEnforcer.getInstance();          // constraint enforcer singleton
            warmedUp = true;                           // ONLY after all three build
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -q -pl metadata test -Dtest=RegistryBootstrapTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/registry/RegistryBootstrap.java \
        server/java/metadata/src/test/java/com/metaobjects/registry/RegistryBootstrapTest.java
git commit -m "$(cat <<'MSG'
fix(#233): add RegistryBootstrap.warmUpDefaults deterministic warm-up

Force-initialize the three process-global registry singletons on one thread
under one lock, so a concurrent first-init cannot deadlock on their
independent locks. Idempotent; failure propagates.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: <session-url>
MSG
)"
```

---

### Task 3: Part A — wire the warm-up into the load + mojo entry points

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/loader/MetaDataLoader.java` (`initWithConcurrencyProtection` ~1300)
- Modify: `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AbstractMetaDataMojo.java` (`execute()` ~103)
- Modify: `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataVerifyMojo.java` (`execute()` ~106)

**Interfaces:**
- Consumes: `RegistryBootstrap.warmUpDefaults()` (Task 2).

- [ ] **Step 1: Wire into the loader (library-wide chokepoint)**

In `initWithConcurrencyProtection(long timeoutMs)`, add as the FIRST line (runs on the caller thread, before the commonPool dispatch; covers `init()` and `initWithTimeout()`):

```java
    private MetaDataLoader initWithConcurrencyProtection(long timeoutMs) {
        // #233: deterministically warm the process-global registry singletons on the
        // caller thread BEFORE any parallel first-init can race their locks.
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();
        String loaderKey = buildLoaderKey();
        ...
```

- [ ] **Step 2: Wire into `AbstractMetaDataMojo.execute()` (before Maven's eager registry touch)**

First statement of `execute()` (before the loader null-check is fine; must be before `createLoader(...)` which runs `MavenLoaderConfiguration.configure` → eager `getTypeRegistry().getRegisteredTypes()`):

```java
    public void execute() throws MojoExecutionException, MojoFailureException {
        // #233: warm the global registry singletons before this reactor module's
        // load can race a sibling module's first-init under `mvn -T`.
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();
        if ( getLoader() == null ) {
            throw new MojoExecutionException( "No <loader> element was defined");
        }
        ...
```

- [ ] **Step 3: Wire into `MetaDataVerifyMojo.execute()`**

First statement of its `execute()`:

```java
    public void execute() throws MojoExecutionException, MojoFailureException {
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();   // #233
        if (getLoader() == null) {
            throw new MojoExecutionException("No <loader> element was defined");
        }
        ...
```

- [ ] **Step 4: Verify existing suites still pass (byte-identity of behavior)**

Run: `cd server/java && mvn -q -pl metadata test` then `mvn -q -pl maven-plugin test`
Expected: PASS (all existing loader + mojo tests unchanged; generated output byte-identical).

- [ ] **Step 5: Commit**

```bash
git add server/java/metadata/src/main/java/com/metaobjects/loader/MetaDataLoader.java \
        server/java/maven-plugin/src/main/java/com/metaobjects/mojo/AbstractMetaDataMojo.java \
        server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataVerifyMojo.java
git commit -m "$(cat <<'MSG'
fix(#233): warm the registry before load (loader init + mojo execute)

Call RegistryBootstrap.warmUpDefaults() at the top of
MetaDataLoader.initWithConcurrencyProtection (covers every loader embedder)
and the generate/docs/editor + verify mojo execute()s (covers Maven's
pre-init eager getTypeRegistry() first-touch).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: <session-url>
MSG
)"
```

---

### Task 4: `threadSafe = true` on generate/verify/docs + descriptor test

**Files:**
- Modify: `@Mojo(...)` in `MetaDataGeneratorMojo.java` (~11), `MetaDataVerifyMojo.java` (~67), `DocsMojo.java` (~46)
- Test: `server/java/maven-plugin/src/test/java/com/metaobjects/mojo/MojoThreadSafeDescriptorTest.java`

**Interfaces:**
- `@Mojo` is `RetentionPolicy.CLASS` (not reflectable at runtime), so the test reads the generated `META-INF/maven/plugin.xml` descriptor from the classpath.

- [ ] **Step 1: Write the failing test**

```java
package com.metaobjects.mojo;

import org.junit.Test;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.*;
import static org.junit.Assert.*;

public class MojoThreadSafeDescriptorTest {

    private static String descriptor() throws Exception {
        try (InputStream in = MojoThreadSafeDescriptorTest.class.getClassLoader()
                .getResourceAsStream("META-INF/maven/plugin.xml")) {
            assertNotNull("plugin.xml descriptor must be generated before tests run", in);
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static void assertThreadSafe(String xml, String goal) {
        // Grab the <mojo> block for this goal and assert <threadSafe>true</threadSafe>.
        Matcher m = Pattern.compile("<mojo>(?:(?!</mojo>).)*?<goal>" + goal
                        + "</goal>(?:(?!</mojo>).)*?</mojo>", Pattern.DOTALL).matcher(xml);
        assertTrue("no <mojo> block for goal " + goal, m.find());
        assertTrue("goal " + goal + " must be threadSafe",
                   m.group().contains("<threadSafe>true</threadSafe>"));
    }

    @Test public void generateVerifyDocsAreThreadSafe() throws Exception {
        String xml = descriptor();
        assertThreadSafe(xml, "generate");
        assertThreadSafe(xml, "verify");
        assertThreadSafe(xml, "docs");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server/java && mvn -q -pl maven-plugin test -Dtest=MojoThreadSafeDescriptorTest`
Expected: FAIL — descriptor has `<threadSafe>false</threadSafe>` for these goals.

- [ ] **Step 3: Add `threadSafe = true` to the three `@Mojo` annotations**

Each `@Mojo(...)` gains `, threadSafe = true`. Example (`MetaDataGeneratorMojo`):

```java
@Mojo(name="generate",
      defaultPhase = LifecyclePhase.GENERATE_SOURCES,
      threadSafe = true)
```

Apply the same `threadSafe = true` element to the multi-line `@Mojo` on `MetaDataVerifyMojo` (name="verify") and `DocsMojo` (name="docs"). Do NOT touch `MetaDataEditorMojo` (direct-invocation only) or `AgentDocsMojo` (stub).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server/java && mvn -q -pl maven-plugin test -Dtest=MojoThreadSafeDescriptorTest`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataGeneratorMojo.java \
        server/java/maven-plugin/src/main/java/com/metaobjects/mojo/MetaDataVerifyMojo.java \
        server/java/maven-plugin/src/main/java/com/metaobjects/mojo/DocsMojo.java \
        server/java/maven-plugin/src/test/java/com/metaobjects/mojo/MojoThreadSafeDescriptorTest.java
git commit -m "$(cat <<'MSG'
fix(#233): mark generate/verify/docs mojos threadSafe

Honest declaration now that the shared-state deadlock is fixed (warm-up +
per-instance loader key). Suppresses Maven's not-thread-safe warning; ships
atomically with the fix. editor (direct-invocation) and agent-docs (stub)
are correctly left unmarked.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: <session-url>
MSG
)"
```

---

### Task 5: maven-invoker reactor IT (end-to-end `-T4` guard for Part A + B)

**Files:**
- Modify: `server/java/maven-plugin/pom.xml` — add `maven-invoker-plugin` (install + integration-test + verify), bound to the `verify` phase, with a timeout.
- Create: `server/java/maven-plugin/src/it/settings.xml` (points at the invoker local repo).
- Create: `server/java/maven-plugin/src/it/parallel-reactor/pom.xml` (parent, 3 modules, `<.mvn/maven.config>` with `-T4`).
- Create: `server/java/maven-plugin/src/it/parallel-reactor/.mvn/maven.config` containing `-T4`.
- Create: modules `mod-a`, `mod-b` (SAME `<loader><name>shared</name>`), `mod-c` (distinct name) — each: `pom.xml` binding `metaobjects:generate` at generate-sources + a tiny `metaobjects/*.json` source + a simple committed generator config.
- Create: `server/java/maven-plugin/src/it/parallel-reactor/verify.groovy` (or `invoker.properties` with `invoker.buildResult = success`) asserting each module produced its OWN generated output (proves Part B end-to-end).

**Interfaces:**
- Consumes: the installed plugin (invoker's `install` goal installs the just-built plugin into `target/local-repo`).

- [ ] **Step 1: Scaffold the reactor fixture** — parent pom (packaging `pom`, modules mod-a/mod-b/mod-c), each module binds the `generate` goal at `generate-sources` with a `<loader>` (mod-a and mod-b both `name=shared`; mod-c `name=distinct`), a one-entity `metaobjects/meta.<mod>.json`, and a generator that writes a file whose content includes the module's own entity name. `.mvn/maven.config` = `-T4`.

- [ ] **Step 2: Wire `maven-invoker-plugin`** into `maven-plugin/pom.xml`:

```xml
<plugin>
  <groupId>org.apache.maven.plugins</groupId>
  <artifactId>maven-invoker-plugin</artifactId>
  <configuration>
    <projectsDirectory>src/it</projectsDirectory>
    <cloneProjectsTo>${project.build.directory}/it</cloneProjectsTo>
    <settingsFile>src/it/settings.xml</settingsFile>
    <localRepositoryPath>${project.build.directory}/local-repo</localRepositoryPath>
    <postBuildHookScript>verify</postBuildHookScript>
    <streamLogsOnFailures>true</streamLogsOnFailures>
    <goals><goal>generate-sources</goal></goals>
    <timeoutInSeconds>180</timeoutInSeconds>  <!-- a reintroduced deadlock FAILS, not wedges -->
  </configuration>
  <executions>
    <execution>
      <id>integration-test</id>
      <goals><goal>install</goal><goal>run</goal></goals>
    </execution>
  </executions>
</plugin>
```

- [ ] **Step 3: Run the IT locally**

Run: `cd server/java && mvn -q -pl maven-plugin -am -DskipTests=false verify`
Expected: the invoker runs the reactor with `-T4`; build succeeds; `verify.groovy` confirms mod-a/mod-b/mod-c each generated their own entity output (mod-b did NOT get mod-a's output).
If the invoker infra proves too heavy/flaky in this environment, record that honestly and fall back to a committed reactor + a manual `-T4` run (documented in the PR); do NOT weaken the unit-level guards.

- [ ] **Step 4: Commit**

```bash
git add server/java/maven-plugin/pom.xml server/java/maven-plugin/src/it
git commit -m "$(cat <<'MSG'
test(#233): maven-invoker -T4 reactor IT (parallel-build regression guard)

3-module reactor built with -T4; two modules share a <loader> name (Part B)
and all three must complete without deadlock (Part A). timeoutInSeconds makes
a reintroduced hang fail rather than wedge CI.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: <session-url>
MSG
)"
```

---

### Task 6: Full verification + review gate + PR

- [ ] **Step 1: Byte-identity + full suites.** `cd server/java && mvn -q -pl metadata,maven-plugin,codegen-kotlin,codegen-spring test` — all green. Spot-check an existing golden/generate test output unchanged.
- [ ] **Step 2: Manual `-T4` sanity** — build+install the plugin, run the invoker reactor (or the fixture directly) with `mvn -T4` a few times; confirm completion each time.
- [ ] **Step 3: Per-unit review** — run code-reviewer + code-simplifier on the diff; fix findings in place.
- [ ] **Step 4: no-mistakes gate** — rich `--intent`; ensure `.serena/` + `.worktrees/` are in `.git/info/exclude`.
- [ ] **Step 5: PR** — `Closes #233`; body notes: warm-up + per-instance key + threadSafe labeling; commonPool-sync as a noted (not-filed) follow-up; Maven-only 7.20.x patch. Doug merges.

## Self-Review

- **Spec coverage:** Part A warm-up (Tasks 2–3) ✓; Part B key (Task 1) ✓; threadSafe labeling (Task 4) ✓; testing — Part B deterministic (Task 1), warm-up correctness (Task 2), end-to-end `-T4` (Task 5), byte-identity (Tasks 3,6), descriptor (Task 4) ✓; rejected per-loader isolation documented in spec ✓; accepted residuals (commonPool, parser class-init) — noted in spec, PR mention (Task 6) ✓.
- **Placeholders:** none — production code is exact; the one honest contingency is the invoker-infra fallback (Task 5 Step 3), which names the concrete fallback.
- **Type consistency:** `warmUpDefaults()` (Task 2) used verbatim in Task 3; `buildLoaderKey()` package-private (Task 1) consumed by `LoaderKeyIsolationTest` (Task 1).
