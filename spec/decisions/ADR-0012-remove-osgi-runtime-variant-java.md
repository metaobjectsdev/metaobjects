# ADR-0012 — Remove the OSGi runtime variant from the Java port

**Status:** Accepted — 2026-05-28
**Applies to:** Java port + Kotlin facade (Kotlin runs on the JVM via `metadata-ktx` and `codegen-kotlin`; both inherit the registry from Java).
**Related:** ADR-0001 (cross-language type binding — same anti-reflection argument that motivates this), ADR-0004 (provider-based type registration — the path that survives), `server/java/MIGRATION.md` § "OSGi support removed".

## Context

The Java port shipped a parallel **OSGi runtime variant** alongside the standard `java.util.ServiceLoader`-backed `ServiceRegistry` from the earliest 6.x releases. Concretely, this meant:

- A `ServiceRegistry` interface with OSGi-specific methods (`isOSGIEnvironment`, `onBundleEvent(Object)`, `cleanupForBundle(Object)`, `isBundleLifecycleActive()`, `getBundleLifecycleStatus()`).
- An `OSGIServiceRegistry` implementation (450 LoC) that wrapped a `BundleContext` and tracked services across bundles.
- A `BundleLifecycleManager` (322 LoC) that handled `Bundle` start/stop events and kept the registry consistent across bundle lifecycles.
- A `ServiceRegistryFactory` that reflected on `org.osgi.framework.BundleContext` / `FrameworkUtil` at runtime to decide whether to construct the OSGi variant or the standard one.
- `<packaging>bundle</packaging>` on all reactor modules, with per-module `org.apache.felix:maven-bundle-plugin` configuration generating OSGi manifest headers (`Bundle-SymbolicName`, `Export-Package`, `Import-Package`).
- `WeakReference`-keyed cache strategies inside `HybridCache`, `MetaData`, and `StandardServiceRegistry` justified in javadoc as "OSGi-compatible" patterns to survive bundle reload.
- A test-only `MockBundle` / `MockBundleContext` / `ServiceReferenceLeakTest` infrastructure to exercise the lifecycle paths.

The OSGi variant added genuine value when industrial Eclipse RCP and Apache Karaf consumers were a meaningful share of the audience. By 2026 the cost-benefit had shifted.

## What changed in the ecosystem

Two independent signals converged:

**The Java framework market consolidated away from OSGi.** Surveys and adoption indices through 2026 show Spring Boot, Quarkus, and Micronaut absorbing the cloud-native and microservices share that mid-2010s OSGi proponents anticipated. OSGi adoption today is concentrated in legacy Eclipse RCP, Apache Karaf, and a niche slice of industrial-IoT projects where hot-swappable bundle deployment is a hard requirement.

**Java 9 JPMS partly displaced OSGi's modularity story.** Strong encapsulation of `module-info.java` removed one of OSGi's main differentiators for greenfield projects that wanted package-level visibility control without the bundle lifecycle complexity.

In parallel, the MetaObjects project itself moved on from "Java with an optional OSGi posture":

- The 7.0.0 `server/java/README.md` (the post-consolidation rewrite) did not mention OSGi at all — the framing is "Java port of the cross-language standard, published to Maven Central as plain Maven artifacts."
- ADR-0001 (cross-language type binding) committed the standard to **build-time type binding via providers**, not runtime reflection. The provider model that ADR-0004 ratified is ClassLoader-friendly out of the box and does not depend on OSGi's bundle-scoped service registry to be portable.
- The five-port conformance corpora (metamodel, render, persistence, api-contract, verify) were specified to be runtime-environment-agnostic; nothing in the cross-port contract presupposes OSGi.

## Decision

**Remove the OSGi runtime variant from the Java port.** Ship plain JAR artifacts only. `StandardServiceRegistry` (Java `ServiceLoader`-backed) becomes the sole `ServiceRegistry` implementation. The `ServiceRegistry` interface drops its OSGi-specific methods.

Concretely, in the 7.0.1-SNAPSHOT cleanup line:

- Delete `metadata/src/main/java/com/metaobjects/registry/osgi/` (`OSGIServiceRegistry`, `BundleLifecycleManager`).
- Delete the OSGi test infrastructure (`MockBundle`, `MockBundleContext`, `ServiceReferenceLeakTest`).
- Drop the OSGi methods from `ServiceRegistry`: `isOSGIEnvironment`, `onBundleEvent(Object)`, `cleanupForBundle(Object)`, `isBundleLifecycleActive()`, `getBundleLifecycleStatus()`.
- Simplify `ServiceRegistryFactory.create()` to return a `StandardServiceRegistry` — no reflection-based OSGi detection, no `createOSGI(BundleContext)` factory.
- Remove the `org.apache.felix:maven-bundle-plugin` block from the parent pom `<pluginManagement>` and from each module's plugin overrides.
- Remove the OSGi properties from the parent pom (`bundle.plugin.version`, `osgi.export`, `osgi.import`, `osgi.private`, `osgi.embed`, `osgi.embed.dir`, `osgi.activator`, `osgi.dynamic`).
- Switch `<packaging>bundle</packaging>` → `<packaging>jar</packaging>` on every reactor module that declared it.
- Update javadoc on `MetaData`, `HybridCache`, `MetaDataLoaderRegistry`, `StandardServiceRegistry` to drop OSGi-specific framing while keeping the `WeakReference` patterns themselves — those patterns are general ClassLoader-leak prevention, not OSGi-specific.

## What this is *not*

This ADR does not claim that the OSGi variant was wrong in 6.x. The decision is purely about **what the Java port should carry forward at 7.0.x given the 2026 ecosystem.** A consumer running inside an OSGi container today can still wrap MetaObjects' plain JARs with `bnd` or `pax-url` to produce bundles with appropriate manifest headers — the code itself works in any classloader environment. The change is: MetaObjects no longer ships native OSGi metadata or a bundle-aware registry, and the test gate no longer exercises OSGi-specific code paths.

## Alternatives considered

**Alternative 1 — Keep OSGi support and add integration tests.** Pax Exam or BND test-bundle infrastructure exists for verifying OSGi-deployed code. The MetaObjects test suite never had it; the OSGi paths were unit-tested via `MockBundle` fakes that did not catch real bundle-lifecycle drift. A real OSGi gate would have cost a meaningful CI investment (Pax Exam launches a container per test class) on top of the ~770 LoC of production code already being maintained. Rejected as not worth the cost given the current consumer mix.

**Alternative 2 — Keep the bundle manifest headers but drop the runtime variant.** A middle path: emit `Bundle-SymbolicName` / `Export-Package` in the manifest via `bnd-maven-plugin`, but drop `OSGIServiceRegistry` and the bundle lifecycle code. This would let JARs continue to be deployable to an OSGi container without the bundle wrapper step. Rejected because (a) the consumer reach of this would be very narrow — anyone willing to deploy MetaObjects to an OSGi container in 2026 is also capable of running a `bnd` wrap step — and (b) maintaining the manifest contract (correct exports for every public package) is real ongoing work, and getting it subtly wrong is worse than not shipping it.

**Alternative 3 — Move OSGi support to an opt-in adapter module.** Ship `metaobjects-metadata-osgi` alongside `metaobjects-metadata`. Rejected because the OSGi variant's complexity was concentrated in the lifecycle code that needs to weave through the *core* registry, not in a thin adapter on top of it. An honest opt-in module would replicate or reach into core internals — either is worse than just dropping the path.

## Consequences

**+** Removes ~770 LoC of production OSGi code, ~600 LoC of OSGi test scaffolding, ~50 lines of OSGi-specific parent-pom configuration, and 7 per-module bundle plugin blocks. The metadata module's surface area drops meaningfully — `ServiceRegistry` is a tighter, more cross-port-comprehensible interface, and `StandardServiceRegistry` is THE registry rather than "the default registry."

**+** Aligns the Java port's framing with what the 7.0.0 README and the cross-port standard pitch describe — plain JARs published to Maven Central, no special runtime posture. Reduces the gap between the documented surface and the actual surface.

**+** Removes a quietly-failing test path. The OSGi unit tests passed against `MockBundle` fakes that did not exercise a real OSGi container; the gate was approximately ceremonial. Removing it acknowledges the test coverage was thinner than its file count implied.

**+** The Kotlin facade (`metadata-ktx`, `omdb-ktx`) and Spring auto-configuration (`core-spring`) become simpler, because their javadoc and integration story no longer have to address "and also OSGi" caveats.

**−** OSGi consumers who depended on the native variant must wrap MetaObjects JARs with `bnd` / `pax-url` themselves. The MIGRATION.md "OSGi support removed" section documents the path, but the friction is real for the affected (small) audience.

**−** Loses optionality. If OSGi adoption rebounds for a reason we cannot anticipate, restoring native support would mean re-introducing the lifecycle code and re-establishing a real OSGi gate. The git history preserves the 6.x implementation, so this is recoverable but not cheap.

**−** A small audience of consumers who used the OSGi support purely for the *bundle manifest headers* (Export-Package etc.) inside an OSGi container loses those headers from MetaObjects-built JARs. They must now produce bundles via wrap rather than consuming the artifacts directly.

## Cross-port footprint

This ADR is **Java-scoped** (Kotlin inherits via the metadata-ktx facade). The other ports (TypeScript, Python, C#) have no parallel concept to remove — none of them shipped OSGi-equivalent runtime variants, and their packaging stories (npm, PyPI, NuGet) do not have an OSGi analog. The cross-port `MetaDataTypeProvider` / `composeRegistry` contract is unchanged and stays the canonical extension surface across all five ports.
