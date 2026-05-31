# Cross-Port Runtime Object Model (Phase A) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring Java's runtime object model — a `MetaObject` factory that instantiates a map-backed `ValueObject` (default) or a registered code-generated type, an instance→`MetaObject` back-reference, a self-registering FQN→constructor binding registry, and field get/set by name — to TS / Python / C# (Kotlin reuses the JVM model), reflection-free per ADR-0001, pinned by a shared conformance corpus.

**Architecture:** The conformance corpus is the executable contract: a shared metadata fixture + a precise per-scenario behavioral spec; each port implements an idiomatic object model and a runner that executes the scenarios and asserts identical outcomes. Java is the reference (its model already exists). The map-backed `ValueObject` is the universal default (no native-class resolution → AOT-safe); generated types register `FQN → constructor` at load (no reflection). Consumers (Phase B recover, serializers) call `newInstance` + field get/set and are oblivious to whether the backing object is a ValueObject or a generated type.

**Tech Stack:** Java/Maven (reference), Kotlin/JUnit (reuses JVM), TS/Bun, Python/pytest+uv, C#/.NET xUnit. Spec: `docs/superpowers/specs/2026-05-30-cross-port-runtime-object-model-design.md`. **Generalized `@default` + metadata-driven recover are Phase B — NOT in this plan.**

---

## Worktree

Existing worktree, branch `worktree-recover-codegen-nested`. `$WT` = `<repo-root>/.claude/worktrees/recover-codegen-nested` (the executor substitutes the real absolute path, provided at dispatch). **All commands use absolute worktree paths** — a bare `cd server/...` hits a different checkout. Subagents must NOT `git checkout` SHAs (detaches worktree HEAD); inspect with `git show`/`git diff`; confirm `git rev-parse --abbrev-ref HEAD` is `worktree-recover-codegen-nested` before committing. Single branch, single final merge.

---

## Java reference (study before porting)

The semantics every port matches (read these):
- `server/java/metadata/src/main/java/com/metaobjects/object/MetaObjectAware.java` — `getMetaData()`/`setMetaData(MetaObject)` instance back-ref.
- `.../object/value/ValueObject.java` + `ValueObjectBase.java` — map-backed, holds MetaObject, MetaObjectAware.
- `.../object/AbstractObjectRepresentation.java` — `getObjectClass()` = `@object` attr → `ObjectClassRegistry.resolve(name)` → `getDefaultObjectClass()` (ValueObject for `object.value`); `MetaObject.newInstance()` instantiates + `attachMetaObject` (sets back-ref).
- `.../registry/ObjectClassRegistry.java` + `ObjectClassBindingProvider.java` — FQN→Class via ServiceLoader providers (`@FunctionalInterface bindings(): Map<String,Class<?>>`); `resolve(fqn)` → class or null.
- `.../field/MetaField.java` — `setObject/getObject/setString/setInt/setLong/setDouble/setBoolean`, `getDataType()` (`DataTypes.OBJECT`/`OBJECT_ARRAY`/scalars).

---

## Task 1: Shared conformance corpus + ADR

**Files:**
- Create: `fixtures/object-model-conformance/meta.json`
- Create: `fixtures/object-model-conformance/README.md`
- Create: `spec/decisions/ADR-0017-cross-port-runtime-object-model.md` *(use the next free ADR number if 0017 is taken — check `ls spec/decisions/`)*

- [ ] **Step 1: Write the shared metadata fixture** — `fixtures/object-model-conformance/meta.json`:

```json
{ "metadata.root": {
    "package": "com::example::om",
    "children": [
      { "object.value": { "name": "Address", "children": [
        { "field.string": { "name": "street" } },
        { "field.string": { "name": "city" } }
      ]}},
      { "object.value": { "name": "Tag", "children": [
        { "field.string": { "name": "label" } }
      ]}},
      { "object.value": { "name": "Person", "children": [
        { "field.string": { "name": "name" } },
        { "field.int":    { "name": "age" } },
        { "field.object": { "name": "home", "@objectRef": "com::example::om::Address" } },
        { "field.object": { "name": "tags", "@isArray": true, "@objectRef": "com::example::om::Tag" } }
      ]}}
    ]
}}
```

- [ ] **Step 2: Write the scenario contract** — `fixtures/object-model-conformance/README.md`. This is the behavioral spec each port's runner executes against the fixture (object graphs, not byte-identity):

```markdown
# object-model-conformance

Shared metadata (`meta.json`) + the scenarios every port's runtime object model must satisfy.
Each port loads `meta.json` and runs these against its MetaObject/MetaField/ValueObject/registry
+ newInstance factory. Assertions are behavioral (type-kind, back-ref identity, field values,
list contents, overflow), not byte-identity.

Resolve the corpus dir the same way the port's existing conformance runners resolve sibling
corpora (repo-root walk).

## Scenarios (Person = object.value with name:string, age:int, home:Address, tags:Tag[])

1. **instantiate-value** — newInstance(Person) returns the port's map-backed ValueObject (the
   unbound default for object.value); the instance's MetaObject back-reference is the Person MetaObject.
2. **scalar-round-trip** — set name="Ada", age=36; get name == "Ada", age == 36 (int).
3. **nested-object** — newInstance(Address), set street="1 Main", city="Anytown"; set as Person.home;
   get Person.home → an Address-backed object with street/city as set; its back-reference is the
   Address MetaObject.
4. **array-of-objects** — build [Tag(label="a"), Tag(label="b")]; set Person.tags; get Person.tags →
   ordered list of 2; labels "a","b"; each element's back-reference is the Tag MetaObject.
5. **overflow** — on a ValueObject Person, set key "nickname" (not a declared field); get "nickname"
   round-trips ("metadata/instance may hold more than the declared field set").
6. **bound-type** — register a port-local test type (an "aware" POJO with name/age/home/tags) for FQN
   "com::example::om::Person" in the ObjectClassRegistry; newInstance(Person) returns THAT type (not a
   ValueObject); its back-reference is set; scalar/nested/array get/set behave identically to a ValueObject.
   Use a fresh/scoped registry so this does not leak into other scenarios.
7. **no-binding-fallback** — with nothing registered for Address, newInstance(Address) returns a ValueObject.
```

- [ ] **Step 3: Write the ADR** — `spec/decisions/ADR-0017-cross-port-runtime-object-model.md` (Nygard format): context (Java has a runtime object model; other ports don't; ADR-0001/AOT forbids runtime reflection); decision (cross-port object model = map-backed ValueObject default + instance back-ref + self-registering FQN→ctor `ObjectClassRegistry` + `newInstance` factory + field get/set SPI; typed binding via generated self-registration, never `Class.forName`/`Type.GetType`/`importlib`; codegen'd-or-not transparent to consumers); consequences (consistent runtime metadata manipulation across ports; recover/serializers build on it; ValueObject path is reflection-free/AOT-safe); references (ADR-0001; MyBatis `ObjectWrapper`; Avro `GenericRecord`/`SpecificRecord`).

- [ ] **Step 4: Commit**

```bash
cd $WT && git add fixtures/object-model-conformance spec/decisions/ADR-0017-cross-port-runtime-object-model.md
git commit -m "test(object-model-conformance): shared corpus + ADR-0017 (cross-port runtime object model)"
```

---

## Task 2: Java reference conformance runner (validates the corpus against the existing model)

**Files:**
- Create: `server/java/metadata/src/test/java/com/metaobjects/object/ObjectModelConformanceTest.java`
- Create: a tiny test POJO for scenario 6, e.g. nested in the test or `.../object/PersonPojoFixture.java` (implements `MetaObjectAware`, fields name/age/home/tags with get/set).

Java already has the full model, so this task is: write the runner that executes the 7 scenarios using the existing API, proving the corpus is satisfiable by the reference. It becomes the semantic reference the other ports mirror.

- [ ] **Step 1: Write the runner** (JUnit 4, matching sibling tests). Load `meta.json` via the loader (resolve the corpus dir as the metadata-conformance test does). Then:
  - **instantiate-value**: `MetaObject person = loader.getMetaObjectByName("com::example::om::Person"); Object p = person.newInstance(); assertTrue(p instanceof ValueObject); assertSame(person, ((MetaObjectAware)p).getMetaData());`
  - **scalar**: `person.getMetaField("name").setString(p,"Ada"); person.getMetaField("age").setInt(p,36); assertEquals("Ada", person.getMetaField("name").getString(p)); assertEquals(36, (int) person.getMetaField("age").getInt(p));`
  - **nested**: resolve Address MetaObject (`MetaDataUtil.getObjectRef(person.getMetaField("home"))`), newInstance, set street/city, `person.getMetaField("home").setObject(p, addr); Object got = person.getMetaField("home").getObject(p);` assert street/city + back-ref Address.
  - **array**: build `List.of(tag1, tag2)` (each a Tag newInstance with label), `person.getMetaField("tags").setObjectArray(p, list)` (or setObject with a List), get back, assert size 2 + labels + each back-ref Tag.
  - **overflow**: `((ValueObject)p).put("nickname","Ace"); assertEquals("Ace", ((ValueObject)p).get("nickname"));`
  - **bound-type**: register a provider mapping the Person FQN → `PersonPojoFixture.class` in a fresh `ObjectClassRegistry` (or via a test provider), newInstance, assert `instanceof PersonPojoFixture`, back-ref set, scalar/nested/array IO identical. (Use a fresh registry/loader so it doesn't leak.)
  - **no-binding-fallback**: Address has no binding → `loader.getMetaObjectByName("...Address").newInstance() instanceof ValueObject`.

- [ ] **Step 2: Run** — `cd $WT/server/java && mvn -q -pl metadata test -Dtest=ObjectModelConformanceTest -DfailIfNoTests=false` → all scenarios green. If a scenario can't be satisfied by the existing API, that's a **reconciliation gap** — fix it minimally in the model (e.g., expose a missing accessor) and note it; do NOT weaken the corpus.

- [ ] **Step 3: Spec + quality review; commit.**

```bash
cd $WT && git add server/java/metadata/src/test/java/com/metaobjects/object/ObjectModelConformanceTest.java server/java/metadata/src/test/java/com/metaobjects/object/PersonPojoFixture.java
git commit -m "test(object-model-conformance): Java reference runner (7/7) + reconciliation"
```

---

## Task 3: Kotlin runner (over the JVM model)

**Files:**
- Create: a Kotlin runner in a module that depends on `metadata` (e.g. `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/ObjectModelConformanceTest.kt`, or `metadata-ktx` test if it carries the corpus more naturally — pick the module that already depends on `metadata` and runs conformance).

- [ ] **Step 1: Confirm the module has `metadata` on its test classpath** (codegen-kotlin does); resolve the corpus as `KotlinAbstractConformanceTest` resolves `codegen-conformance`. Write a kotlin.test runner that executes the same 7 scenarios via the Java classes (`MetaObject.newInstance()`, `MetaField.setObject`, etc.), with a Kotlin test POJO for scenario 6.
- [ ] **Step 2: Run** — `cd $WT/server/java && mvn -q -pl codegen-kotlin test -Dtest=ObjectModelConformanceTest -DfailIfNoTests=false` (install `metadata` to .m2 first if needed: `mvn -q -pl metadata install -DskipTests`). 7/7 green (proves the corpus runs in the Kotlin module via the inherited JVM model).
- [ ] **Step 3: Review; commit.**

---

## Task 4: TypeScript object model + runner

**Files:**
- Create: `server/typescript/packages/metadata/src/core/object/value-object.ts` — `ValueObject` over `Record<string, unknown>`, holds its `MetaObject`, implements the aware contract.
- Create: `server/typescript/packages/metadata/src/core/object/meta-object-aware.ts` — the back-ref contract (interface + a symbol/`getMetaData`/`setMetaData`), or fold into an existing module.
- Create: `server/typescript/packages/metadata/src/core/object/object-class-registry.ts` — `ObjectClassRegistry` (FQN→constructor), `register(fqn, ctor)` / `resolve(fqn)`; self-registration entry point for generated modules. **Distinct from the metadata `TypeRegistry`.**
- Modify: `server/typescript/packages/metadata/src/core/object/meta-object.ts` — add `newInstance()` (resolve via `ObjectClassRegistry` → bound ctor, else `ValueObject`; set back-ref) + `getMetaField(name)`/field access if not present; an `object.value` default-object-kind = ValueObject.
- Modify: `server/typescript/packages/metadata/src/core/field/meta-field.ts` — `getValue(obj, name?)`/`setValue(obj, name, value)` by name dispatching ValueObject(map)/typed; nested via `objectRef`.
- Create: `server/typescript/packages/metadata/test/object-model-conformance.test.ts` — the runner (7 scenarios + a test typed class for scenario 6).

The TS model is **idiomatic** (no port-of-Java-byte-for-byte); the corpus is the gate. Study the Java reference for semantics. Field access: a `ValueObject` is a map (set/get by key); a typed object is set/get by property; nested OBJECT recurses via `getObjectRef`; OBJECT_ARRAY is an array. No `reflect-metadata`.

- [ ] **Step 1: Read** the Java reference files + the existing TS `meta-object.ts`/`meta-field.ts` to match accessor names + `DataType` handling.
- [ ] **Step 2: Implement** `ValueObject`, the aware contract, `ObjectClassRegistry`, `MetaObject.newInstance()` + field access, the `object.value`→ValueObject default.
- [ ] **Step 3: Write the runner** executing the 7 scenarios; scenario 6 registers a small TS test class (`class PersonObj { meta?: MetaObject; name?; age?; home?; tags?; }` implementing the aware contract) in the registry and asserts `newInstance` returns it.
- [ ] **Step 4: Run** — `cd $WT/server/typescript/packages/metadata && bun test test/object-model-conformance.test.ts` → 7/7. Typecheck: `cd $WT/server/typescript && bun run --filter '@metaobjectsdev/metadata' typecheck` → 0.
- [ ] **Step 5: Review; commit.**

```bash
cd $WT && git add server/typescript/packages/metadata/src/core/object server/typescript/packages/metadata/src/core/field/meta-field.ts server/typescript/packages/metadata/test/object-model-conformance.test.ts
git commit -m "feat(metadata-ts): runtime object model (ValueObject + aware + ObjectClassRegistry + newInstance); object-model-conformance 7/7"
```

---

## Task 5: Python object model + runner

**Files:**
- Create: `server/python/src/metaobjects/meta/core/object/value_object.py` — `ValueObject` over `dict`, holds its `MetaObject`, aware.
- Create: `server/python/src/metaobjects/meta/core/object/object_class_registry.py` — `ObjectClassRegistry` (FQN→constructor); `register`/`resolve`; self-registration. Distinct from the metadata `TypeRegistry`.
- Modify: `server/python/src/metaobjects/meta/core/object/meta_object.py` — `new_instance()` (registry→bound ctor else ValueObject; set back-ref) + field access; `object.value`→ValueObject default. The aware contract = a `Protocol` (`get_meta_data`/`set_meta_data`) or a `_meta` attribute convention.
- Modify: `server/python/src/metaobjects/meta/core/field/meta_field.py` — `get_value(obj, name)`/`set_value(obj, name, value)` dispatching dict/typed; nested via objectRef.
- Create: `server/python/tests/conformance/test_object_model_conformance.py` — runner (7 scenarios; scenario 6 uses a small `@dataclass`-style test class with the aware protocol).

- [ ] **Step 1: Read** the Java reference + existing Python `meta_object.py`/`meta_field.py`.
- [ ] **Step 2: Implement** ValueObject (dict-backed), the aware protocol, ObjectClassRegistry, `new_instance` + field access, `object.value`→ValueObject. Python may use native `setattr`/`getattr` for the typed lane (no AOT constraint), but the **default is the dict-backed ValueObject**.
- [ ] **Step 3: Write the runner** (7 scenarios).
- [ ] **Step 4: Run** — `cd $WT/server/python && uv run pytest tests/conformance/test_object_model_conformance.py -q` → 7/7. `uv run ruff check <new files>`; `uv run mypy` (no new errors).
- [ ] **Step 5: Review; commit.**

```bash
cd $WT && git add server/python/src/metaobjects/meta/core/object/value_object.py server/python/src/metaobjects/meta/core/object/object_class_registry.py server/python/src/metaobjects/meta/core/object/meta_object.py server/python/src/metaobjects/meta/core/field/meta_field.py server/python/tests/conformance/test_object_model_conformance.py
git commit -m "feat(metadata-py): runtime object model (ValueObject + aware + ObjectClassRegistry + new_instance); object-model-conformance 7/7"
```

---

## Task 6: C# object model + runner

**Files:**
- Create: `server/csharp/MetaObjects/Meta/ValueObject.cs` — over `Dictionary<string, object?>`, holds its `MetaObject`, implements `IMetaObjectAware`.
- Create: `server/csharp/MetaObjects/Meta/IMetaObjectAware.cs` — `MetaObject? GetMetaData()` / `SetMetaData(MetaObject)`.
- Create: `server/csharp/MetaObjects/Meta/ObjectClassRegistry.cs` — FQN→`Func<MetaObject,object>` (or `Type` + activator-free ctor delegate); `Register`/`Resolve`; self-registration via a generated module initializer. **AOT-safe: no `Type.GetType`/reflection — generated code registers a constructor delegate.** Distinct from `TypeRegistry`.
- Modify: `server/csharp/MetaObjects/Meta/MetaObject.cs` — `NewInstance()` (registry→bound ctor delegate, else `ValueObject`; set back-ref) + field access helpers; `object.value`→ValueObject default.
- Modify: `server/csharp/MetaObjects/Meta/MetaField.cs` — `GetValue(obj, name)`/`SetValue(obj, name, value)` dispatching ValueObject(dict)/typed; nested via objectRef.
- Create: `server/csharp/MetaObjects.Tests/ObjectModelConformanceTests.cs` — runner (7 scenarios; scenario 6 registers a test class via a constructor delegate, NOT reflection).

- [ ] **Step 1: Read** the Java reference + existing C# `MetaObject.cs`/`MetaField.cs`.
- [ ] **Step 2: Implement** ValueObject, `IMetaObjectAware`, `ObjectClassRegistry` (constructor-delegate based — **no runtime reflection / `Activator.CreateInstance(Type.GetType(...))`**, keep AOT-safe + `TreatWarningsAsErrors`/nullable clean), `NewInstance` + field access, `object.value`→ValueObject.
- [ ] **Step 3: Write the runner** (7 scenarios); scenario 6 registers `(mo) => new PersonObj(mo)` for the Person FQN and asserts `NewInstance` returns a `PersonObj`.
- [ ] **Step 4: Run** — `cd $WT && dotnet test server/csharp/MetaObjects.Tests --filter "FullyQualifiedName~ObjectModelConformance"` → 7/7, 0 warnings.
- [ ] **Step 5: Review; commit.**

```bash
cd $WT && git add server/csharp/MetaObjects/Meta server/csharp/MetaObjects.Tests/ObjectModelConformanceTests.cs
git commit -m "feat(metadata-cs): runtime object model (ValueObject + IMetaObjectAware + ObjectClassRegistry + NewInstance); object-model-conformance 7/7"
```

---

## Task 7: Close-out

**Files:**
- Modify: `spec/roadmap.md`; memory (controller); finalize the ADR if its number changed.

- [ ] **Step 1: Final whole-branch review** over `git diff <merge-base>..HEAD` (`MB=$(git merge-base origin/main HEAD)`): all 4 native ports + Kotlin pass `object-model-conformance` 7/7; ValueObject default is reflection-free in every port; the C# registry uses constructor delegates (no `Type.GetType`); no consumer/recover/Phase-B code touched; the Java reconciliation (if any) is minimal; hygiene clean. Fix findings.
- [ ] **Step 2: Roadmap** — add a "runtime object model" entry under shipped cross-port features + an `object-model-conformance` line under the corpora list; note Phase B (recover) builds on it.
- [ ] **Step 3: Commit roadmap.**
- [ ] **Step 4: Merge** — verify green, then merge forward onto the current `origin/main` tip via the FF-push pattern (merge `origin/main` into the branch → `git push origin HEAD:main`), then remove the worktree **only if Phase B will not continue on it** — otherwise keep the worktree for Phase B. Forward-only; never rebase/reset/force `main`.
- [ ] **Step 5: Memory (controller)** — record the cross-port runtime object model shipped + that Phase B (recover + generalized `@default`) is next on the same foundation.

---

## Notes for the executor

- **The corpus is the contract.** A scenario that can't pass is a model bug to fix in that port — never weaken the corpus. Behavioral assertions (type-kind, back-ref identity, values, list contents, overflow), not byte-identity.
- **ValueObject is the default everywhere and resolves no native class** (reflection-free, AOT-safe). The typed lane registers a constructor (delegate/ctor/class) at load — never `Class.forName`/`Type.GetType`/`importlib`/`reflect-metadata`.
- **Codegen'd-or-not invariant**: scenario 6 (bound type) + scenario 7 (fallback) prove a generated type and a ValueObject are interchangeable to consumers. This must hold in every port.
- **Idiomatic per port** — match each port's existing `MetaObject`/`MetaField` conventions; do not transliterate Java line-for-line. The Java runner is the *semantic* reference.
- **Absolute worktree paths; no `git checkout` of SHAs in subagents; confirm branch before commit.**
- **Out of scope:** generalized `@default`, the Java default-value unification, and metadata-driven recover — all Phase B.
