# Cross-Port Runtime Object Model — Design (Phase A)

_Date: 2026-05-30. Status: approved (design). Phase A of two; Phase B (`docs/superpowers/specs/2026-05-30-recover-codegen-nested-design.md`) — metadata-driven recover — builds on this. Foundational for runtime metadata use cases._

## Problem

Java has a mature **runtime object model**: a `MetaObject` instantiates the right object (POJO **or** `ValueObject`), the instance carries a back-reference to its `MetaObject` (`MetaObjectAware`), and `MetaField` reads/writes fields by name against the underlying object — so any consumer (serializers like `JsonObjectReader`, OMDB persistence, and now recover) can manipulate objects **metadata-driven**, with the backing object **code-generated or not**, transparently.

TS / Python / C# have **none of this**. Their only registry (`TypeRegistry`) registers *metamodel type definitions*, not object-class bindings. There is no `ValueObject`, no instance→`MetaObject` back-reference, no object-class binding registry, and no `newInstance` factory. Object↔class binding there is purely codegen-time. This blocks metadata-driven object manipulation off the JVM — most immediately, metadata-driven recover (Phase B), and more broadly the runtime-metadata pillar's reach into those ports.

Bringing Java's model to the other ports must respect **ADR-0001** (no runtime reflection / `Class.forName` — it breaks .NET Native AOT and GraalVM native-image; TS has no runtime type info at all).

## Goal

A consistent runtime object model across all five ports:

- A `MetaObject` **factory** (`newInstance`) that produces the correct backing object — a map-backed **`ValueObject`** by default, or a **bound (code-generated) type** when one is registered — and sets the instance's `MetaObject` back-reference.
- An instance **back-reference** to its `MetaObject` (`MetaObjectAware`) for fast retrieval (vs. a registry lookup).
- A **field-access SPI**: get/set a field by name, dispatching on the backing object (map vs typed), with nested-object and array handling.
- A **self-registering object-class binding registry** (FQN → constructor), populated by generated code at load — **not** runtime reflection (ADR-0001's endorsed "domain-sliced, FQN-keyed registry").
- The **codegen'd-or-not invariant**: a consumer calls `newInstance` + field get/set and is oblivious to whether the object is a `ValueObject` or a generated POJO. A pure-codegen POJO works identically in every port, exactly as in Java today.

This is the **research-validated `ObjectWrapper` SPI** pattern (MyBatis `ObjectWrapper`/`MapWrapper`/`BeanWrapper`, Hibernate `PropertyAccess`, Avro `GenericRecord` vs `SpecificRecord`), with the universal default in the reflection-free Avro-`GenericRecord` lane.

## Java — the reference (already complete; reconcile + add conformance only)

- `MetaObjectAware extends MetaDataAware<MetaObject>` — `getMetaData()` / `setMetaData(MetaObject)`: the instance back-reference.
- `ValueObject extends ValueObjectBase` (`implements Map<String,Object>`) — map-backed, holds its `MetaObject`, `MetaObjectAware`. Carries overflow values beyond any declared field set.
- Per-subtype default object class: `ValueMetaObject` (`object.value`) → `getDefaultObjectClass() == ValueObject.class`; POJO subtypes resolve to the generated class.
- `ObjectClassRegistry` — FQN→class via `ObjectClassBindingProvider`s (ServiceLoader); `resolve(fqn)` → bound class or null.
- `MetaObject.getObjectClass()` resolution: `@object` attr → `ObjectClassRegistry.resolve(name)` → subtype `getDefaultObjectClass()` (→ ValueObject) → derived-by-package.
- `MetaObject.newInstance()` — resolves the class, instantiates (prefers `Constructor(MetaObject)`, else no-arg + `attachMetaObject`), sets the back-reference (`attachMetaObject` = `if (o instanceof MetaObjectAware) o.setMetaData(this)`).
- `MetaField.setObject/getObject/setString/setInt/…` — field IO dispatching on the backing object; `DataType.OBJECT` / `OBJECT_ARRAY` for nested + arrays.

**Phase A Java work is small:** verify `newInstance` falls back to `ValueObject` cleanly when no class is bound (it does, via `getDefaultObjectClass`); ensure the field-access + factory surface used by Phase B is public + documented; and — the new requirement — **add the shared object-model conformance corpus + a Java runner**. (The default-value unification — folding the legacy `MetaField.getDefaultValue()` / `setDefaultValues()` into a generalized `@default` — lands in **Phase B**; Phase A's `newInstance` simply calls the existing default-population hook.)

## Other ports — what Phase A adds (TS / Python / C#; Kotlin reuses the JVM model)

Each port gains, idiomatically, behavior pinned to Java by the shared conformance corpus:

| Concept | TypeScript | Python | C# |
|---|---|---|---|
| **`MetaObjectAware`** (instance back-ref) | interface + symbol-keyed `getMetaData()`/`setMetaData()` | `Protocol` / `get_meta_data()` / `set_meta_data()` | `IMetaObjectAware` |
| **`ValueObject`** (map-backed, back-ref, overflow) | class over `Record<string, unknown>` | class over `dict` | class over `Dictionary<string,object?>` |
| **object-class binding registry** (FQN→ctor) | new `ObjectClassRegistry` (distinct from metadata `TypeRegistry`) | same | same |
| **registration** (no reflection) | generated module registers its ctor at import | generated module registers at import | generated type registers in a module initializer / explicit provider |
| **default object class per subtype** | `object.value` → ValueObject | same | same |
| **`newInstance` factory** (+ back-ref) | `MetaObject.newInstance()` | `new_instance()` | `NewInstance()` |
| **field-access SPI** (get/set by name; nested/array) | get/set on map or typed accessor | get/set | get/set |

**Field-access SPI** (the consumer-facing contract, conformance-pinned): given a `MetaObject`, a backing object, and a field name — read/write the value; for a nested `OBJECT` field, the consumer resolves the child `MetaObject` (`getObjectRef`) and recurses (`newInstance` child + set); for `OBJECT_ARRAY`, build/read the list. The SPI is object-kind-agnostic — the `ValueObject` impl is map put/get (zero reflection); the typed impl is a generated accessor (C# source-gen-style / TS object index / Python `setattr`).

**Codegen'd-or-not invariant (must hold in every port):** a generated POJO that (a) registers its constructor in the `ObjectClassRegistry` at load and (b) implements `MetaObjectAware` flows through `newInstance` identically to a `ValueObject` — same factory, same back-reference, same field IO. With no registered type, the same `MetaObject` yields a `ValueObject`. Consumers don't branch on which.

## ADR-0001 / AOT alignment

- The **ValueObject path resolves no native class** (it's a map) → reflection-free, AOT-safe, works identically in every port.
- The **typed path** uses the **self-registering** `ObjectClassRegistry` — generated code registers `FQN → constructor` at module load; no `Class.forName` / `Type.GetType` / `importlib`. This is exactly ADR-0001's prescription for OO ports. So Native AOT (C#) and erased-type TS are both satisfied.
- A short **ADR** records this cross-port runtime-object-model contract (the SPI shape, the ValueObject default, the self-registering registry, the codegen'd-or-not invariant).

## Conformance (first-class — corpus + per-port runners)

A new shared corpus `fixtures/object-model-conformance/` (format TBD-in-plan, mirroring existing corpora) drives every port's runtime object model through identical scenarios; each port has a runner asserting identical behavior:

1. **instantiate-value** — `object.value` MetaObject → `newInstance()` yields a ValueObject; its back-reference returns the same MetaObject.
2. **scalar round-trip** — set/get string/int/long/double/boolean by name; values read back equal.
3. **nested object** — a field with an `@objectRef`: `newInstance` the child, `set` it on the parent, `get` it back (identity/equality preserved).
4. **array-of-objects** — set/get a `List<child>`; element back-references resolve.
5. **overflow** — a ValueObject carries a key not in the declared field set (the "metadata holds more than a codegen'd class" property).
6. **bound (codegen'd) type** — register a fixture "POJO" constructor for an FQN; `newInstance` produces it (not a ValueObject); back-reference + scalar/nested/array IO behave identically to the ValueObject case.
7. **no-binding fallback** — same MetaObject with no registered type → ValueObject.

Behavioral assertions (not byte-identity — these are object graphs): the corpus pins *what* each scenario yields (type-kind, back-ref identity, field values, list contents, overflow visibility). Each port's runner is the gate; a divergence is a port bug to fix. (Phase B adds recover-specific conformance on top.)

## Components / files

- **Java**: verify/expose the factory + field-access surface; add the object-model conformance runner. (No new model code expected; small reconciliation.)
- **TS / Python / C#**: `ValueObject`, `MetaObjectAware`-equivalent, `ObjectClassRegistry` (self-registering), per-subtype default object class, `newInstance` factory, field-access SPI; the conformance runner.
- **Kotlin**: reuses the JVM model; its runner exercises the corpus via the Java classes (closing the "Kotlin runs few corpora" gap for this one).
- **Shared**: `fixtures/object-model-conformance/` corpus + README; a new ADR (`spec/decisions/ADR-00XX-cross-port-runtime-object-model.md`).

## Build order & merge strategy

Single branch, single final merge:

1. **Corpus + ADR** — author the shared `object-model-conformance` scenarios + the ADR (the contract the ports implement against).
2. **Java** — reconcile + conformance runner (proves the corpus matches the reference model).
3. **Kotlin** — runner over the JVM model.
4. **TypeScript** — object model + runner.
5. **Python** — object model + runner.
6. **C#** — object model + runner.
7. **Close-out** — KNOWN_GAPS/roadmap/memory; final whole-branch review; merge forward.

Each unit: spec-compliance + code-quality review; the conformance runner is the gold-standard gate. Publish deferred (this is library-internal until Phase B's consumer-facing recover lands).

## Out of scope (explicit)

- Generalized `@default` + the Java default-value unification → **Phase B** (metamodel change; recover consumes it).
- Metadata-driven **recover** itself (nested/array/array-of-enum) → **Phase B**, built on this SPI.
- The full OMDB/persistence runtime — Phase A is only object instantiation + field IO + binding, the subset metadata-driven manipulation needs.
- Reworking the existing Java serializers (`JsonObjectReader`/XML) — they already use this model; out of scope unless a reconciliation gap surfaces.
- Runtime (reflective) native-class resolution in the non-JVM ports — explicitly excluded (ADR-0001).
