# WA2 — Java Object Representation Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse Java's object-representation sprawl to two semantic MetaObject classes — `EntityMetaObject` + `ValueMetaObject` — backed by one built-in live-object reflection/map hybrid, with an optional Java-only `@objectAdapter` FQN hook for custom representations; proxy demoted to a reference example.

**Architecture:** A shared abstract base (`AbstractObjectRepresentation extends MetaObject`, in `metadata`) carries reflection value-access (lifted verbatim from `PojoMetaObject`) + a live-object hybrid (`DataObjectBase`/`Map` → map access, else reflection — lifted from `DataMetaObject`) + `@objectAdapter` delegation. `EntityMetaObject` (`object.entity`) and `ValueMetaObject` (`object.value`) differ only in their `newInstance`/default-class behaviour. The map runtime (`ValueObject` + bases) moves into `metadata` (FQNs preserved). The per-node `ObjectRepresentationResolver` and its parser wiring are deleted — the generic registry path constructs the two classes directly.

**Tech Stack:** Java 21, Maven, JUnit4. Modules: `metadata` (core), `dynamic`, `om`, `omdb`, `codegen-base`. Offline builds: `cd server/java && mvn -o ...`.

**Spec:** `docs/superpowers/specs/2026-05-23-java-object-representation-redesign-design.md`. **ADR:** [ADR-0005](../../spec/decisions/ADR-0005-object-representation-binding.md) (amended). This **supersedes** `2026-05-23-wa2-object-entity-value-representation.md` (the resolver plan).

**Branch:** `worktree-wa2-entity-value-representation` (Tasks 1–4b of the old plan are committed: `object.entity`/`object.value` registered, fixtures migrated to `object.entity`, pojo/proxy/map subtype registration retired, test assertions migrated). **Keep** those; this plan fixes forward. `main` is untouched; integrate by forward-merge only.

**Public-repo hygiene:** generic examples only (`myapp::commerce`, `Program`); `com.metaobjects.*` (project) and `com.metaobjects.test.proxy.*` (project test) are fine; never commit a developer home path.

**Known-green baseline:** the 2 pre-existing `CanonicalJsonParserTest` errors (`corpusSpotCheck_loaderBasicEmptyPackage`, `corpusSpotCheck_smokeEmptyMetadata` — `File.listFiles()` NPE, CWD-dependent) exist on `main`; they are NOT regressions. Every "reactor green" check below means "green except those 2."

---

## File Structure

**Created (in `metadata`):**
- `metadata/.../object/ObjectAdapter.java` — the 3-method extension interface.
- `metadata/.../object/AbstractObjectRepresentation.java` — shared base: reflection + hybrid + adapter delegation.
- `metadata/.../object/EntityMetaObject.java` — `object.entity`.
- `metadata/.../object/ValueMetaObject.java` — `object.value` (the NEW one; the dynamic one is deleted in Phase 2).

**Moved into `metadata` (FQNs preserved):**
- `com.metaobjects.object.value.ValueObject`, `ValueObjectBase`; `com.metaobjects.object.data.DataObjectBase`, `DataObject` — from `dynamic` → `metadata`.

**Deleted:** `PojoMetaObject`, `MappedMetaObject`, `ProxyMetaObject`, `ProxyObject`, `ProxyObjectHandler`, `ProxyAccessor` (metadata); `DataMetaObject`, dynamic `ValueMetaObject` (dynamic); `ManagedMetaObject` (om, pending Phase-2 investigation); `ObjectRepresentationResolver` (metadata).

**Created (test/example):** `metadata/src/test/.../test/proxy/fruitbasket/ProxyObjectAdapter.java`.

---

# PHASE 1 — Foundation (new model + fix the omdb bug)

End state: `EntityMetaObject`/`ValueMetaObject` are the registered impls for `object.entity`/`object.value`, backed by the hybrid; the resolver is gone; the 3 omdb tests pass. The old representation classes still EXIST (deleted in Phase 2) but no longer back entity/value.

## Task 1: Relocate the map runtime (`ValueObject` + bases) into `metadata`

**Files:**
- Move: `dynamic/src/main/java/com/metaobjects/object/data/DataObjectBase.java` → `metadata/src/main/java/com/metaobjects/object/data/DataObjectBase.java`
- Move: `dynamic/.../object/data/DataObject.java` → `metadata/.../object/data/DataObject.java`
- Move: `dynamic/.../object/value/ValueObjectBase.java` → `metadata/.../object/value/ValueObjectBase.java`
- Move: `dynamic/.../object/value/ValueObject.java` → `metadata/.../object/value/ValueObject.java`

- [ ] **Step 1: Confirm dependencies resolve in `metadata`.** These classes import `com.metaobjects.object.MetaObject`, `MetaObjectAware`, `com.metaobjects.field.MetaField`, `com.metaobjects.util.DataConverter`, `com.metaobjects.validator.Validatable`. Verify each already lives in `metadata`: `grep -rl "class DataConverter\|interface MetaObjectAware\|interface Validatable" server/java/metadata/src/main`. If any is in `dynamic`, add it to this move set (and re-grep its deps). Report the final move set.

- [ ] **Step 2: Move the files** with `git mv` (package paths are unchanged, so the `package` declarations and all `@object="com.metaobjects.object.value.ValueObject"` fixtures stay valid):
```bash
cd <repo-root>/.claude/worktrees/wa2-entity-value-representation
mkdir -p server/java/metadata/src/main/java/com/metaobjects/object/data server/java/metadata/src/main/java/com/metaobjects/object/value
git mv server/java/dynamic/src/main/java/com/metaobjects/object/data/DataObjectBase.java server/java/metadata/src/main/java/com/metaobjects/object/data/
git mv server/java/dynamic/src/main/java/com/metaobjects/object/data/DataObject.java server/java/metadata/src/main/java/com/metaobjects/object/data/
git mv server/java/dynamic/src/main/java/com/metaobjects/object/value/ValueObjectBase.java server/java/metadata/src/main/java/com/metaobjects/object/value/
git mv server/java/dynamic/src/main/java/com/metaobjects/object/value/ValueObject.java server/java/metadata/src/main/java/com/metaobjects/object/value/
```
(`DataObject`/`DataObjectBase` move too — `ValueObjectBase extends DataObjectBase`. `DataObject` itself may become unreferenced after Phase 2; leave it for now.)

- [ ] **Step 3: Compile `metadata` + dependents.** `cd server/java && mvn -o install -pl metadata,dynamic,om,omdb,codegen-base -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail`. Expected BUILD SUCCESS — `dynamic` consumers import these by FQN, now satisfied from the `metadata` jar. Fix any compile error (a class that should have moved with them, per Step 1).

- [ ] **Step 4: Commit.**
```bash
git add -A && git commit -m "$(cat <<'EOF'
refactor(metadata): relocate ValueObject/DataObject runtime into metadata (FQNs preserved)

Consolidates the map-backed object runtime into the durable core so the new
EntityMetaObject/ValueMetaObject hybrid can use it without a downstream dep.

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

## Task 2: The `ObjectAdapter` extension interface

**Files:**
- Create: `metadata/src/main/java/com/metaobjects/object/ObjectAdapter.java`
- Test: `metadata/src/test/java/com/metaobjects/object/ObjectAdapterContractTest.java`

- [ ] **Step 1: Write the failing test** (a trivial in-test adapter proves the contract shape compiles + is callable):
```java
package com.metaobjects.object;

import com.metaobjects.field.MetaField;
import org.junit.Test;
import static org.junit.Assert.*;

public class ObjectAdapterContractTest {
    static class StubAdapter implements ObjectAdapter {
        public Object newInstance(MetaObject mo) { return new java.util.HashMap<String,Object>(); }
        @SuppressWarnings("unchecked")
        public Object getValue(MetaObject mo, MetaField f, Object obj) { return ((java.util.Map<String,Object>)obj).get(f.getName()); }
        @SuppressWarnings("unchecked")
        public void setValue(MetaObject mo, MetaField f, Object obj, Object v) { ((java.util.Map<String,Object>)obj).put(f.getName(), v); }
    }
    @Test public void adapter_is_a_3_method_strategy() {
        ObjectAdapter a = new StubAdapter();
        Object o = a.newInstance(null);
        assertNotNull(o);
    }
}
```

- [ ] **Step 2: Run, verify it fails** (interface missing): `cd server/java && mvn -o -pl metadata test -Dtest=ObjectAdapterContractTest` → compile failure.

- [ ] **Step 3: Create the interface:**
```java
package com.metaobjects.object;

import com.metaobjects.field.MetaField;

/**
 * Java-only extension seam for a custom object representation (e.g. a dynamic proxy).
 * Selected per object node via the {@code @objectAdapter} attribute (a class FQN), which the
 * MetaObject instantiates (no-arg ctor) and delegates to. NOT portable; never in the conformance
 * corpus. The narrow successor to the retired {@code @javaRuntime}. See ADR-0005 (amendment).
 */
public interface ObjectAdapter {
    /** Create a new runtime instance for {@code mo}. */
    Object newInstance(MetaObject mo);
    /** Read field {@code f} from runtime object {@code obj}. */
    Object getValue(MetaObject mo, MetaField f, Object obj);
    /** Write {@code value} to field {@code f} on runtime object {@code obj}. */
    void setValue(MetaObject mo, MetaField f, Object obj, Object value);
}
```

- [ ] **Step 4: Run, verify pass.** `mvn -o -pl metadata test -Dtest=ObjectAdapterContractTest` → `Tests run: 1, Failures: 0`.

- [ ] **Step 5: Commit** (`feat(metadata): ObjectAdapter — Java-only representation extension seam [ADR-0005]`; trailer).

## Task 3: `AbstractObjectRepresentation` base (reflection + hybrid + adapter delegation)

**Files:**
- Create: `metadata/src/main/java/com/metaobjects/object/AbstractObjectRepresentation.java`
- (Reference, to lift code from: `metadata/.../object/pojo/PojoMetaObject.java`, `dynamic/.../object/data/DataMetaObject.java` — both still present in Phase 1.)

This base is assembled by **lifting existing, proven methods** (not rewriting them):

- [ ] **Step 1: Create the class skeleton** extending `MetaObject`, with the two protected ctors:
```java
package com.metaobjects.object;

import com.metaobjects.field.MetaField;
import com.metaobjects.object.data.DataObjectBase;
import com.metaobjects.object.value.ValueObject;
import com.metaobjects.util.DataConverter;
import java.lang.reflect.Method;

/**
 * Shared base for the two semantic object representations (EntityMetaObject / ValueMetaObject).
 * Value access dispatches on the LIVE object: a DataObjectBase (incl. ValueObject) is read/written
 * as a map; any other object goes through reflection (getters/setters). An optional @objectAdapter
 * (class FQN) overrides all access. See ADR-0005 (amendment).
 */
public abstract class AbstractObjectRepresentation extends MetaObject {

    /** Java-only attribute naming an ObjectAdapter implementation class (FQN). */
    public static final String ATTR_OBJECT_ADAPTER = "objectAdapter";
    private static final String CACHE_ADAPTER = "objectAdapterInstance";

    protected AbstractObjectRepresentation(String subType, String name) { super(subType, name); }
}
```

- [ ] **Step 2: Lift the reflection helpers from `PojoMetaObject`** into this base (verbatim — same method bodies): `getGetterName`, `findGetterName`, `retrieveGetterMethod`, `getSetterName`, `retrieveSetterMethod`, `setValueWithReflection(MetaField,Object,Object)`, `setValueWithReflection(MetaField,Object)`, the `uppercase(...)` helper, and the `CACHE_PARAM_GETTER_METHOD`/`CACHE_PARAM_SETTER_METHOD` constants. (Copy them from `PojoMetaObject.java` lines ~90–215 and the helper(s) they call.) These give the reflection path.

- [ ] **Step 3: Lift the hybrid + getter/setter detection from `DataMetaObject`**: `CACHE_PARAM_HAS_GETTER_METHOD`/`CACHE_PARAM_HAS_SETTER_METHOD`, `ignoreGetterFieldNames`, the `retrieveGetterMethod` override (skip ignored names), `hasGetterMethod`, `hasSetterMethod`. Then write the hybrid `getValue`/`setValue` that ALSO honour the adapter (adapter wins), else dispatch on the live object:
```java
@Override
public Object getValue(MetaField f, Object obj) {
    ObjectAdapter a = resolveAdapter();
    if (a != null) return a.getValue(this, f, obj);
    if (obj instanceof DataObjectBase) {
        return hasGetterMethod(f, obj.getClass())
            ? super_getValueReflection(f, obj)
            : ((DataObjectBase) obj)._getObjectAttribute(f.getName());
    }
    return super_getValueReflection(f, obj);   // plain POJO
}

@Override
public void setValue(MetaField f, Object obj, Object value) {
    ObjectAdapter a = resolveAdapter();
    if (a != null) { a.setValue(this, f, obj, value); return; }
    value = DataConverter.toType(f.getDataType(), value);
    if (obj instanceof DataObjectBase) {
        if (hasSetterMethod(f, obj.getClass())) super_setValueReflection(f, obj, value);
        else ((DataObjectBase) obj)._setObjectAttribute(f.getName(), value);
        return;
    }
    super_setValueReflection(f, obj, value);   // plain POJO
}
```
where `super_getValueReflection`/`super_setValueReflection` are the lifted `setValueWithReflection(...)` methods from Step 2 (rename references accordingly — keep one reflection getter and one reflection setter). (This merges `PojoMetaObject.getValue/setValue` and `DataMetaObject.getValue/setValue` into one robust hybrid.)

- [ ] **Step 4: Lift `getObjectClass()` + `produces(Object)`** from `DataMetaObject` (the version that falls back to `getDefaultObjectClass()`), and declare `protected abstract Class<?> getDefaultObjectClass();` (subclasses supply `ValueObject.class`). Lift `allowExtensions()`/`isStrict()` + `ATTR_ALLOWEXTENSIONS`/`ATTR_ISSTRICT` from `DataMetaObject` too (consumers rely on them).

- [ ] **Step 5: Add the adapter resolver:**
```java
/** Resolve (and cache) the @objectAdapter instance, or null when absent (→ built-in hybrid). */
protected ObjectAdapter resolveAdapter() {
    ObjectAdapter cached = (ObjectAdapter) getCacheValue(CACHE_ADAPTER);
    if (cached != null) return cached;
    if (!hasMetaAttr(ATTR_OBJECT_ADAPTER)) return null;
    String fqn = getMetaAttr(ATTR_OBJECT_ADAPTER).getValueAsString();
    if (fqn == null || fqn.isEmpty()) return null;
    try {
        Class<?> c = Class.forName(fqn, true, getClass().getClassLoader());
        ObjectAdapter a = (ObjectAdapter) c.getDeclaredConstructor().newInstance();
        setCacheValue(CACHE_ADAPTER, a);
        return a;
    } catch (Exception e) {
        throw new com.metaobjects.MetaDataException(
            "@objectAdapter class not usable: " + fqn + " (on " + getName() + ")", e);
    }
}
```
(Confirm the exact accessor for an attr's string value — `getMetaAttr(name).getValueAsString()` — against `MetaAttribute`; adjust if the method differs. `getCacheValue`/`setCacheValue`/`hasMetaAttr`/`getMetaAttr` are inherited from `MetaData`/`MetaObject`.)

- [ ] **Step 6: `newInstance()`** — keep it abstract here OR provide the bound-class-or-default behaviour and let subclasses override the default:
```java
@Override
public Object newInstance() {
    ObjectAdapter a = resolveAdapter();
    if (a != null) return a.newInstance(this);
    return super.newInstance();   // MetaObject.newInstance uses getObjectClass()/getDefaultObjectClass()
}
```
Confirm `MetaObject.newInstance()`'s current behaviour (it instantiates `getObjectClass()`); ensure that with our `getObjectClass()` falling back to `getDefaultObjectClass()` (= `ValueObject.class` for unbound), `newInstance()` yields a `ValueObject` when unbound and the bound class when bound. If `MetaObject.newInstance()` does not already do this, lift `PojoMetaObject`/`DataMetaObject`'s `newInstance` accordingly.

- [ ] **Step 7: Compile** `metadata`: `mvn -o -pl metadata install -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail`. Fix references. (No behavioural test yet — Task 6 exercises it via entity/value.)

- [ ] **Step 8: Commit** (`feat(metadata): AbstractObjectRepresentation — reflection/map hybrid + @objectAdapter delegation [ADR-0005]`; trailer).

## Task 4: `EntityMetaObject` + `ValueMetaObject`

**Files:**
- Create: `metadata/src/main/java/com/metaobjects/object/EntityMetaObject.java`
- Create: `metadata/src/main/java/com/metaobjects/object/ValueMetaObject.java`

- [ ] **Step 1: `EntityMetaObject`:**
```java
package com.metaobjects.object;

import com.metaobjects.object.value.ValueObject;

/** object.entity — a persistent record (identity). Reflection when a class is bound; ValueObject when not. */
@SuppressWarnings("serial")
public class EntityMetaObject extends AbstractObjectRepresentation {
    public EntityMetaObject(String name) { super(MetaObject.SUBTYPE_ENTITY, name); }
    protected EntityMetaObject(String subType, String name) { super(subType, name); }
    @Override protected Class<?> getDefaultObjectClass() { return ValueObject.class; }
}
```

- [ ] **Step 2: `ValueMetaObject`** (NEW; in `com.metaobjects.object`, distinct from the dynamic one deleted in Phase 2):
```java
package com.metaobjects.object;

import com.metaobjects.object.value.ValueObject;

/** object.value — a value object (no identity). Map-backed (ValueObject) by default. */
@SuppressWarnings("serial")
public class ValueMetaObject extends AbstractObjectRepresentation {
    public ValueMetaObject(String name) { super(MetaObject.SUBTYPE_VALUE, name); }
    protected ValueMetaObject(String subType, String name) { super(subType, name); }
    @Override protected Class<?> getDefaultObjectClass() { return ValueObject.class; }
}
```
(`MetaObject.SUBTYPE_ENTITY`/`SUBTYPE_VALUE` already exist from the prior WA2 commits.)

- [ ] **Step 3: Compile** `metadata`. Commit (`feat(metadata): EntityMetaObject + ValueMetaObject (semantic object subtypes) [ADR-0005]`; trailer).

## Task 5: Register entity/value to the new classes + the `@objectAdapter` attr; delete the resolver wiring

**Files:**
- Modify: `metadata/.../object/ObjectTypesMetaDataProvider.java`
- Modify: `metadata/.../object/MetaObject.java` (the `registerEntityValueTypes` added in WA2 + the `ATTR_OBJECT_ADAPTER` registration on base)
- Modify: `metadata/.../loader/parser/BaseMetaDataParser.java` + `metadata/.../loader/parser/json/CanonicalJsonParser.java` (remove the WA2 resolver wiring)
- Delete: `metadata/.../object/ObjectRepresentationResolver.java` + `ObjectRepresentationResolverTest.java`
- Modify: `metadata/.../registry/MetaDataRegistry.java` (remove the WA2 `createObjectInstance` helper if now unused)

- [ ] **Step 1: Point entity/value at the real classes.** In the WA2 `registerEntityValueTypes` (in `MetaObject.java`), change the impl class from `MappedMetaObject.class` to `EntityMetaObject.class` for `object.entity` and `ValueMetaObject.class` for `object.value` (each `inheritsFrom(TYPE_OBJECT, SUBTYPE_BASE)`). `EntityMetaObject(name)`/`ValueMetaObject(name)` are public, so the generic `MetaDataRegistry.createInstance` 1-arg ctor path now constructs them correctly with the right subType.

- [ ] **Step 2: Register `@objectAdapter` on `object.base`** so both inherit it — in `MetaObject.registerTypes`, add `def.optionalAttributeWithConstraints(AbstractObjectRepresentation.ATTR_OBJECT_ADAPTER).ofType(StringAttribute.SUBTYPE_STRING).asSingle();` (match the surrounding fluent style).

- [ ] **Step 3: Delete the resolver + its wiring.** Remove `ObjectRepresentationResolver.java` + its test. In `CanonicalJsonParser.processNode`, remove the `objectClassRef` read + the extra arg. In `BaseMetaDataParser`, remove the `objectClassRef` parameter from `createOrOverlayMetaData`/`createNewMetaData` and the entity/value special-case block that called the resolver + `createObjectInstance` (revert to the generic `getTypeRegistry().createInstance(typeName, subTypeName, fullname)` path). If `MetaDataRegistry.createObjectInstance` is now unreferenced, delete it.

- [ ] **Step 4: Compile + run the representation test.** `mvn -o -pl metadata install -DskipTests` then `mvn -o -pl metadata test -Dtest=EntityValueRepresentationTest 2>&1 | grep -E "Tests run|BUILD" | tail`. Update `EntityValueRepresentationTest` if it asserted resolver-specific backing (it should now assert: unbound entity/value → backing instance is `ValueObject` after `newInstance()`, or the MetaObject is `EntityMetaObject`/`ValueMetaObject`; subType still `entity`/`value`; canonical output `object.entity`/`object.value`, no representation leak). Make it green.

- [ ] **Step 5: Commit** (`feat(metadata): back object.entity/value with EntityMetaObject/ValueMetaObject; delete ObjectRepresentationResolver + parser wiring`; trailer).

## Task 6: Remove the `dynamic` object.value/object.data registration collision

**Files:**
- Modify: `dynamic/.../object/CoreObjectsMetaDataProvider.java`

- [ ] **Step 1:** In `CoreObjectsMetaDataProvider.registerTypes`, remove `ValueMetaObject.registerTypes(registry)` (the dynamic one) — `object.value` is now owned by `metadata`'s `ValueMetaObject`; leaving it causes the duplicate-registration collision. Also remove `DataMetaObject.registerTypes(registry)` IF `object.data` is no longer used by any fixture (`grep -rn 'object\.data' server/java --include=*.json --include=*.xml | grep -v target` — if empty, remove it; if non-empty, leave `object.data` registered for now and migrate those fixtures in Phase 2). Keep the `DataObjectExtensions`/`ValueObjectExtensions` attribute registrations (they target `object.base`).

- [ ] **Step 2: Compile** `dynamic` + dependents: `mvn -o install -pl metadata,dynamic,om,omdb -DskipTests 2>&1 | grep -E "BUILD|ERROR" | tail`. (The dynamic `ValueMetaObject`/`DataMetaObject` CLASSES still exist; only their registration is removed. They're deleted in Phase 2.)

- [ ] **Step 3: Commit** (`fix(dynamic): stop registering object.value/data (now owned by metadata EntityMetaObject/ValueMetaObject)`; trailer).

## Task 7: `@objectAdapter` delegation test (built-in vs hook)

**Files:**
- Test: `metadata/src/test/java/com/metaobjects/object/ObjectAdapterHookTest.java`
- Fixture: inline JSON in the test.

- [ ] **Step 1: Write the test.** Define a `public static` in-test `ObjectAdapter` (e.g. records calls to a list / returns a sentinel). Load an inline-JSON `object.entity` node carrying `"@objectAdapter": "<FQN of the in-test adapter>"`, call `getMetaObjectByName(...).newInstance()`/`getValue`/`setValue`, and assert the adapter was invoked (sentinel returned) — and that an `object.value` node WITHOUT the attr falls back to the built-in (`newInstance()` is a `ValueObject`). Also assert a bad FQN (`@objectAdapter="does.not.Exist"`) throws `MetaDataException` on first access. Use the loader idiom from `EntityValueRepresentationTest`.

- [ ] **Step 2: Run → it should PASS** (Task 3's `resolveAdapter` already implements this). If it fails, fix `resolveAdapter`/the delegation. `mvn -o -pl metadata test -Dtest=ObjectAdapterHookTest`.

- [ ] **Step 3: Commit** (`test(metadata): @objectAdapter hook — delegates when present, built-in hybrid when absent, throws on bad FQN`; trailer).

## Task 8: Fix the omdb regression + Phase-1 reactor green

**Files:**
- Modify (only if needed): omdb fixtures already use `object.value` + `@object="…ValueObject"`; they should now work unchanged (object.value → ValueMetaObject → ValueObject map access).

- [ ] **Step 1: Run the previously-failing omdb tests:** `cd server/java && mvn -o -pl omdb -am test -Dtest=JsonbFieldDBTest,FruitDBTest 2>&1 | grep -E "Tests run|BUILD|ERROR" | tail`. Expected: green. (The hybrid reads a live `ValueObject` via map access, so `testValueObjectFallbackWhenNoBinding`/`testTypedJsonbRoundTrip`/`testBasket` pass.) If a fixture still declares a non-entity/value object subtype (e.g. `object.data` for Fruit), migrate it to `object.entity` and re-run.

- [ ] **Step 2: Full reactor:** `cd server/java && mvn -o test 2>&1 | grep -E "Tests run: [0-9]+, Fail|ERROR\]|BUILD" | grep -vE "Time elapsed" | tail -40`. Expected green except the 2 known `CanonicalJsonParserTest` errors. Fix any fallout (most likely a test referencing the dynamic `ValueMetaObject` subtype directly, or an `object.data` fixture).

- [ ] **Step 3: Commit** (`fix(omdb): ValueObject map-access restored via EntityMetaObject/ValueMetaObject hybrid (closes the resolver regression)`; trailer). **Phase 1 complete — the bug is fixed and the new model is live.**

---

# PHASE 2 — Collapse the old representation classes

End state: `PojoMetaObject`, `MappedMetaObject`, `ProxyMetaObject`, `DataMetaObject`, dynamic `ValueMetaObject`, `ManagedMetaObject` deleted; all references re-pointed; only `object.entity`/`object.value` (+ any deliberate custom subtype) registered.

## Task 9: Re-point + delete the metadata representation classes (Pojo/Mapped/Proxy)

**Files:** ~25 metadata refs + 3 codegen-base + 2 dynamic + 2 om (from the reference census).

- [ ] **Step 1: Enumerate** every reference: `grep -rn "PojoMetaObject\|MappedMetaObject\|ProxyMetaObject" server/java --include=*.java | grep -v /target/`. Classify each: (a) `extends PojoMetaObject` → re-point to `extends AbstractObjectRepresentation` or `EntityMetaObject`; (b) `new PojoMetaObject("x")`/`MappedMetaObject.create(...)` → `new EntityMetaObject("x")` / `new ValueMetaObject("x")`; (c) `import`/type references → the polymorphic `MetaObject` API or the new classes; (d) `findType("object","pojo")`/`SUBTYPE_POJO` → already removed in WA2, but re-grep.

- [ ] **Step 2: Re-point** each site (smallest change that preserves behaviour; prefer the polymorphic `MetaObject` API where the concrete type isn't needed). `ExpressionParser` (`om`): `new PojoMetaObject("test")` → `new EntityMetaObject("test")`.

- [ ] **Step 3: Delete** `PojoMetaObject.java`, `MappedMetaObject.java`, `ProxyMetaObject.java` (+ their `*Builder` helpers if now unreferenced — grep first). `ProxyObject`/`ProxyObjectHandler`/`ProxyAccessor` move to Phase 3 (the proxy example), so leave them until then OR delete here and recreate in Phase 3 — choose based on what compiles; note the choice.

- [ ] **Step 4: Compile + test** the touched modules: `mvn -o install -pl metadata,dynamic,om,omdb,codegen-base -DskipTests` then `mvn -o test` (full). Fix fallout. Reactor green.

- [ ] **Step 5: Commit** (`refactor(java): delete Pojo/Mapped/Proxy MetaObject; re-point to EntityMetaObject/MetaObject API`; trailer).

## Task 10: Delete the dynamic `DataMetaObject` + `ValueMetaObject`

**Files:** `dynamic/.../object/data/DataMetaObject.java`, `dynamic/.../object/value/ValueMetaObject.java` + 5 dynamic refs.

- [ ] **Step 1:** `grep -rn "DataMetaObject\|object.value.ValueMetaObject\|object\.data\.\|\.data\.DataMetaObject" server/java --include=*.java | grep -v /target/`. Re-point references to `EntityMetaObject`/`ValueMetaObject` (metadata) or the `MetaObject` API. `ObjectManagerDB.createFromTemplate` (`omdb`, line ~1214 `ValueMetaObject.createFromTemplate`) → re-point to `metadata` `ValueMetaObject` (add an equivalent static `createFromTemplate` to the new `ValueMetaObject` if the call relies on it — lift it from the dynamic class; otherwise re-point to `new ValueMetaObject(...)`).

- [ ] **Step 2:** Delete both dynamic classes. Compile + full test. Fix fallout. Reactor green.

- [ ] **Step 3: Commit** (`refactor(dynamic): delete DataMetaObject + dynamic ValueMetaObject (superseded by metadata)`; trailer).

## Task 11: Resolve `ManagedMetaObject` (om interfaces)

**Files:** `om/.../object/managed/ManagedMetaObject.java` (+ `StateAwareMetaObject`, `ManagerAwareMetaObject`, and `ObjectManager` usage).

- [ ] **Step 1: Investigate.** `grep -rn "ManagedMetaObject\|StateAwareMetaObject\|ManagerAwareMetaObject\|instanceof StateAware\|instanceof ManagerAware" server/java --include=*.java | grep -v /target/`. Determine whether `ObjectManager` actually depends on a MetaObject implementing those interfaces at runtime (vs. them being vestigial). Report findings.

- [ ] **Step 2: Decide + apply** (decision criteria):
  - **If the interfaces are unused / vestigial:** delete `ManagedMetaObject` + the two interfaces; re-point any `new ManagedMetaObject(...)` to `EntityMetaObject`.
  - **If `ObjectManager` genuinely needs them:** keep a thin `ManagedMetaObject extends EntityMetaObject implements StateAwareMetaObject, ManagerAwareMetaObject` in `om`, registered as a deliberate **`om`-local** object subtype (this is the sanctioned "custom subtype via subclass" extension; it lives in `om`, not core). Do NOT collapse it into `metadata` (module direction forbids it).
  Whichever path: the core stays at two subtypes; any survivor is an explicit `om` extension.

- [ ] **Step 3:** Compile + full test. Reactor green. Commit (`refactor(om): <delete|retain-as-om-extension> ManagedMetaObject per interface usage`; trailer).

---

# PHASE 3 — Proxy as a reference `ObjectAdapter` example

End state: proxy is no longer core; `ProxyObjectTests` passes through the `@objectAdapter` hook, proving the seam.

## Task 12: `ProxyObjectAdapter` (test/example) + migrate the proxy fixtures

**Files:**
- Create: `metadata/src/test/java/com/metaobjects/test/proxy/fruitbasket/ProxyObjectAdapter.java`
- Modify: `metadata/src/test/resources/com/metaobjects/loader/simple/fruitbasket-proxy-metadata.json` (+ the `com/draagon/...` copy) — `object.entity` (already migrated from `object.proxy` in WA2 Task 4a) **+ add** `"@objectAdapter": "com.metaobjects.test.proxy.fruitbasket.ProxyObjectAdapter"` on each object that needs a proxy (keep `@object=<interface FQN>`).
- Modify: `ProxyObjectTests.java`, `GsonAdapterTest.java` if they referenced `ProxyMetaObject` directly.

- [ ] **Step 1: Implement `ProxyObjectAdapter implements ObjectAdapter`** by lifting the proxy logic from the (Phase-2-deleted) `ProxyMetaObject`/`ProxyObject`/`ProxyObjectHandler` (recover them from git history if deleted in Task 9): `newInstance(mo)` builds a `java.lang.reflect.Proxy` over the interface named by `mo`'s `@object`; `getValue`/`setValue` route through the proxy's `InvocationHandler` (the recovered `ProxyObjectHandler`). Place the handler/accessor in the same test package.

- [ ] **Step 2:** Add `@objectAdapter` to the proxy fixtures (Step's Files). Run `ProxyObjectTests` (asserts `java.lang.reflect.Proxy.isProxyClass(...)`): `mvn -o -pl metadata test -Dtest=ProxyObjectTests,GsonAdapterTest` → green via the hook.

- [ ] **Step 3:** Delete any remaining core proxy classes (`ProxyObject`/`ProxyObjectHandler`/`ProxyAccessor` in `metadata` main) if not already gone in Task 9 — they now live only in the test/example. Compile + full test.

- [ ] **Step 4: Commit** (`refactor(metadata): demote proxy to a ProxyObjectAdapter example proving the @objectAdapter hook`; trailer).

## Task 13: Final reactor + gate

- [ ] **Step 1:** `cd server/java && mvn -o test 2>&1 | grep -E "Tests run: [0-9]+, Fail|ERROR\]|BUILD" | grep -vE "Time elapsed" | tail -50`. Green except the 2 known `CanonicalJsonParserTest` errors. Also `mvn -o -pl metadata test -Dtest=CamelCaseSubtypeRoundTripTest,EntityValueRepresentationTest,ObjectAdapterHookTest` green.
- [ ] **Step 2:** Confirm canonical output never contains `object.pojo/map/proxy/data/managed`, `javaRuntime`, or `objectAdapter` for portable fixtures: `grep -rn "object\.pojo\|object\.map\|object\.proxy\|object\.data\|object\.managed" server/java --include=*.json --include=*.xml | grep -v /target/` → only intentional test/example fixtures (proxy example) may remain, and only as `object.entity` + `@objectAdapter`.
- [ ] **Step 3:** Ready for the review+simplify gate (run code-reviewer + code-simplifier on the whole WA2 diff before merging forward — the standing pre-merge gate).

---

## Self-Review

- **Spec coverage:** §3.1 two classes → T4; §3.2 hybrid → T3; §3.3 `@objectAdapter` → T2/T3/T5/T7; §3.4 proxy example → T12; §3.5 module placement (ValueObject→metadata) → T1; §3.6 ADR/cross-language → already committed (`e3e6c8d`) + no portable attr added (T5 registers `@objectAdapter` but it never enters conformance — verified T13.2); §4 deletions → T9/T10/T11; §5 testing → T6/T7/T8/T12/T13; §7 fix-forward on branch → preserved (no revert of WA2 migrations). All covered.
- **Placeholder scan:** novel code (ObjectAdapter, adapter delegation, resolveAdapter, EntityMetaObject/ValueMetaObject, registration) is shown complete; lifted methods are named with exact source locations (a verbatim move, not a placeholder); migration tasks carry exact grep/mvn commands + the reactor backstop + explicit decision criteria (T11). The two genuine investigate-decide points (T6 object.data fate, T11 ManagedMetaObject) state their decision rules.
- **Type consistency:** `AbstractObjectRepresentation.ATTR_OBJECT_ADAPTER` / `resolveAdapter()` / `getDefaultObjectClass()`; `ObjectAdapter.{newInstance,getValue,setValue}` used identically in T2/T3/T7/T12; `EntityMetaObject(String)` / `ValueMetaObject(String)` ctors match the registration in T5; `MetaObject.SUBTYPE_ENTITY/VALUE` reused from prior WA2 commits. Consistent.
- **Risk flags for the implementer:** (a) `MetaObject.newInstance()`'s exact current behaviour (T3 Step 6) — verify before relying on it; (b) `MetaAttribute` string accessor name (T3 Step 5); (c) which classes must move with `ValueObject` (T1 Step 1). Each has a verification step.
