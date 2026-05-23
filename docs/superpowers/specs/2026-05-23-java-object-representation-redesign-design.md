# Java Object Representation Redesign — two MetaObjects + a thin adapter hook

**Status:** Design approved 2026-05-23. Supersedes the `ObjectRepresentationResolver` design from WA2 (the in-progress "WA2 — object.entity/value + binding-resolved representation" plan). Amends [ADR-0005](../../../spec/decisions/ADR-0005-object-representation-binding.md).

**Scope:** Java port only. The cross-language metamodel vocabulary is unaffected (it stays `object.entity` / `object.value`); no other port (TS, C#, Python) gains anything from this.

---

## 1. Problem

WA2 set out to move Java objects to the cross-language standard (`object.entity` / `object.value`) and resolve the Java *representation* (reflection vs map vs proxy) from the binding, per ADR-0005's resolver model. While retiring the `metadata`-module representation subtypes (`object.pojo`/`map`/`proxy`), running the **full** reactor surfaced an architecture the original WA2 research never saw: the `dynamic` module already carries a second, richer representation hierarchy that `ObjectManager` actually uses.

```
MetaObject (abstract, metadata)
├── PojoMetaObject   (metadata, "pojo")   — reflection get/set
│     └── DataMetaObject  (dynamic, "data")  — HYBRID: map for ValueObject/DataObject, reflection otherwise
│           └── ValueMetaObject (dynamic, "value") — map-backed, runtime object = ValueObject
│     └── ManagedMetaObject (om, "managed") — stateful pojo
├── MappedMetaObject (metadata, "map")   — map get/set
└── ProxyMetaObject  (metadata, "proxy") — dynamic proxy over an interface
```

Two concrete failures fell out of this:

1. **`object.value` already existed.** `ValueMetaObject` (dynamic) registers `object.value`. WA2's Task 2 registered `object.value → MappedMetaObject`, producing a duplicate-registration collision once `dynamic` is on the classpath.
2. **The resolver's heuristic is wrong for this codebase.** ADR-0005 says "bound concrete class → reflection." But the omdb fixtures bind `@object="com.metaobjects.object.value.ValueObject"` — a *map-backed* concrete class. The resolver dutifully picked `PojoMetaObject` → reflection → `NoSuchMethodError: No getter exists named [...] on ValueObject` (3 omdb tests: `JsonbFieldDBTest.testValueObjectFallbackWhenNoBinding`, `testTypedJsonbRoundTrip`, `FruitDBTest.testBasket`).

Root cause: representation is **per-live-object**, not per-declared-class, and the existing `DataMetaObject` already knew that (it checks `instanceof ValueObject` at access time). The per-node resolver was the wrong layer, and it couldn't even see the `dynamic` classes (`metadata` is upstream of `dynamic`).

A secondary observation: the whole proxy/data/map/managed sprawl was, in the maintainer's words, "super sophisticated crap" — theoretical flexibility almost nobody uses. The practical representations are exactly two: a **POJO** (reflection) and a **value object** (map).

## 2. Decisions (locked during brainstorming, 2026-05-23)

1. **Two MetaObject classes only:** `EntityMetaObject` (`object.entity`) and `ValueMetaObject` (`object.value`). Delete `PojoMetaObject`, `MappedMetaObject`, `ProxyMetaObject`, `DataMetaObject`, `ManagedMetaObject`.
2. **Built-in representations = two**, baked into a shared base as one hybrid: reflection-on-a-bound-POJO, and map-backed (`ValueObject`). Chosen by the live object + whether a class is bound — **no attribute in the common case.**
3. **One extension seam:** an optional **Java-only** `@objectAdapter="<FQN>"` attribute naming a class that implements a tiny 3-method `ObjectAdapter` interface. The MetaObject instantiates it and delegates. **No registry, no ServiceLoader** — just instantiate-and-delegate. Keeps `entity`/`value` as the only subtypes.
4. **Proxy is demoted** out of core to a test/example `ProxyObjectAdapter` that demonstrates the `@objectAdapter` hook.
5. **Cross-language:** representation stays a Java-runtime concern. `@objectAdapter` is **not** in the conformance vocabulary; other ports ignore it. It is the narrow, FQN-based, never-required successor to the retired `@javaRuntime`.

## 3. Design

### 3.1 The two classes + shared hybrid base

`metadata` defines two concrete object subtypes sharing the common value-access logic (placed on an abstract base — either `MetaObject` itself or a small intermediate such as `AbstractObjectRepresentation`; the plan picks the cleanest seam that does not bloat `MetaObject`):

- **`EntityMetaObject`** → `object.entity` — semantic: persistent identity (has an `identity.primary`).
- **`ValueMetaObject`** → `object.value` — semantic: no identity (embedded / value object).

Both register via the existing `MetaDataTypeProvider` pattern, each `inheritsFrom(object, base)` so they inherit base's attr/child placement rules (verified in WA2 Task 3 that base-level placement is inherited).

The semantic difference drives codegen/persistence (identity, embedding), **not** runtime value access — both use the same hybrid (3.2). Keeping them as two thin classes (rather than one class + a flag) matches the registry's one-impl-class-per-subtype model and reads clearly.

### 3.2 Built-in representation: the hybrid (no attribute)

The shared base implements value access keyed on the **live object**, mirroring today's `DataMetaObject`:

- `getValue(field, obj)` / `setValue(field, obj, value)`: if `obj instanceof ValueObject` (or a plain `Map`) → map access; otherwise → reflection (getter/setter on a bound POJO).
- `newInstance()`: if a Java class is bound for this object's FQN (via the `@object` attribute or `ObjectClassRegistry`) → instantiate it reflectively; else → `new ValueObject(this)`. `ValueMetaObject` defaults to `ValueObject` regardless (a value object is map-backed by nature).

Properties:
- **Zero-config** for the two real cases (bound POJO; unbound/value → ValueObject).
- **Robust:** because dispatch is on the live object, a `ValueObject` is always read as a map even if a class name was present — this is the direct fix for the omdb `NoSuchMethodError`.
- `getDefaultObjectClass()` and `produces(obj)` equivalents are preserved on the new classes (ObjectManager relies on `newInstance`/`produces`).

### 3.3 The `@objectAdapter` hook

```java
package com.metaobjects.object;

/** Java-only extension seam for a custom object representation (e.g. a dynamic proxy).
 *  Selected per object node via the @objectAdapter attribute (an FQN). Not portable. */
public interface ObjectAdapter {
    Object newInstance(MetaObject mo);
    Object getValue(MetaObject mo, MetaField field, Object obj);
    void   setValue(MetaObject mo, MetaField field, Object obj, Object value);
}
```

- The Java-only attribute `@objectAdapter` (a `string` holding an FQN) is registered as an optional attribute on `object.base` (so both entity and value inherit it). It is **not** added to the cross-language conformance corpus.
- When present on a node, the MetaObject resolves the class via `Class.forName` (+ the loader's class loader), instantiates it once (no-arg ctor), caches it on the instance, and delegates `newInstance`/`getValue`/`setValue` to it. When absent → the built-in hybrid (3.2).
- Missing/invalid `@objectAdapter` class → a clear `MetaDataException` (this *is* an explicit user request, unlike the permissive `@object` fallback, so failing loud is correct).

### 3.4 Proxy as the reference extension example

`ProxyMetaObject` / `ProxyObject` leave core. The capability is rebuilt as a `ProxyObjectAdapter implements ObjectAdapter` living in **test/example** scope (e.g. under `metadata` test sources, package `com.metaobjects.test.proxy`). `newInstance` builds a `java.lang.reflect.Proxy` over the interface named by the node's `@object`; `getValue`/`setValue` route through the proxy's invocation handler.

The fruitbasket-proxy fixtures change from `object.proxy` to `object.entity` + `@objectAdapter="com.metaobjects.test.proxy.fruitbasket.ProxyObjectAdapter"` (keeping `@object=<interface FQN>`). `ProxyObjectTests` (which asserts `java.lang.reflect.Proxy.isProxyClass(...)`) stays green — living proof the hook works end to end.

### 3.5 Module placement

Consolidate the runtime representation into `metadata` (the durable core), which also serves the WA4 goal of shrinking module sprawl:

- **Move into `metadata`:** `ValueObject` (the map-backed runtime), `ObjectAdapter`, and the new `EntityMetaObject` / `ValueMetaObject`.
- **Preserve FQNs where possible** to minimize import/fixture churn — e.g. keep `ValueObject` at package `com.metaobjects.object.value` so existing `@object="com.metaobjects.object.value.ValueObject"` fixtures and `import` statements stay valid; only the owning jar changes.
- `DataObject` folds into `ValueObject` (or is dropped if unreferenced after the collapse).
- This eliminates the cross-module direction problem: the built-ins live entirely in upstream `metadata`; no downstream module is required for them.

### 3.6 Cross-language stance + ADR-0005 amendment

- The portable metamodel vocabulary remains **`object.entity` / `object.value`** only. No representation/adapter concept enters the shared spec or the conformance corpus.
- Other ports are data-oriented (the generated code *is* the representation); they need none of this and ignore `@objectAdapter` if present.
- ADR-0005 is amended: replace the "`@object` → registry → default picks a `Pojo`/`Proxy`/`Map` *class*" resolver with "two semantic classes carrying a built-in reflection/map hybrid, plus an optional Java-only `@objectAdapter` FQN hook." `@objectAdapter` is documented as the minimal successor to the retired `@javaRuntime`.

## 4. What changes

**Deleted:** `PojoMetaObject`, `MappedMetaObject`, `ProxyMetaObject` (metadata), `DataMetaObject`, `ValueMetaObject`-as-`object.value`-via-dynamic (dynamic), `ManagedMetaObject` (om), `ObjectRepresentationResolver` (the WA2 Task 1 class). Their `registerTypes`/constraint helpers go with them.

**Added:** `EntityMetaObject`, the new `ValueMetaObject`, `ObjectAdapter` (metadata); a test/example `ProxyObjectAdapter`.

**Moved into `metadata`:** `ValueObject` (FQN preserved), `ObjectAdapter`.

**Kept from the committed WA2 branch (Tasks 1–4b):** `object.entity`/`object.value` as registered subtypes; fixture migrations to `object.entity`; retirement of pojo/proxy/map subtype registration; test-assertion migrations to entity/value. Only the resolver and Task 2's representation-class wiring are replaced.

**Touched (call-site updates):** `om`/`omdb`/`dynamic` references to the deleted classes are re-pointed at `EntityMetaObject`/`ValueMetaObject` or the polymorphic `MetaObject` API; `ObjectManagerDB.createFromTemplate` and `ExpressionParser`'s `new PojoMetaObject(...)` updated.

## 5. Testing

- **Unit:** the hybrid base (reflection path on a bound POJO; map path on a `ValueObject`/`Map`; `newInstance` bound vs unbound); the `@objectAdapter` delegation (present → delegates; absent → hybrid; bad FQN → `MetaDataException`).
- **Representation conformance:** `EntityValueRepresentationTest` (from WA2) updated — entity bound→reflection-backed instance, unbound→ValueObject; value→ValueObject; canonical output is `object.entity`/`object.value`, never a representation name; never `javaRuntime`/`objectAdapter` leaking into the portable corpus.
- **Proxy example:** `ProxyObjectTests` green via the `ProxyObjectAdapter` hook.
- **omdb regression:** the 3 failing tests (`JsonbFieldDBTest.testValueObjectFallbackWhenNoBinding`, `testTypedJsonbRoundTrip`, `FruitDBTest.testBasket`) go green.
- **Full reactor green** (except the 2 known pre-existing CWD-dependent `CanonicalJsonParserTest` corpus NPEs) is the merge gate, followed by the standing review+simplify gate.

## 6. Out of scope / non-goals

- No change to the cross-language vocabulary, conformance corpus, or other ports.
- No general-purpose adapter registry / ServiceLoader discovery (explicitly rejected as YAGNI).
- No new representation beyond reflection + map built-in; proxy and anything exotic ride the `@objectAdapter` hook.
- WA3 (`source.*`/`origin.*`), WA4 (loader→metadata / collapse core), WA5 (conformance gate) remain separate work-areas; this redesign only *aligns with* WA4's consolidation direction (moving `ValueObject` into `metadata`).

## 7. Relationship to the WA2 work-area

This becomes the corrected WA2: the existing branch (`worktree-wa2-entity-value-representation`, Tasks 1–4b committed) is built upon — keep the valid migrations, delete `ObjectRepresentationResolver` and the resolver wiring, and implement §3. The WA2 implementation plan is rewritten to match this design. `main` is untouched throughout; integration is forward-merge only.
