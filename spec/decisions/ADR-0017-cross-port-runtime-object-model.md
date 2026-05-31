# ADR-0017 — Cross-port runtime object model

**Status:** Accepted — 2026-05-30
**Applies to:** All five ports (TypeScript reference + Java / Python / C# / Kotlin); the runtime layer that instantiates and manipulates metadata-described objects (extract, serializers, runtime metadata access).
**Related:** ADR-0001 (cross-language type binding), ADR-0005 (object representation binding), ADR-0002 (open-closed typed nodes). Designed in `docs/superpowers/specs/2026-05-30-cross-port-runtime-object-model-design.md`. Conformance corpus: `fixtures/object-model-conformance/`.

## Context

Java has a full **runtime object model**: `MetaObject.newInstance()` is a factory that returns either a map-backed `ValueObject` or a registered codegen'd native type; instances carry a `MetaObjectAware` back-reference to their `MetaObject`; an `ObjectClassRegistry` maps an object FQN to a constructor; and fields are read/written by name through a get/set SPI.

The other ports do not have this. **TS / Python / C# ship only a metadata `TypeRegistry`** — a `(type, subType)` → `TypeDefinition` map that drives load-time validation. There is no runtime way to instantiate the object an entity/value MetaObject describes, attach the describing MetaObject to that instance, or get/set its fields by name. That gap blocks any metadata-driven *object manipulation* off the JVM — most immediately the tolerant `extract` parser (FR-010/FR-011) and serializers, which need to materialize and populate an instance generically.

The obvious shortcut — resolve a native class from its FQN at runtime and instantiate it reflectively — is forbidden by **ADR-0001**: `Class.forName` / `Type.GetType` / `importlib` / `reflect-metadata` break under .NET Native AOT and GraalVM native-image, and TypeScript carries no runtime type information at all. Any cross-port runtime object model must therefore work **without runtime reflection**.

## Decision

Adopt a single, consistent **cross-port runtime object model** in every port:

- **(a) Map-backed `ValueObject` is the universal default backing object.** When an object MetaObject resolves to no native class, instantiation yields a map-backed `ValueObject`. This path requires no native type information — it is reflection-free and AOT-safe — and is the default for `object.value`.
- **(b) Instances carry a `MetaObject` back-reference** (the `MetaObjectAware`-equivalent in each port), so any instance can report the MetaObject that describes it. Nested and array-element instances each carry their own back-reference.
- **(c) A self-registering `ObjectClassRegistry` maps object FQN → constructor**, populated by **generated code at load time** — never `Class.forName` / `Type.GetType` / `importlib` / `reflect-metadata`. This is exactly ADR-0001's domain-sliced, FQN-keyed registry: typed binding is established by self-registration of generated types, not runtime discovery.
- **(d) `MetaObject.newInstance()` resolves the registry first** (returning a bound constructor's instance when one is registered for the FQN) and otherwise falls back to the subtype default (a `ValueObject`); in both cases it sets the instance's MetaObject back-reference.
- **(e) A field get/set-by-name SPI** dispatches to the map for a `ValueObject` and to the typed accessor for a bound native instance.

Consumers call `newInstance()` + get/set by name and are **oblivious to whether the backing object is a codegen'd native type or a `ValueObject`** — the two are behaviorally interchangeable for scalar, nested-object, and array-of-object access.

The behavioral contract is pinned by the shared corpus `fixtures/object-model-conformance/` (instantiate-value, scalar round-trip, nested object, array of objects, overflow, bound type, no-binding fallback), which every port's runner executes.

## Consequences

- **Consistent runtime metadata manipulation across all ports.** extract + serializers build directly on `newInstance` + get/set, so they port off the JVM without per-port special-casing.
- **The `ValueObject` path is AOT-safe and reflection-free** — it is always available regardless of whether any native type is registered, satisfying ADR-0001 on every target including .NET Native AOT, GraalVM native-image, and TS.
- **Typed binding stays generated and self-registered.** Native types are bound only via the codegen-populated `ObjectClassRegistry`; nothing resolves a class from a string at runtime.
- **Phase B builds on this**: metadata-driven `extract` and a generalized `@default` materialize and populate instances through this model.
- A small new runtime surface (`ValueObject`, the back-reference contract, `ObjectClassRegistry`, the `newInstance` factory, the get/set SPI) must be added to the four non-Java ports and kept conformant; Java already has it and serves as the reference.

## Alternatives considered (rejected)

- **Runtime reflection from FQN → class.** Rejected by ADR-0001 — breaks Native AOT / native-image and is impossible in TS.
- **Leave the model JVM-only and special-case extract/serializers per port.** Rejected — it duplicates the materialize-and-populate logic in every port and diverges behavior; a shared object model is the smaller, conformance-pinnable surface.

## References

- ADR-0001 — cross-language type binding (build-time, self-registered, no runtime reflection).
- ADR-0005 — object representation binding.
- Research precedent — MyBatis `ObjectWrapper` / `MapWrapper` / `BeanWrapper`; Hibernate `PropertyAccess`; Apache Avro `GenericRecord` (map-backed) vs. `SpecificRecord` (generated) — the same generic-vs-bound split this ADR adopts.
