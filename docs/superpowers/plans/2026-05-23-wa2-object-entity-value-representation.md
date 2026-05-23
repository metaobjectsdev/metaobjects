# WA2 — `object.entity`/`object.value` + binding-resolved representation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move Java objects to the cross-language standard: register `object.entity` + `object.value` (semantic subtypes), retire `object.pojo`/`proxy`/`map` **as subtypes**, and select the runtime representation (`PojoMetaObject`/`MappedMetaObject`/`ProxyMetaObject`) via a **resolver** (`@object` FQN → binding registry → default) at object-node creation — per **[ADR-0005](../../../spec/decisions/ADR-0005-object-representation-binding.md)**.

**Architecture:** The runtime is polymorphism-safe (no `instanceof PojoMetaObject`/casts anywhere — confirmed across `omdb`/`om`/`dynamic`/`core`/`metadata`); everything uses the abstract `MetaObject` API (`newInstance`/`getValue`/`setValue`/`getObjectClass`). So an `entity`/`value` node can be backed by any of the three existing representation classes. A new `ObjectRepresentationResolver` maps `(fqn, @object) → representation class` (concrete-class-bound → `PojoMetaObject`; interface-bound → `ProxyMetaObject`; unbound → `MappedMetaObject`); the loader instantiates that class with `subType` set to `entity`/`value`. The three representation classes keep their field-access behavior; they just stop self-registering as subtypes. `@javaRuntime` stays absent in Java.

**Tech Stack:** Java 21, Maven `metadata` module under `server/java/`; JUnit4; the Plan-2 binding registry (`ObjectClassRegistry`/`ObjectClassBindingProvider`); the parser (`BaseMetaDataParser`/`CanonicalJsonParser`) + `MetaDataRegistry`.

**Spec:** `docs/superpowers/specs/2026-05-23-java-standard-alignment-and-loader-consolidation-design.md` (WA2). Depends on WA1 (case-sensitive registry — merged). WA3 (source/origin) builds on this.

**Decisions of record (resolved in planning):** `object.base` = abstract template (not instantiated for user objects); `@object` = an **FQN only** (the pojo/proxy/map strategy is *derived* from the bound class, never a keyword); **unbound → Map-backed** (`MappedMetaObject`). No `@javaRuntime`. No backwards-compat alias for the old subtypes (project rule).

**Worktree:** this worktree (`wa2-entity-value-representation`, has WA1); integrate by merging forward (never rewrite main). All paths repo-relative.

---

## Task 1: `ObjectRepresentationResolver` (pure resolution logic)

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/object/ObjectRepresentationResolver.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/object/ObjectRepresentationResolverTest.java`

- [ ] **Step 1: Read the seams** — `metadata/.../registry/ObjectClassRegistry.java` (`resolve(fqn)` → `Class<?>` or null), `object/pojo/PojoMetaObject.java` + `mapped/MappedMetaObject.java` + `proxy/ProxyMetaObject.java` (confirm `SUBTYPE_*` constants + the `protected (String subType, String name)` ctors), and `object/MetaObject.java` `getObjectClass()` chain. Note the exact class names/packages for the imports below.

- [ ] **Step 2: Write the failing test**

```java
package com.metaobjects.object;

import com.metaobjects.object.pojo.PojoMetaObject;
import com.metaobjects.object.mapped.MappedMetaObject;
import com.metaobjects.object.proxy.ProxyMetaObject;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.Test;
import static org.junit.Assert.*;

public class ObjectRepresentationResolverTest {

    public static class ConcretePojo {}            // stand-in generated concrete class
    public interface SomeIface {}                  // stand-in interface

    private ObjectRepresentationResolver resolverWith(ObjectClassRegistry reg) {
        return new ObjectRepresentationResolver(reg, getClass().getClassLoader());
    }

    @Test public void unbound_defaults_to_mapped() {
        ObjectClassRegistry reg = new ObjectClassRegistry();   // empty
        Class<?> rep = resolverWith(reg).resolve("myapp::commerce::Program", null);
        assertEquals(MappedMetaObject.class, rep);
    }

    @Test public void concrete_class_in_registry_resolves_to_pojo() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("myapp::commerce::Program", ConcretePojo.class));
        assertEquals(PojoMetaObject.class, resolverWith(reg).resolve("myapp::commerce::Program", null));
    }

    @Test public void interface_in_registry_resolves_to_proxy() {
        ObjectClassRegistry reg = new ObjectClassRegistry();
        reg.register(() -> java.util.Map.of("myapp::commerce::Program", SomeIface.class));
        assertEquals(ProxyMetaObject.class, resolverWith(reg).resolve("myapp::commerce::Program", null));
    }

    @Test public void objectAttr_fqn_overrides_registry() {
        ObjectClassRegistry reg = new ObjectClassRegistry();   // empty registry
        // @object names a concrete class FQN -> Pojo, even though registry is empty
        Class<?> rep = resolverWith(reg).resolve("myapp::commerce::Program",
            ConcretePojo.class.getName());
        assertEquals(PojoMetaObject.class, rep);
    }

    @Test public void objectAttr_interface_fqn_resolves_to_proxy() {
        Class<?> rep = resolverWith(new ObjectClassRegistry()).resolve("x::Y", SomeIface.class.getName());
        assertEquals(ProxyMetaObject.class, rep);
    }
}
```

- [ ] **Step 3: Run, verify it fails** (`ObjectRepresentationResolver` missing)

Run: `cd server/java && mvn -o -pl metadata test -Dtest=ObjectRepresentationResolverTest`
Expected: compile failure.

- [ ] **Step 4: Implement the resolver**

```java
package com.metaobjects.object;

import com.metaobjects.object.pojo.PojoMetaObject;
import com.metaobjects.object.mapped.MappedMetaObject;
import com.metaobjects.object.proxy.ProxyMetaObject;
import com.metaobjects.registry.ObjectClassRegistry;

/**
 * Resolves the Java *representation* class (Pojo/Mapped/Proxy) for an object node, per ADR-0005:
 *   @object FQN (inline override) -> binding registry (FQN->class) -> default.
 * default: a bound concrete class -> reflection (PojoMetaObject); a bound interface -> proxy
 * (ProxyMetaObject); nothing bound -> Map-backed value-object (MappedMetaObject).
 * The chosen class is instantiated with subType = entity/value (semantic), never "pojo".
 */
public final class ObjectRepresentationResolver {

    private final ObjectClassRegistry registry;
    private final ClassLoader classLoader;

    public ObjectRepresentationResolver(ObjectClassRegistry registry, ClassLoader classLoader) {
        this.registry = registry;
        this.classLoader = classLoader;
    }

    /** @param fqn the object's canonical FQN ("pkg::Name"); @param objectAttr the @object attr value (FQN) or null. */
    public Class<? extends com.metaobjects.object.MetaObject> resolve(String fqn, String objectAttr) {
        Class<?> bound = resolveBoundClass(fqn, objectAttr);
        if (bound == null) return MappedMetaObject.class;          // unbound -> Map-backed
        return bound.isInterface() ? ProxyMetaObject.class         // interface -> proxy
                                   : PojoMetaObject.class;         // concrete -> reflection
    }

    private Class<?> resolveBoundClass(String fqn, String objectAttr) {
        if (objectAttr != null && !objectAttr.isEmpty()) {         // inline @object FQN wins
            try { return Class.forName(objectAttr, false, classLoader); }
            catch (ClassNotFoundException e) {
                throw new IllegalStateException("@object class not found: " + objectAttr + " (for " + fqn + ")", e);
            }
        }
        return registry == null ? null : registry.resolve(fqn);    // binding registry, or null
    }
}
```

- [ ] **Step 5: Run, verify pass**

Run: `cd server/java && mvn -o -pl metadata test -Dtest=ObjectRepresentationResolverTest`
Expected: `Tests run: 5, Failures: 0, Errors: 0`.

- [ ] **Step 6: Commit** (`feat(metadata): ObjectRepresentationResolver — @object/registry/default -> Pojo/Proxy/Mapped (ADR-0005)`; append `Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>`).

---

## Task 2: Register `object.entity`/`object.value`; instantiate via the resolver

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/object/ObjectTypesMetaDataProvider.java`
- Modify: `server/java/metadata/src/main/java/com/metaobjects/object/MetaObject.java` (add `SUBTYPE_ENTITY`/`SUBTYPE_VALUE` constants + entity/value registration)
- Modify: the object-instantiation seam (the parser path that creates an object node — see Step 1) + likely a small `MetaDataRegistry` helper.
- Test: `server/java/metadata/src/test/java/com/metaobjects/object/EntityValueRepresentationTest.java`
- Fixture: `server/java/metadata/src/test/resources/meta.entityvalue.json`

- [ ] **Step 1: Read the instantiation seam**

Read `BaseMetaDataParser.createOrOverlayMetaData(...)` (it has the JSON `body` → can read the `@object` attr) and `createNewMetaData(...)` (it calls `getTypeRegistry().createInstance(typeName, subTypeName, fullname)`), and `MetaDataRegistry.createInstance` (lines ~234-274). Decide the cleanest injection point where BOTH (a) the object's FQN/name + the raw `@object` value are available AND (b) the node is instantiated. The recommended approach: for `typeName == MetaObject.TYPE_OBJECT` and `subType ∈ {entity, value}`, resolve the representation class via `ObjectRepresentationResolver`, then construct it with the **protected `(String subType, String name)` ctor** (present on Pojo/Mapped/Proxy) so the node's `subType` is `entity`/`value`. Add a `MetaDataRegistry.createObjectInstance(Class<? extends MetaObject> repClass, String subType, String name)` (reflective `(subType,name)` ctor) if a clean construction path doesn't already exist. **Confirm where `@object` is readable at create time** (the `body` JsonObject in `createOrOverlayMetaData`); thread it to the resolver.

- [ ] **Step 2: Write the failing test + fixture**

Fixture `meta.entityvalue.json` (an unbound entity + an unbound value + an entity with an `@object` FQN):

```json
{ "metadata.root": {
    "package": "myapp::commerce",
    "children": [
      { "object.entity": { "name": "Program", "children": [ { "field.long": { "name": "id" } } ] } },
      { "object.value": { "name": "Money", "children": [ { "field.long": { "name": "cents" } } ] } }
    ]
}}
```

`EntityValueRepresentationTest.java` (extends `SharedRegistryTestBase`):
```
// 1. Load meta.entityvalue.json.
// 2. Program (object.entity, unbound) loads; getSubType()=="entity"; the backing instance is a
//    MappedMetaObject (unbound default); canonical-serialize the root and assert it contains
//    "object.entity" (NOT "object.pojo"/"object.map").
// 3. Money (object.value, unbound): getSubType()=="value"; backing instance MappedMetaObject;
//    serialization contains "object.value".
// 4. Bind Program's FQN to a concrete test class via an ObjectClassBindingProvider (register it
//    before loading, as ObjectClassRegistryTest/BindingResolutionTest do), reload, and assert
//    Program's backing instance is now a PojoMetaObject (concrete -> reflection) while getSubType()
//    is still "entity".
```
Write the full test against the harness; the assertions (subType == entity/value; backing class = Mapped unbound / Pojo bound; canonical output `object.entity`/`object.value`) are the contract. (Determining the backing class: `loader.getMetaObjectByName(...).getClass()`.)

- [ ] **Step 3: Run, verify it fails** (`object.entity`/`value` unregistered → load error).

Run: `cd server/java && mvn -o -pl metadata test -Dtest=EntityValueRepresentationTest`

- [ ] **Step 4: Register entity/value + wire the resolver**

In `MetaObject.java`: add `public static final String SUBTYPE_ENTITY = "entity";` + `SUBTYPE_VALUE = "value";`. Register `object.entity` + `object.value` (each `inheritsFrom(TYPE_OBJECT, SUBTYPE_BASE)`, with the same attr/child rules the base object allows). Keep `object.base` registered (abstract template).

In `ObjectTypesMetaDataProvider.registerTypes`: register entity + value; **remove** the `PojoMetaObject.registerTypes`/`ProxyMetaObject.registerTypes`/`MappedMetaObject.registerTypes` subtype registrations (those classes no longer self-register as subtypes — they become representation impls only). (Keep `MetaObject.registerTypes` for base.)

Wire the resolver into the instantiation seam (Step 1): when creating an `object.entity`/`object.value` node, construct the resolver-chosen representation class with `subType` = the parsed subtype. Use the loader's `ObjectClassRegistry` (`ObjectClassRegistry.global()` or the loader's instance) + the loader's class loader. Read `@object` from the node body and pass it to the resolver.

- [ ] **Step 5: Run, verify pass** (entity/value load; backing class Mapped/Pojo per binding; canonical output `object.entity`/`object.value`).

Run: `cd server/java && mvn -o -pl metadata test -Dtest=EntityValueRepresentationTest`

- [ ] **Step 6: Commit** (`feat(metadata): register object.entity/value; resolver-driven representation (retire pojo/proxy/map subtypes) [ADR-0005]`; trailer).

---

## Task 3: Re-key the registration sites off pojo/proxy/map

The subtype change orphans registrations + lookups keyed on `object.pojo`/`proxy`/`map`. Re-point them to `base`/`entity`/`value`.

**Files (from the WA2 research — confirm each by grep):**
- `server/java/metadata/src/main/java/com/metaobjects/database/CoreDBMetaDataProvider.java` — the `findType(TYPE_OBJECT, PojoMetaObject.SUBTYPE_POJO).optionalAttribute(DB_TABLE, ...)` block. **Coordinate with WA3:** WA3 removes `@dbTable`/`@dbView` object attrs entirely. For WA2, move any *non-db* object-level attrs that were on the pojo subtype to `MetaObject.SUBTYPE_BASE` (so entity/value inherit them); leave the `@dbTable` removal to WA3 (or remove the pojo-keyed `@dbTable` line now since the pojo subtype is gone, and WA3 finishes removing the base-keyed one).
- `core/src/main/java/com/metaobjects/io/xml/XMLMetaDataWriter.java` + `io/object/xml/XMLObjectWriter.java` — `registry.findType("object","pojo")`. (NB: WA4 drops legacy XML; for WA2, re-point these to `object.base` or `entity` so they compile, OR if WA4 lands first they're gone. Re-point minimally.)
- `dynamic/src/main/java/com/metaobjects/object/CoreObjectsMetaDataProvider.java` — `findType("object","pojo")`.
- `codegen-base/.../MetaDataFileJsonSchemaGenerator.java` — `findType("object","pojo")`.

- [ ] **Step 1:** `grep -rn '"object", *"pojo"\|"object","proxy"\|"object","map"\|SUBTYPE_POJO\|object\.pojo' server/java --include=*.java | grep -v test` to enumerate every production site. For each, re-point the `findType`/registration to `MetaObject.SUBTYPE_BASE` (if it's a base-applicable attr/extension) or `SUBTYPE_ENTITY`/`SUBTYPE_VALUE` as appropriate. Show the diff per file.
- [ ] **Step 2:** Compile metadata + each touched module: `cd server/java && mvn -o install -pl core,metadata,om,omdb,dynamic,codegen-base -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail`. Fix any remaining reference.
- [ ] **Step 3: Commit** (`refactor(java): re-key object-type registrations/lookups off pojo/proxy/map -> base/entity/value`; trailer).

---

## Task 4: Migrate fixtures + test assertions to entity/value

- [ ] **Step 1:** Enumerate: `grep -rln 'object\.pojo\|object\.map\|object\.proxy\|"pojo"\|"map"\|"proxy"' server/java --include=*.json; grep -rln 'object","pojo\|getSubType().*pojo\|isRegistered("object", *"pojo"\|"object", *"map"' server/java --include=*.java | grep test`. From the WA2 research the known set: ~6 fixtures (`codegen-base/.../schema-validation/*.json` + `metadata/.../test-interface-metadata.json`) + assertions in `AllMetaDataTypesRegistrationTest`, `MetaRelationshipIntegrationTest`, `UnifiedRegistrySchemaIntegrationTest`, `CanonicalJsonParserTest`.
- [ ] **Step 2:** In each FIXTURE, change `object.pojo`/`object.map` → `object.entity` (or `object.value` for value-semantics fixtures; default to `entity` for plain records). In each TEST, change the expected subtype/lookup from `pojo`/`map` → `entity`/`value` (matching the fixture). Re-author, don't add aliases.
- [ ] **Step 3:** Run the affected test classes; confirm green: `cd server/java && mvn -o -pl metadata,codegen-base -am test 2>&1 | grep -E "Tests run: [0-9]+, Fail|BUILD" | grep -vE "Time elapsed" | tail`. (The 2 known `CanonicalJsonParserTest` CWD-path errors remain; any NEW failure is a missed migration — fix it.)
- [ ] **Step 4: Commit** (`test(java): migrate fixtures + assertions object.pojo/map -> object.entity/value`; trailer).

---

## Task 5: `@javaRuntime` guard

- [ ] **Step 1:** Confirm Java defines/reads no `javaRuntime`: `grep -rn "javaRuntime\|JAVA_RUNTIME" server/java` → expect empty. If anything appears (e.g. introduced accidentally), remove it.
- [ ] **Step 2:** (Optional, cheap) add an assertion to `EntityValueRepresentationTest` that the canonical serialization of an object node does NOT contain `"javaRuntime"`. Commit only if added.

---

## Task 6: Reactor green + audit

- [ ] **Step 1:** `cd server/java && mvn -o install -pl core,metadata,om,omdb -DskipTests >/dev/null 2>&1` then test metadata, omdb, core, dynamic, codegen-base, maven-plugin (filtered): each `mvn -o -pl <m> test 2>&1 | grep -E "Tests run:|BUILD" | tail -2`. Expected: all green except the 2 known pre-existing `CanonicalJsonParserTest` errors. Fix any new failure (a missed pojo/map reference, or a representation-resolution edge case).
- [ ] **Step 2:** Sanity: load a previously-`object.pojo` fixture now as `object.entity` and confirm OMDB `newInstance()` still works for a bound entity (the polymorphism-safe runtime should be unaffected; if `JsonbFieldDBTest`/`FruitDBTest` use object subtypes, confirm they pass).
- [ ] **Step 3: Final commit (if loose ends) + ready for the review+simplify gate.**

---

## Self-Review

- **Spec/ADR-0005 coverage:** entity/value registered (T2); representation resolver `@object`→registry→default with concrete→Pojo/interface→Proxy/unbound→Mapped (T1) wired at instantiation with `subType=entity/value` (T2); pojo/proxy/map retired as subtypes, classes kept as impls (T2); registration sites + fixtures + assertions migrated (T3/T4); `@javaRuntime` confirmed absent (T5). ✓
- **Resolved sub-questions honored:** `object.base` abstract; `@object`=FQN only; unbound→Map. ✓
- **Polymorphism-safety leveraged:** no `instanceof`/cast anywhere, so backing-class choice is free (research-confirmed); canonical output is `object.entity`/`value` because the node's `subType` is set so even though the backing class is Pojo/Mapped/Proxy. ✓
- **Placeholder scan:** T1 resolver is full code + unit tests; T2's instantiation seam is a "read createOrOverlayMetaData/createNewMetaData/createInstance, wire the resolver where body(@object)+instantiation meet" instruction + a behavioral-contract load test (the precise parser line is the one genuine integration seam, flagged for the implementer, per the accepted convention); T3/T4 are concrete grep-enumerate-then-repoint with exact commands. ✓
- **Type consistency:** `ObjectRepresentationResolver.resolve(fqn, objectAttr)`; `MetaObject.SUBTYPE_ENTITY`/`SUBTYPE_VALUE`; the protected `(subType,name)` ctors on Pojo/Mapped/Proxy; `MetaDataRegistry.createObjectInstance(...)` (if added). ✓
- **WA3 coordination:** the `@dbTable`/`@dbView` object-attr removal is WA3; WA2 only re-keys/removes the *pojo-subtype* registration of it. Noted in T3. ✓
- **Hygiene:** repo-relative paths; generic `myapp::commerce` examples; no home paths/private names. ✓
