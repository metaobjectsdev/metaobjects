# ADR-0014 — Type-registry resolution is loader-scoped, not process-global

**Status:** Accepted — 2026-05-29
**Applies to:** All five ports (TypeScript reference + Java / Python / C# / Kotlin); the loader + child-acceptance/constraint validation path.
**Related:** ADR-0001 (cross-language type binding), ADR-0002 (open-closed typed nodes), ADR-0013 (logical field types vs. physical column attributes). Implemented for Java by `docs/superpowers/specs/2026-05-29-java-per-loader-registry-design.md`.

## Context

The type registry maps `(type, subType)` to a `TypeDefinition` and drives child-acceptance and constraint validation during load. Three of the four Loader-bearing ports resolve it **instance-scoped**: the registry is an explicit input threaded through parse/validation — TypeScript (`TypeRegistry` + `composeRegistry()`), Python (every parse/validation function takes `registry: TypeRegistry`), C# (`ParseOptions(TypeRegistry)` + `ComposeRegistry()`).

**Java was the outlier.** `MetaData.addChild` validated against the **process-global singleton** `MetaDataRegistry.getInstance()`, even though `MetaDataLoader` already carried a per-instance `typeRegistry` (`setTypeRegistry`) that was ignored. Consequences:

- **Multi-tenant / embedding correctness bug.** Two loaders with different type registries in one JVM cross-contaminated — the second loader's validation saw the first's registered types. For a product used by many companies (multi-tenant, plugin isolation, parallel tests), that is a real defect.
- **Conformance fragility.** The Java conformance runner could not give a loader its own registry, so it mutated the global singleton and relied on alphabetical fixture ordering to keep two provider-extension fixtures from colliding (a pass-by-accident hazard).

## Decision

**Child-acceptance and constraint validation resolve the type registry from the owning loader, falling back to the process-global singleton only for loader-detached nodes.** A loader may be run against an isolated registry; when none is set, the loader's registry defaults to the singleton, so existing single-registry behavior is unchanged.

This is the **cross-language contract**: registry resolution is loader-scoped (instance), not process-global. TS/Python/C# already honor it by construction; Java now matches.

Java realization (this is the reference for how the contract is met on a singleton-bootstrapped port):
- `MetaData.addChild` resolves `getLoader().getTypeRegistry()` (singleton fallback) for both `acceptsChild` and constraint enforcement.
- `ConstraintEnforcer` gained a registry-parameterized `enforceConstraintsOnAddChild(parent, child, registry)`; the no-arg method delegates with the singleton.
- `MetaDataRegistry.createWithCoreProviders()` builds a fresh, isolated, core-populated registry for consumers to hand a loader via `setTypeRegistry`.
- The ServiceLoader bootstrap (`CoreTypeMetaDataProvider`) registers **both** `metadata.base` (`MetaData`) and `metadata.root` (`MetaRoot`) onto the supplied registry, so an isolated registry bootstraps identically to the singleton. `MetaRoot.registerTypes` is idempotent.

## Consequences

- **Multi-tenant / embedding / plugin isolation works** in every port: a loader validates against exactly the type system it was given.
- **Backward-compatible.** Consumers who never set a custom registry are unaffected (the loader's registry is the singleton).
- **Conformance can compose per-fixture registries** instead of mutating global state — the Java provider-extension fixtures are now order-independent (closes the R5 hazard in `docs/superpowers/specs/2026-05-29-conformance-hardening-review.md`).
- The fix is consistent with ADR-0001 (binding/validation keyed off the resolved type system, not a process global) and ADR-0002 (subtype behavior on node classes).

## Alternatives considered (rejected)

- **Leave Java on the global singleton.** Rejected — it's a multi-tenant correctness bug and a cross-language divergence.
- **Thread the registry through the parser (relocate validation out of `addChild`).** More faithful to TS/Python/C#'s structure, but a far larger refactor; resolving from the owning loader in `addChild` achieves the same isolation with a minimal, backward-compatible change.

## Conformance note

No wire-format, metamodel, or shared-fixture change — the canonical serialization and the cross-port corpora are unaffected (behavior differs only for multi-registry usage, which the corpora do not pin). The contract is verified per-port by each port's existing instance-scoped design; Java additionally ships `PerLoaderRegistryTest` proving two loaders validate independently, order-independently.
