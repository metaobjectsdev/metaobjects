# Java Flavored Object + Extractor Codegen — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Java codegen of objects with sub-objects (single + arrays) in two selectable flavors — `pojoAware` (POJO `extends PojoObject`) and `valueObject` (perf-tuned cached-holder accessors over the extensible `ValueObject` base) — plus a dedicated generated `<Name>Extractor` that wraps the Phase-B runtime recover, all via direct code emission on the **reused** legacy framework, and downstream-extensible.

**Architecture:** Reuse the byte-identical legacy direct object-codegen framework already in this repo (`codegen-base/.../generator/direct/object/` `BaseObjectCodeGenerator`/`BaseObjectCodeWriter` + `javacode/JavaCodeGenerator`/`JavaCodeWriter`). Add concrete-class **writer subclasses** of `JavaCodeWriter` (one per flavor) that emit bodies + the `extends <base>` clause + a `MetaObject` ctor (and, for `valueObject`, cached per-field value-holder accessors), selected by a `flavor` generator-config option; a runtime `PojoObject` base; a `ValueObjectBase` cached-holder primitive; a self-registering `ObjectClassBindingProvider` emitted per flavored class; and a separate `Extractor` generator. Direct emission — no templates. **Java only.**

**Tech Stack:** Java / Maven. Spec: `docs/superpowers/specs/2026-05-31-java-flavored-object-codegen-design.md`. Builds on Phase A (runtime object model) + Phase B (`MetaObjectRecover` in `om`). Reference: the legacy `metaobjects-core`/`-dynamic` (study read-only; never name them or their paths in committed content — say "the legacy reference").

---

## Worktree & reuse discipline

Existing `worktree-java-flavored-object-codegen`. `$WT` = `<repo-root>/.claude/worktrees/java-flavored-object-codegen` (executor substitutes the real path). Absolute paths only; subagents never `git checkout` SHAs; confirm branch before commit. `mvn -pl <module> install -DskipTests` a changed JVM module before testing dependents. Single branch, single final merge.

**Reuse rule (hard):** the legacy framework files in `codegen-base/.../direct/object/` are reused AS-IS — `BaseObjectCodeGenerator` (255L), `BaseObjectCodeWriter` (355L), `JavaCodeGenerator` (74L), `JavaCodeWriter` (202L). Extend via their hooks. If any is changed/bypassed, the task MUST state what + why (deviation accounting). Default = reuse.

## Framework hooks to extend (study first)

`BaseObjectCodeWriter`: `type` field (default `"interface"`, set via `forType("class")`); `objectReferenceMap: Map<MetaField,MetaObject>` (nested object refs, already resolved in `initVariables`); abstract hooks `getLanguageType(MetaField)`, `getGetterMethodName`/`getSetterMethodName`/`getParameterName`, `getClassName(MetaObject)`, `writeGetter(getterName,typeName,field)`, `writeSetter(setterName,paramName,typeName,field)`, `writeObjectHeader(docs,pkg,name,imports,fullSuperName)`, `writeObjectFooter`, `writeComment`, `writeNewLine`, `getLanguagePackage`, `getLanguageNameAttribute`; orchestration `writeObject(mo)` → `initVariables` + `writeObjectHeader` + `writeObjectMethods` + `writeObjectFooter`. `JavaCodeWriter` implements these to emit an **interface** (`public Type getX();`). `BaseObjectCodeGenerator`: `getSupportedTypes`/`getDefaultType`/`createWriter(loader,md,pw,context)`/`getFileExtension`/`getLanguageName`/`convertToLanguageNaming`; `GenerationContext` carries config. Phase A: `MetaObjectAware`, `ValueObject`/`ValueObjectBase` (+ `AttributeEntry`), `ObjectClassRegistry`/`ObjectClassBindingProvider`, `MetaObject.newInstance`, `MetaField.setObject`/reflective setter path, `MetaDataUtil.getObjectRef`. Phase B: `com.metaobjects.object.recover.MetaObjectRecover.recover(MetaObject,String[,Format[,RecoverOptions]])` (in `om`).

---

## Task 1: `PojoObject` runtime base (port legacy + fix the bug)

**Files:**
- Create: `server/java/metadata/src/main/java/com/metaobjects/object/pojo/PojoObject.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/object/pojo/PojoObjectTest.java`

- [ ] **Step 1: Write the failing test** (`PojoObjectTest`, JUnit 4):
```java
public class PojoObjectTest {
    static class Sample extends PojoObject { Sample(MetaObject mo){ super(mo); } }
    @Test public void carriesAndResetsBackRef() {
        MetaObject mo = ValueMetaObject.create("acme::Foo"); // or build a minimal MetaObject
        Sample s = new Sample(mo);
        assertSame(mo, s.getMetaData());
        MetaObject mo2 = ValueMetaObject.create("acme::Bar");
        s.setMetaData(mo2);
        assertSame("setMetaData must actually update the back-ref (legacy self-assign bug)", mo2, s.getMetaData());
    }
}
```
(Adjust `ValueMetaObject.create(...)` to this repo's actual MetaObject construction — check `ValueMetaObject`/a test helper.)

- [ ] **Step 2: Run → FAIL** (`PojoObject` doesn't exist). `cd $WT/server/java && mvn -q -pl metadata test -Dtest=PojoObjectTest -DfailIfNoTests=false`.

- [ ] **Step 3: Implement** `PojoObject` (port the legacy, **fix** the `setMetaData` self-assignment + drop `final` so it can be set):
```java
package com.metaobjects.object.pojo;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
/** Base for code-generated POJOs that carry their MetaObject (MetaObjectAware). */
public abstract class PojoObject implements MetaObjectAware {
    private MetaObject metaObject;
    protected PojoObject(MetaObject mo) { this.metaObject = mo; }
    @Override public MetaObject getMetaData() { return metaObject; }
    @Override public void setMetaData(MetaObject metaObject) { this.metaObject = metaObject; } // legacy bug fixed
}
```
(If this repo's `MetaObjectAware`/`MetaDataAware` has different method names, match them. Implement `Validatable` ONLY if that interface exists here.)

- [ ] **Step 4: Run → PASS.** Plus `mvn -q -pl metadata test -DfailIfNoTests=false` (no regression).
- [ ] **Step 5: Commit** (`feat(metadata): PojoObject MetaObjectAware base for codegen (legacy port + setMetaData bugfix)`).

---

## Task 2: `ValueObjectBase` cached per-field value-holder primitive

**Files:**
- Modify: `server/java/metadata/src/main/java/com/metaobjects/object/value/ValueObjectBase.java`
- Test: `server/java/metadata/src/test/java/com/metaobjects/object/value/ValueObjectHolderTest.java`

The `valueObject` flavor's generated accessors must cache a per-field holder and read/write via it directly (no keyed lookup per call). **Study the legacy reference** `ManagedObject`/`DataObjectBase` (a `Map<String, Value>` with a `Value` holder exposing `getValue()`/`setValue()`) and this repo's `ValueObjectBase.AttributeEntry`. Add a stable per-field holder primitive.

- [ ] **Step 1: Read** the legacy `DataObjectBase`/`ManagedObject` `Value`-holder pattern + this repo's `ValueObjectBase` (`AttributeEntry`, the backing map). Determine whether `AttributeEntry` is stable (a single object per field whose `getValue`/`setValue` hit a cached cell) or re-looks-up by name each call. **Report the finding** (this is the deviation-accounting input).

- [ ] **Step 2: Write the failing test** asserting a cached holder is stable + direct:
```java
public class ValueObjectHolderTest {
    @Test public void holderIsStableAndDirect() {
        ValueObject vo = new ValueObject(/* a MetaObject with field "x" */);
        var h1 = vo.valueHolder("x");
        var h2 = vo.valueHolder("x");
        assertSame("same holder instance per field (cacheable)", h1, h2);
        h1.setValue("hello");
        assertEquals("hello", vo.get("x"));      // holder write visible via the map
        vo.set("x", "world");
        assertEquals("world", h1.getValue());     // map write visible via the holder
    }
}
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement** a `public ValueHolder valueHolder(String name)` (and a `ValueHolder` type with `getValue()`/`setValue(Object)`) on `ValueObjectBase`, backed so the holder reads/writes the field's cell directly and is **cached/stable per field name** (memoize in a `Map<String,ValueHolder>`). Mirror the legacy `Value`/`AttributeEntry` semantics; reuse `AttributeEntry` if it already provides a stable cell (then `valueHolder` just memoizes it). **Deviation note:** if `AttributeEntry` re-looks-up, document that you added the cached-holder primitive because the naive entry isn't perf-suitable for generated accessors.
- [ ] **Step 5: Run → PASS** + `mvn -q -pl metadata test -DfailIfNoTests=false` + `mvn -q -pl om test -DfailIfNoTests=false` (heaviest VO user — no regression).
- [ ] **Step 6: Commit** (`feat(metadata): ValueObjectBase cached per-field value-holder (perf primitive for valueObject codegen)`).

---

## Task 3: `pojoAware` flavor writer + generator + flavor config (extend the framework)

**Files:**
- Create: `server/java/codegen-base/src/main/java/com/metaobjects/generator/direct/object/javacode/PojoAwareCodeWriter.java`
- Create: `server/java/codegen-base/src/main/java/com/metaobjects/generator/direct/object/javacode/JavaObjectCodeGenerator.java` (flavor-selecting generator) — OR extend `JavaCodeGenerator`; pick per the existing generator's shape and report.
- Test: `server/java/codegen-base/src/test/java/com/metaobjects/generator/direct/object/JavaPojoAwareCompileRunTest.java`

`PojoAwareCodeWriter extends JavaCodeWriter` — reuse naming/type hooks (`getLanguageType`, `getGetterMethodName`, etc.); override only what's needed to emit a **concrete class**: `forType("class")`; `writeObjectHeader(...)` emits `public class <Name> extends com.metaobjects.object.pojo.PojoObject {`; add `protected void writeFields(MetaObject)`, `protected void writeConstructor(MetaObject)` (`public <Name>(MetaObject mo){ super(mo); }`), and override `writeGetter`/`writeSetter` to emit **bodies** (`return this.<field>;` / `this.<field> = <param>;`). Nested fields: `getLanguageType` for a `field.object` returns the nested class type (`<Sub>` or `java.util.List<<Sub>>`) using `objectReferenceMap` + `getClassName`; the generator emits the nested class recursively (dedupe per run). All emission steps `protected` + overridable (downstream extensibility). The flavor is a `GenerationContext`/generator-arg option `flavor=pojoAware`.

- [ ] **Step 1: Write the failing compile-run test** — generate a `pojoAware` class for a payload with scalars + a nested object + an array-of-objects, compile in-memory (javac, mirror `codegen-spring`'s `GeneratedNestedRecoverCompileRunTest` harness), and assert: the class `extends PojoObject`; `new <Name>(mo)` then `getMetaData()==mo`; setters/getters round-trip a value; the nested field's getter type is the nested class, the array field's is `List<Sub>`; nested + sub classes generated.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `PojoAwareCodeWriter` + the flavor-selecting generator (its `createWriter` returns `PojoAwareCodeWriter` when `flavor=pojoAware`). Reuse `JavaCodeWriter`'s hooks; override the emission seams listed above as `protected`.
- [ ] **Step 4: Run → PASS** + `mvn -q -pl codegen-base test -DfailIfNoTests=false` (no regression; the legacy `JavaCodeWriter` interface tests stay green).
- [ ] **Step 5: Commit** (`feat(codegen-base): pojoAware flavor writer + flavor-selecting generator (extends legacy framework)`).

---

## Task 4: `valueObject` flavor writer (perf-tuned cached-holder accessors)

**Files:**
- Create: `server/java/codegen-base/src/main/java/com/metaobjects/generator/direct/object/javacode/ValueObjectCodeWriter.java`
- Test: `server/java/codegen-base/src/test/java/com/metaobjects/generator/direct/object/JavaValueObjectCompileRunTest.java`

`ValueObjectCodeWriter extends JavaCodeWriter` — `forType("class")`; header emits `public class <Name> extends com.metaobjects.object.value.ValueObject {`; ctor `public <Name>(MetaObject mo){ super(mo); }`; for each field emit a **cached holder field** (`private final ValueHolder _<field> = valueHolder("<field>");`, populated lazily/in-ctor per Task 2's primitive) and `writeGetter`/`writeSetter` bodies that use it directly: `return (<Type>) _<field>.getValue();` / `_<field>.setValue(<param>);` — **not** `get("<field>")`/`set(...)` per call. Nested types as in Task 3. All seams `protected`+overridable. Flavor option `flavor=valueObject`.

- [ ] **Step 1: Write the failing compile-run test** — generate a `valueObject` class for a payload with scalars + nested + array-of-objects, compile (javac), and assert: extends `ValueObject`; `getMetaData()==mo`; the generated accessor uses a cached holder (assert by behavior: set via setter → visible via `vo.get(name)` AND the holder is fetched once — e.g. the generated source contains `valueHolder("<field>")` exactly once per field and getter/setter reference the cached field, not `get("...")`); extensibility: an undeclared key set via `vo.set("extra", v)` round-trips (map base intact); nested/array typed accessors present.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** `ValueObjectCodeWriter` using the Task 2 `valueHolder` primitive. Override only the emission seams; reuse `JavaCodeWriter` naming/type hooks.
- [ ] **Step 4: Run → PASS** + `mvn -q -pl codegen-base test -DfailIfNoTests=false`.
- [ ] **Step 5: Commit** (`feat(codegen-base): valueObject flavor writer with cached-holder accessors (perf-tuned)`).

---

## Task 5: Self-registering `ObjectClassBindingProvider` emission

**Files:**
- Modify: the flavor generator(s) to also emit a per-run `ObjectClassBindingProvider` (FQN→generated class) + the `META-INF/services` registration.
- Test: `server/java/codegen-base/src/test/java/com/metaobjects/generator/direct/object/GeneratedBindingProviderTest.java`

- [ ] **Step 1: Write the failing test** — generate a flavored class + its provider, compile, register the provider in a fresh `ObjectClassRegistry`, and assert `MetaObject.newInstance()` for that FQN yields the generated flavored class (not a bare `ValueObject`).
- [ ] **Step 2-4:** implement the provider emission (one `ObjectClassBindingProvider` impl whose `bindings()` maps each generated FQN→class, + the ServiceLoader `META-INF/services/...ObjectClassBindingProvider` line), run → green.
- [ ] **Step 5: Commit** (`feat(codegen-base): emit self-registering ObjectClassBindingProvider for flavored classes`).

---

## Task 6: Dedicated `<Name>Extractor` generator (wraps Phase B runtime recover)

**Files:**
- Create: `server/java/codegen-base/.../direct/object/javacode/ExtractorCodeGenerator.java` (+ writer if needed)
- Test: `server/java/codegen-base/src/test/java/com/metaobjects/generator/direct/object/GeneratedExtractorCompileRunTest.java`

Emit `public final class <Name>Extractor { public static <Type> extract(MetaDataLoader loader, String text){ MetaObject mo = loader.getMetaObjectByName("<fqn>"); return (<Type>) com.metaobjects.object.recover.MetaObjectRecover.recover(mo, text).orThrow(); } public static com.metaobjects.render.recover.RecoveryResult<<Type>> recover(MetaDataLoader loader, String text){ ... } }` — references `MetaObjectRecover` by FQN string (codegen-base needs no `om` compile dep; the test needs `om`). `extract` returns the typed flavored object (cast works because Task-5 registration makes `newInstance` yield it); `recover` returns the never-throws result. Emission steps `protected`+overridable (e.g. `protected void writeExtractMethod(...)`).

- [ ] **Step 1: Write the failing compile-run test** — generate a flavored class (pojoAware) + its provider + its `<Name>Extractor` for a payload with a nested object + array-of-objects; compile (with `om` on the test classpath); register the provider; invoke `<Name>Extractor.extract(loader, dirtyJsonOrXml)`; assert the returned typed object has the nested object + array-of-objects **populated (not null)** + the `MetaObject` back-ref; `recover(...)` returns a result whose report has no lost-required for clean input. (Repeat the assertion for the `valueObject` flavor too.)
- [ ] **Step 2-4:** implement the `Extractor` generator, run → green (both flavors).
- [ ] **Step 5: Commit** (`feat(codegen-base): generated <Name>Extractor wrapping runtime recover (closes flavored extraction)`).

---

## Task 7: Downstream extensibility / customization proof

**Files:**
- Test: `server/java/codegen-base/src/test/java/com/metaobjects/generator/direct/object/DownstreamCustomizationTest.java`

- [ ] **Step 1: Write the test** that a downstream consumer can subclass + customize: extend `PojoAwareCodeWriter` overriding a `protected` seam (e.g. `getGetterMethodName` to prefix `fetch`, or `writeConstructor` to add a no-arg ctor, or `getClassName` to add a suffix), wire it via an overridden `createWriter` in a `JavaObjectCodeGenerator` subclass, generate, compile, and assert the customization took effect (e.g. the generated class has `fetchX()` / the custom suffix / the extra ctor). Proves the seams are `protected`/overridable and `createWriter` is the extension point.
- [ ] **Step 2: Run → PASS.** If a needed seam is `private`/`final`, widen it to `protected` (a deliberate, documented extensibility change to the NEW writers — not the reused legacy files) and note it.
- [ ] **Step 3: Commit** (`test(codegen-base): downstream subclass/override customization proof for flavored writers`).

---

## Task 8: Close-out

- [ ] **Step 1: Final whole-branch review.** Dispatch a reviewer over `git diff <MB>..HEAD` (`MB=$(git merge-base origin/main HEAD)`): confirm the legacy framework files are byte-UNCHANGED (reuse-as-is) — `git diff` must show ZERO changes to `BaseObjectCodeGenerator`/`BaseObjectCodeWriter`/`JavaCodeGenerator`/`JavaCodeWriter`; the new writers extend via hooks; `PojoObject` bugfix correct; `ValueObjectBase` holder primitive sound + no `om` regression; both flavors + provider + Extractor compile-run green; emission seams `protected`/overridable (Task 7); the deviation list (ValueObjectBase holder; any `protected`-widening) is documented; hygiene (no legacy-project names/paths in committed content). Fix findings.
- [ ] **Step 2: Docs** — a short KNOWN_GAPS/README in `codegen-base/.../direct/object/` documenting the two flavors, the `flavor` config option, the extension seams, and the **deviation list** (what isn't reused as-is + why). Roadmap entry. 
- [ ] **Step 3: Memory** (controller).
- [ ] **Step 4: Merge** forward onto the current `origin/main` tip (FF-push pattern). Java only — no other-port changes. Remove the worktree (or keep if the user wants follow-on). Surface nothing for publish (this is library-internal codegen).

---

## Notes for the executor

- **Reuse the legacy framework as-is** — `git diff` on the 4 framework files must be empty at merge. Extend via subclasses + hooks. Any deviation (the `ValueObjectBase` holder primitive; `protected`-widening on NEW writers) is documented in the deviation list. If you feel you must change a legacy framework file, STOP and report why.
- **Direct code emission only** — no Mustache/templates. The writers append source (the established pattern).
- **valueObject is perf-tuned** — cached per-field holder, direct get/set; NOT per-call keyed lookup. Assert the generated source binds the holder once per field.
- **Downstream-extensible** — new emission steps `protected`+overridable; `createWriter` is the writer factory seam; `flavor` is a settable option. Task 7 proves it.
- **Compile-and-run is the gold-standard gate** — every flavor/Extractor task generates → javac → instantiate/extract → assert (nested + arrays populate, back-ref set).
- **Java only.** No TS/Python/C#/Kotlin. The `recover→extract` rename + Publish stay queued.
- Absolute worktree paths; `mvn install` changed modules before dependents; no `git checkout` of SHAs; confirm branch before commit; reference projects stay generic in committed content.
