# Java Per-Loader Type Registry — Design

_Date: 2026-05-29. Status: Approved (design); ready for implementation planning._

## Problem

Java's `MetaData.addChild` validates child acceptance against the **process-global
singleton** `MetaDataRegistry.getInstance()` (`MetaData.java:1207`), and enforces
constraints via `ConstraintEnforcer.getInstance()` (`MetaData.java:1218`), which is itself
bound to that singleton (`ConstraintEnforcer.java:42`). The `MetaDataLoader` already carries
a per-instance `typeRegistry` with a public `setTypeRegistry(...)` (`MetaDataLoader.java:702`),
but `addChild` ignores it.

**The other three Loader-bearing ports are instance-scoped.** TypeScript (`TypeRegistry`
class + `composeRegistry()`, threaded through parse/validation), Python (every
parse/validation function takes `registry: TypeRegistry`), and C# (`ParseOptions(TypeRegistry)`,
`ComposeRegistry()`) all resolve the registry from an explicit instance, never a process
global. **Java is the lone outlier.**

Consequences:
- **Multi-tenant / embedding correctness bug.** Two `MetaDataLoader`s with different type
  registries in one JVM (multi-tenant, plugin isolation, parallel tests) cross-contaminate
  in Java — the second loader's child-validation sees the first's registered types. TS/
  Python/C# isolate correctly. For a product sold to many companies, this is a real defect.
- **Conformance fragility (R5).** The Java conformance runner can't give a loader its own
  registry, so it mutates the global singleton (`ensureBriefingRegistered`) and leans on
  alphabetical fixture ordering to keep the provider-extension success/fail fixtures from
  colliding — a pass-by-accident hazard.

## Decision — Approach A

`MetaData.addChild` resolves the registry from its **owning loader**, falling back to the
singleton when the node has no loader:

```java
MetaDataLoader l = getLoader();                  // walks to MetaRoot's loader back-ref
MetaDataRegistry reg = (l != null) ? l.getTypeRegistry() : MetaDataRegistry.getInstance();
```

`reg` is then used for **both** validation sites — `reg.acceptsChild(...)` and a
registry-parameterized constraint-enforcement call.

### Why this is safe and backward-compatible

`MetaDataLoader.getTypeRegistry()` **defaults to the singleton** when no custom registry is
set. So for every consumer who never calls `setTypeRegistry` (i.e. all existing users, 25
years' worth), `reg` *is* `getInstance()` — behavior is byte-for-byte identical. Only
consumers who set a per-loader registry (multi-tenant, plugin isolation, the conformance
harness) get the corrected isolation. The change is additive: it makes a path that was
ignoring the loader's registry honor it.

In `addChild` the parent (`this`) is already attached to the loader-rooted tree at
validation time (validation runs before `data.attachParent(this)`), so `this.getLoader()`
resolves during parse. A programmatically-built, loader-detached node returns `null` and
uses the singleton — unchanged from today.

### Why not Approach B (thread the registry through the parser, like TS/Python/C#)

Java embeds child-validation *inside* `addChild` (object-model-level), not in the parser.
Approach B would relocate validation into the parse pipeline — a far larger refactor with
higher risk — to achieve the same correctness Approach A delivers minimally. Rejected for
this change; the *effect* (loader-scoped registry resolution) matches the other ports
either way.

## Components

1. **`MetaData.addChild`** — resolve `reg` as above; replace the two `getInstance()` uses
   with `reg`. (`getSupportedChildrenDescription` for the error message also moves to `reg`.)
2. **`ConstraintEnforcer`** — add a registry-parameterized enforcement entry point, e.g.
   `enforceConstraintsOnAddChild(parent, child, MetaDataRegistry reg)`, that reads
   constraints from `reg`. The existing no-registry `getInstance()`-bound method delegates
   to it with the singleton, preserving all current callers. (The enforcer's logic is
   registry-agnostic; only its constraint *source* changes.)
3. **Java conformance runner (`ConformanceTest`)** — for each fixture, `compose()` a fresh
   registry from the fixture's required providers and `loader.setTypeRegistry(reg)` (mirroring
   how TS/Python/C# build a per-fixture registry). **Delete `ensureBriefingRegistered`, the
   `briefingRegistered` static, and the alphabetical-ordering dependency** — they become
   unnecessary once the loader honors its own registry.

## Cross-port impact

None outside Java. TS/Python/C#/Kotlin are already instance-scoped. There is **no
wire/metamodel/fixture change** — the canonical serialization and the shared corpora are
unaffected (behavior changes only for multi-registry usage, which the corpora don't and
shouldn't pin). The fix brings Java's *effect* into line with the existing cross-language
norm; consider recording "type-registry resolution is loader-scoped, not process-global"
as an ADR once landed (it is the implicit contract the other three ports already honor).

## Success criteria

1. The full Java `metadata` test suite stays green (196 today), with **no fixture changes**.
2. The provider-extension conformance fixtures pass **without** the singleton-mutation /
   alphabetical-ordering hack — proving the loader honors its own registry. (Closes R5.)
3. A new targeted test demonstrates **two loaders with different `typeRegistry` instances in
   one JVM validate independently** — one accepts a test-only subtype, the other rejects it
   with `ERR_UNKNOWN_SUBTYPE` — regardless of execution order. This is the multi-tenant
   correctness guarantee.
4. Existing single-registry behavior is provably unchanged (the suite + the
   no-`setTypeRegistry` default path).

## Risks & mitigations

- **`addChild` is a hot, core path used everywhere.** Mitigation: the singleton-fallback
  guarantees identical behavior for all non-custom-registry usage; the full suite is the
  gate; `getLoader()` is already called elsewhere in `addChild`-adjacent code (e.g. the
  ClassLoader fallback at `MetaData.java:737`), so it's a proven resolution path.
- **`getLoader()` returning null mid-parse for an edge node.** Mitigation: falls back to the
  singleton (today's behavior) — never worse than current; covered by the existing suite.
- **`ConstraintEnforcer` is a singleton with other callers.** Mitigation: keep the existing
  method signature delegating to the new registry-parameterized one with the singleton; no
  caller breaks.

## Out of scope

- Approach B (relocating validation into the parser).
- Any change to TS/Python/C#/Kotlin (already correct).
- Any wire-format, metamodel, or shared-fixture change.
- Broader registry-lifecycle features (unregister, snapshot/restore) — not needed once
  per-loader resolution works.

## Next step

TDD implementation plan (writing-plans): start with the failing multi-loader-isolation test,
then `MetaData.addChild` + `ConstraintEnforcer`, then refactor the conformance runner and
delete the hack, verifying the full Java suite at each step.
