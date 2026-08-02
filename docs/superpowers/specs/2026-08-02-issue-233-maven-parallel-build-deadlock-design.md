# #233 — maven-plugin parallel-build deadlock: design

_Date: 2026-08-02 · Issue: [#233](https://github.com/metaobjectsdev/metaobjects/issues/233) · Scope: Java maven-plugin + metadata registry (Maven `7.x` line; a future `7.20.x` patch) · Status: designed, Fable-reviewed (SOUND-WITH-CHANGES)_

## Problem

In a multi-module Maven reactor where several modules bind `metaobjects-maven-plugin`
at `generate-sources` (goal `generate`), a **parallel build** (`mvn -T<N>`, e.g. `-T1C` /
`-T4`) **deadlocks / hangs**. The serial default (`-T1`) always works. Consumers must
forfeit multi-core parallelism on large reactors. Plugin 7.8.0 · Maven 3.9.x · JDK 21.

## Root cause (confirmed against the code)

The load path, on **first** initialization, concurrently builds several
independently-locked process-global static singletons, and two loader threads can
acquire the locks in **different orders** → classic lock-ordering deadlock. The players
(all in `server/java/metadata/src/main/java/com/metaobjects/`):

- `registry/RegistryManifest.defaultLoaderRegistry()` — `static volatile` + `DEFAULT_LOCK`
  DCL. The loader's **sealed** registry (explicit `metamodelProviders()` set, sealed →
  read-only after build). Returned by `MetaDataLoader.getTypeRegistry()` by default.
- `registry/MetaDataRegistry.getInstance()` — `static volatile instance` + `INSTANCE_LOCK`.
  A **separate**, unsealed SPI-scanned singleton, reached during load via
  `constraint/ConstraintEnforcer.getInstance()` (its own `volatile instance` + `INIT_LOCK`),
  whose constructor calls `MetaDataRegistry.getInstance()`. `ConstraintEnforcer.getInstance()`
  fires on the **first `MetaData.addChild(...)`** of every load. (The enforcer validates
  against the loader's *resolved* sealed registry passed as an argument — so the SPI
  singleton's content is irrelevant to load validation; only its *construction* is a hazard.)
- `registry/ServiceRegistryFactory.getDefault()` — `static volatile` + static `LOCK`; built by
  both registries' construction. `create()` → `new StandardServiceRegistry()` (thread-context CL).
- \+ JVM class-init locks for the ~18 provider/type classes those registrations trigger.

**Unbounded hang site.** `MavenLoaderConfiguration.configure(...)` eagerly calls
`loader.getTypeRegistry().getRegisteredTypes()` — a first-touch of `defaultLoaderRegistry()`
on the **Maven worker thread with no timeout** — *before* `configure()` → `loader.init()`.
The commonPool side (below) has a 30 s timeout; this call site does not, so a deadlock here
wedges the reactor forever (matches the reported symptom).

**`CoreTypeInitializer` is dead code** — zero callers repo-wide (its `static{}` never runs).
Listed as a suspect in the issue; **not** an actual hazard.

**Secondary correctness bug (not the hang).** The load runs on `ForkJoinPool.commonPool()`:
`MetaDataLoader.configure()` → `init()` → `initWithConcurrencyProtection(30_000ms)` →
`activeLoaders.computeIfAbsent(loaderKey, key -> supplyAsync(() -> performInitialization(key), commonPool()))`.
`buildLoaderKey()` = `simpleName + ":" + subType + ":" + name` — **no sources**, and there
are **no `MetaDataLoader` subclasses in main source**, so the key is in practice always
`MetaDataLoader:manual:<name>`. Two reactor modules sharing a `<loader>` name therefore share
one future: module B's `init()` **returns loader A**, B's `loadingState` stays UNINITIALIZED,
`configure()` discards the return, and B's generators run against an empty tree — silent wrong
output under `-T`.

## Decision

Chosen approach (Doug's call, refined by the Fable review):

1. **Deadlock-proof the one-time global bootstrap with a deterministic warm-up** — *not*
   per-loader registry isolation. The loader registry is sealed/read-only after build, so
   sharing it across threads is already safe; the only hazard is the concurrent *first-build*.
   A single-threaded warm-up eliminates it while keeping the shared sealed registry
   (byte-identical vocabulary, built once). Per-loader isolation via `createWithCoreProviders()`
   was **rejected**: that method does a `ServiceLoader` scan, reintroducing the exact classpath
   pollution the sealed explicit-provider set exists to prevent, plus N× redundant registry builds.
2. **Fix the `activeLoaders` cross-module collision** by keying the dedup on a per-instance id.
3. **Mark the reactor-bound mojos `threadSafe = true`** — honest labeling (see note below),
   shipped atomically with 1 + 2.

### Note: `threadSafe = true` is labeling, not the fix

Maven 3.x does **not** serialize non-threadSafe mojos under `-T` — it prints a warning and runs
them in parallel anyway. The deadlock fix is entirely the warm-up + the key fix. `threadSafe = true`
is the correct declaration and suppresses the (now-accurate) "not marked thread-safe" warning; it
must land in the **same** release as parts A + B, never before (declaring it without the fix would
silence the warning while the deadlock remained).

## Part A — deadlock fix (warm-up + threadSafe)

**New class `com.metaobjects.registry.RegistryBootstrap`** (metadata module) with an idempotent
static `warmUpDefaults()`:

```java
private static volatile boolean warmedUp = false;
private static final Object WARMUP_LOCK = new Object();

/** Deterministically initialize every process-global registry static the load/codegen
 *  path lazily builds — once, on a single thread, before any parallel load — so a
 *  concurrent first-init cannot deadlock on the independent locks. Idempotent. */
public static void warmUpDefaults() {
    if (warmedUp) return;
    synchronized (WARMUP_LOCK) {
        if (warmedUp) return;
        MetaDataRegistry.getInstance();               // SPI singleton (+ ServiceRegistryFactory + provider class-inits)
        RegistryManifest.defaultLoaderRegistry();     // sealed loader registry
        ConstraintEnforcer.getInstance();             // constraint enforcer singleton
        warmedUp = true;                              // set ONLY after all three build
    }
}
```

- **`warmedUp` is set only after all three succeed;** a warm-up exception propagates and fails
  the caller loudly (do not swallow — a poisoned singleton must not be masked as "warmed").
- **Deadlock-free argument.** The only multi-lock init sequence runs on one thread while every
  other thread blocks on the single `WARMUP_LOCK` holding **nothing** → no two threads ever
  interleave the independent inner locks (INSTANCE_LOCK / DEFAULT_LOCK / ServiceRegistryFactory.LOCK
  / JVM class-init). After warm-up, every access is a lock-free volatile read.
- **No re-entrancy.** None of `getInstance()` / `defaultLoaderRegistry()` /
  `ConstraintEnforcer`-construction calls back into `warmUpDefaults()` or `MetaDataLoader.init()`
  (verified: registrations are pure registry-builder calls; historical `<clinit>` bootstraps were
  deliberately removed). The warm-up is deliberately **not** placed inside the getters, which would
  recurse.

**Call sites (both, library-level + Maven-level):**

- **`MetaDataLoader.init()`** — first statement, before `initWithConcurrencyProtection(...)`.
  Covers **every** loader-based embedder (Spring, parallel test runners, servers), not just Maven.
  `init()` is a clean chokepoint the warmed getters never call back into.
- **`AbstractMetaDataMojo.execute()`** (covers generate/docs/editor) and
  **`MetaDataVerifyMojo.execute()`** (covers verify) — first statement, before
  `createLoader(...)`/`MavenLoaderConfiguration.configure(...)`. Required because the Maven
  eager `getTypeRegistry().getRegisteredTypes()` first-touch precedes `init()`.

Calling `warmUpDefaults()` twice is a no-op (idempotent volatile short-circuit).

**`@Mojo(threadSafe = true)`** on `MetaDataGeneratorMojo` (generate), `MetaDataVerifyMojo`
(verify), `DocsMojo` (docs). **Not** on `MetaDataEditorMojo` (`requiresDirectInvocation = true`,
`defaultPhase = NONE` — cannot be bound into a reactor lifecycle) nor `AgentDocsMojo` (a
throw-immediately stub that never touches a loader).

## Part B — cross-module loader-sharing fix

`MetaDataLoader` gets a **process-unique instance id**:

```java
private static final java.util.concurrent.atomic.AtomicLong INSTANCE_SEQ = new AtomicLong();
private final long instanceId = INSTANCE_SEQ.incrementAndGet();
```

`buildLoaderKey()` appends `instanceId`, so `activeLoaders` dedup only ever coalesces concurrent
`init()` on the **same** instance. Two modules with identical name/subType/class never share a
load. Backward-compatible: every internal key user (`initWithRetry`, `isInitializationInProgress`,
`shutdown`, `getActiveInitializationCount`) operates on one instance's key; `cleanupFailedInitializations`
has no external callers. `instanceId` participates in **nothing** but the key (not equals/hashCode/toString).

## Accepted residuals / non-goals

- **commonPool async is unnecessary once Part B lands** (the caller always immediately blocks on
  `future.get()`). Running `performInitialization` synchronously on the caller would remove commonPool
  and its 30 s-from-submit timeout window entirely. Out of scope for #233 (broader loader-behavior
  change); noted in the PR, no separate ticket (fix-in-place doctrine).
- **Parser-pipeline class-init hardening** (a throwaway warm-up load to single-thread
  `BaseMetaDataParser.<clinit>` etc.) is **not** included: Fable found no concrete `<clinit>`→app-lock
  edge, and doing a throwaway load inside `warmUpDefaults()` reintroduces the re-entrancy trap
  (`init()` → warm-up → load → `init()`). The three-getter warm-up covers the confirmed hazard.
- `CoreTypeInitializer` (dead code) is left untouched.

## Testing

- **Part B (deterministic, metadata module).** Two loaders, same class/subType/name, **different**
  `fromString` sources, concurrent `init()` via a latch: assert each `init()` returns **its own**
  instance and each tree holds **its own** entities. Pre-fix the sharpest failure is that
  `B.init()` returns **A** and `B.isInitialized()` is false. Companion test pinning preserved
  semantics: two threads calling `init()` on the **same** instance coalesce onto one future. Plus a
  trivial `buildLoaderKey()`-uniqueness unit test across two identically-named instances.
- **Part A (metadata module).** `warmUpDefaults()` idempotent + thread-safe under N concurrent
  callers (all complete; the three singletons non-null and identical across calls).
- **End-to-end `-T4` reactor verification (manual, documented — NOT a committed IT).** A 3-module
  reactor — mod-a + mod-b sharing `<loader> name=shared`, mod-c distinct — each binding
  `metaobjects:docs` (loads metadata, no `<generators>` config needed), built with `mvn -T4`. A
  committed maven-invoker IT was **considered and declined**: the Part B collision it would catch is
  already deterministically covered by `LoaderKeyIsolationTest`, and the Part A deadlock is
  probabilistic (didn't surface end-to-end because the Part B collision fails the build first), so an
  invoker IT adds heavy infra (invoker plugin + local-repo plumbing + the plugin's full dep tree) for
  mostly-redundant, partly-probabilistic coverage. Instead the fix was verified by a before/after run
  (see result below).
  **Result:** pre-fix (`origin/main` plugin) **8/8** `-T4` runs FAILED — the shared-name module errored
  `MetaDataLoader [shared] is not usable. Phase: UNINITIALIZED` (the exact Part B collision);
  post-fix **5/5** `-T4` runs succeeded with each module correctly emitting only its own entity.
- **maven-plugin (MojoRule).** Existing generate/verify/docs tests stay green (**byte-identical**
  output — same shared sealed registry, only the getInstance-vs-defaultLoaderRegistry *build order*
  flips, and they are independent registries). A reflection test asserting generate/verify/docs are
  `threadSafe = true`.
- **Manual.** Build + install the fixed plugin, run the invoker reactor with `-T4` several times to
  confirm completion.
- **Suites.** Full `metadata` + `maven-plugin` + `codegen-kotlin` + `codegen-spring` green.

**Honest limitation.** A shared-JVM unit test cannot *deterministically* reproduce the cold-first-init
deadlock (the statics warm once per JVM; `RegistryManifest` has no reset). The invoker IT (fresh JVM
per reactor) is the faithful regression guard; the metadata-module Part A tests prove warm-up
correctness, not the hang. Part B **is** deterministically tested.

## Verification checklist

- [x] Existing maven-plugin MojoRule tests green (24); metadata suite green (1272) — behavior byte-identical.
- [x] `LoaderKeyIsolationTest` (Part B) — distinct instances get distinct keys; pre-fix would collide.
- [x] Manual `-T4` reactor: pre-fix 8/8 FAIL (`... is not usable. Phase: UNINITIALIZED`), post-fix 5/5 pass with per-module isolation.
- [ ] `metadata` + `maven-plugin` + `codegen-kotlin` + `codegen-spring` suites green (Task 6 full pass).
- [x] generate/verify/docs mojos report `threadSafe = true` (`MojoThreadSafeDescriptorTest`).
