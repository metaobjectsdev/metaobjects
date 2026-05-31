# Metadata-Driven Recover (Phase B) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make recover runtime-first and metadata-driven: `recover(MetaObject, text) → RecoveryResult<Object>` assembles the object graph via the Phase A object model (`newInstance` + field SPI; ValueObject or codegen'd, caller casts), with array-of-enum coercion and `@default` generalized to all field types; the codegen `recover()` delegates to it.

**Architecture:** The recover ENGINE already produces a nested `Map`/`List` tree + `RecoveryReport` (byte-pinned by `recover-conformance`). Phase B adds: (1) generalized `@default` + array-of-enum in the engine/metamodel; (2) a runtime `recoverSchemaFor(MetaObject)` builder + an `assemble(MetaObject, data)` that walks the tree through Phase A `newInstance`/field-SPI; (3) `recover(mo, text)` tying them together (never-throws + `orThrow()`); (4) codegen `recover()` delegates. Java/JVM pilot, then TS/Python/C#. Conformance-gated.

**Tech Stack:** Java/Maven (pilot, shared JVM `render` engine), Kotlin (JVM), TS/Bun, Python/pytest+uv, C#/.NET. Spec: `docs/superpowers/specs/2026-05-30-recover-codegen-nested-design.md`. Builds on Phase A (`a15a8421`, ADR-0017): `MetaObject.newInstance`, `MetaField` get/set-by-name SPI, `ObjectClassRegistry`, `resolutionKey`/`getObjectRef`.

---

## Worktree

Existing `worktree-recover-codegen-nested`. `$WT` = `<repo-root>/.claude/worktrees/recover-codegen-nested` (executor substitutes the real absolute path). Absolute worktree paths only; subagents never `git checkout` SHAs; confirm branch before commit. Single branch, single final merge. **`mvn -pl <module> install -DskipTests` the changed JVM module before testing dependents** (stale-.m2 gotcha).

## Engine reference (study)

- `server/java/render/src/main/java/com/metaobjects/render/recover/Recover.java` — `extract(fields, raw, prefix, data, report, o, ci)` recursively builds the nested `Map`/`List` tree; FR-011 `@default` fill is at the top of the per-field loop, gated `f.kind()==ENUM && f.defaultValue()!=null`; `coerceOne` recurses OBJECT, coerces scalars/enums.
- `FieldSpec.java` (record: name, kind, required, array, enumValues, enumAlias, min, max, nested, coerceDefault, defaultValue, normalize) + factories; `RecoverMap.java`; `RecoverOutcome` (`data()`/`report()`), `RecoveryResult` (`data`/`report`), `RecoveryReport` (`states()`/`hasLostRequired()`/`lostRequired()`).
- Codegen: `server/java/codegen-spring/.../generator/spring/RecoverSchemaEmitter.java` (`schemaLiteral`/`constructorArgs` — reads enum attrs/objectRef from MetaObject) + `SpringOutputParserGenerator.java` (emits `recover()`).
- Phase A: `server/java/metadata/.../object/MetaObject.java` (`newInstance`), `.../field/MetaField.java` (`setObject`/`getObject`/`getEffectiveDataType`), `MetaDataUtil.getObjectRef`. TS/Python/C# Phase A object models under `core/object/` (TS), `meta/core/object/` (Py), `Meta/` (C#).
- Corpus format: `fixtures/recover-conformance/<case>/{schema.json, input.txt, expected.json}` (expected = `{empty, states, data}`).

---

## Task 1: Generalized `@default` — metamodel + engine (JVM pilot)

**Files:**
- Modify: `server/java/render/src/main/java/com/metaobjects/render/recover/Recover.java` (lift the `@default` enum-gate); `FieldSpec.java` (allow `defaultValue` on non-enum factories).
- Modify: Java metamodel `@default` registration + per-type validation (find where FR-011 registered `@default` on `field.enum` — `EnumField` / `ValidationPhase`); generalize to the field base + per-type validation.
- Create: `fixtures/conformance/error-default-non-coercible-*` (per-type bad-default error fixtures) + `fixtures/recover-conformance/default-scalar-*` (generalized-default recover cases).
- Modify: Java `setDefaultValues`/`getDefaultValue` unification (`MetaObject.java`/`MetaField.java`).

- [ ] **Step 1: Engine — lift the `@default` enum-gate.** In `Recover.extract`, the absent-field `@default` fill currently requires `f.kind()==ENUM`. Generalize so ANY field with `defaultValue()!=null` fills when absent → `DEFAULTED`. The coerced value must match the kind (string as-is; int/long/double parsed; boolean parsed) — reuse the existing scalar coercion (`Coerce`) to convert the default string to the field's kind before `data.put`. Concretely, replace the enum-gated block with a kind-agnostic one:
```java
if (f.defaultValue() != null) {
    Object coerced = (f.kind() == FieldKind.ENUM)
        ? f.defaultValue()                                  // enum default is the member string
        : Coerce.coerceScalar(f.defaultValue(), f, path, report, o); // parse to kind
    if (coerced != Coerce.MALFORMED) {
        data.put(f.name(), coerced);
        report.addCoercion(new Coercion(path, "", f.defaultValue(), "default"));
        report.set(path, FieldRecovery.DEFAULTED);
        continue;
    }
}
```
(Confirm `Coerce`'s scalar-coercion entry point + signature; adapt the call. If a default fails to coerce to its kind, that's a load-time validation error — see Step 3 — so at runtime it should always succeed.)

- [ ] **Step 2: `FieldSpec` — allow `defaultValue` on scalar factories.** Add an overload (or a `withDefault`) so `scalar(...)` can carry a `defaultValue`. Keep the record field; add a builder path. Unit-test: a scalar INT FieldSpec with `defaultValue="0"`, absent in input, recovers `0` + `DEFAULTED`.

- [ ] **Step 3: Metamodel — generalize `@default` + per-type validation.** Find FR-011's `@default` registration (enum-only) and move it to the field base so any `field.*` may declare `@default`; add load-time validation that the value coerces to the field's kind (int/long/double parse; boolean `true|false`; enum member-validated as today; string any). Emit `ERR_BAD_ATTR_VALUE` otherwise.

- [ ] **Step 4: Unify the legacy Java default mechanism.** `MetaObject.setDefaultValues()` uses `MetaField.getDefaultValue()`. Make `getDefaultValue()` read the generalized `@default` attr (so `newInstance`-time default population and recover use ONE source). Verify `om`/`omdb` (which call `setDefaultValues`) stay green.

- [ ] **Step 5: Conformance.** Add `fixtures/recover-conformance/default-scalar-int` (schema with `field.int` + `@default`, input omitting it, expected `DEFAULTED` + the value) and an `error-*` fixture for a non-coercible `@default`. Run the Java recover-conformance + metamodel-conformance + full metadata/render/om suites.

- [ ] **Step 6: Commit** (`feat(recover): generalize @default to all field types (engine + metamodel + Java default-value unification)`).

---

## Task 2: Array-of-enum coercion (JVM pilot)

**Files:** `FieldSpec.java` (enum + array), `Recover.java`/`Coerce.java` (per-element enum coercion), `fixtures/recover-conformance/array-of-enum*`.

- [ ] **Step 1: `FieldSpec` enum-array.** Allow an enum FieldSpec with `array=true` — add an `enumArray(name, required, values, aliases, coerceDefault, normalize, defaultValue)` factory (kind ENUM, array true, carrying the enum attrs).
- [ ] **Step 2: Engine per-element enum coercion.** In `Recover.extract`'s array branch, each element of an enum-array is coerced through the enum pipeline (the same path scalar enums use in `coerceOne`/`Coerce`), classified per indexed path (`tags[0]`…); empty/missing → empty list. Confirm `coerceOne` routes an ENUM element through enum coercion regardless of the parent field's `array` flag.
- [ ] **Step 3: Conformance.** `fixtures/recover-conformance/array-of-enum` (enum-array schema, input with a mix incl. an aliasable + an uncoercible value, expected per-element states + coerced values). Run Java recover-conformance.
- [ ] **Step 4: Commit** (`feat(recover): array-of-enum per-element coercion (engine)`).

---

## Task 3: Runtime recover — `recoverSchemaFor` + `assemble` + `recover(mo,text)` (Java pilot)

**Files:**
- Create: `server/java/render/.../recover/RecoverObject.java` (or add to a runtime-recover class) — the runtime entry points. (Note: `render` depends on `metadata` for `MetaObject`/`MetaField`/Phase-A SPI — confirm; if `render` must not depend on `metadata`, place this in a module that has both, e.g. a small new class in `metadata` or `om`. Check the dependency direction first and site it where `MetaObject` + `RecoverSchema` are both visible.)
- Create: a verdict object-recover test + a verdict metadata fixture.

- [ ] **Step 1: `recoverSchemaFor(MetaObject) → RecoverSchema`.** Walk `mo.getMetaFields()`: scalar→`FieldSpec.scalar` (+ `@default`); enum→`FieldSpec.enumField(values, aliases, coerceDefault, normalize, default)` reading the enum attrs (mirror `RecoverSchemaEmitter.enumFieldSpec`); enum-array→`enumArray`; object→`FieldSpec.object(required, isArray, recoverSchemaFor(getObjectRef(field)))` recursively. Carry generalized `@default`. **Cycle/depth guard**: a visited-`MetaObject`-identity set + `MAX_NEST_DEPTH` (shared constant); at a cycle/limit, emit a scalar STRING leaf (opaque). Unit-test the schema for the verdict MetaObject matches a hand-built one.

- [ ] **Step 2: `assemble(MetaObject, Map<String,Object> data) → Object`.** `Object o = mo.newInstance();` for each field: scalar/enum → `field.setObject(o, data.get(name))` (the engine already coerced); OBJECT (non-array) → child map → `assemble(getObjectRef(field), childMap)` → `setObject`; OBJECT_ARRAY → list of `assemble(getObjectRef(field), elemMap)` → `setObject`; enum-array/scalar-array → the (coerced) list. Same cycle/depth guard. Returns the `Object` (ValueObject or bound type). Unit-test: assemble a hand-built nested data map → a ValueObject graph with the right field values + nested back-refs.

- [ ] **Step 3: `recover(MetaObject mo, String text, RecoverOptions opts) → RecoveryResult<Object>`** = `Recover.recover(text, recoverSchemaFor(mo), opts)` → `assemble(mo, outcome.data())` + `outcome.report()`. Plus `recover(mo, text)` defaulting opts. Never throws.

- [ ] **Step 4: `RecoveryResult.orThrow()`** — add (Java): throws (a clear `RecoveryException`) iff `report.hasLostRequired()`, else returns `this` (or `data`). Unit-test both branches.

- [ ] **Step 5: Verdict oracle test.** Create a verdict metadata fixture (the adjudication-verdict object.value: scalars incl. `arc_transition` enum + `@default`, an array-of-enum `tags`, and the 7 arrays-of-records with enum/optional fields) + a dirty XML input; `recover(verdictMo, xml)` → assert every array populated with typed records (ValueObject children), array-of-enum coerced, default filled (DEFAULTED), self-closing → empty list, optionals null; never throws; `orThrow()` behavior. This is the gold-standard proof.

- [ ] **Step 6: Commit** (`feat(recover): runtime recover(MetaObject,text) via Phase A object model + orThrow + verdict proof`).

---

## Task 4: Kotlin — runtime recover over the JVM engine (runner/glue)

- [ ] Confirm the JVM runtime recover is reachable from a Kotlin-test module; add a Kotlin verdict object-recover test mirroring Task 3 Step 5 (proves it works through Kotlin). `mvn -pl <render-or-host-module> install -DskipTests` first. Commit.

---

## Task 5: TypeScript runtime recover

**Files:** `server/typescript/packages/render/src/recover/` (add `recoverSchemaFor` + `assemble` + `recoverObject`) using the Phase A TS object model (`@metaobjectsdev/metadata` `MetaObject.newInstance`, field SPI, `ObjectClassRegistry`, `resolutionKey`); `RecoveryResult.orThrow`; engine generalized-`@default` + array-of-enum (port Tasks 1-2 to the TS recover engine); a verdict object-recover test.

- [ ] Port Tasks 1-2 (generalized `@default` + array-of-enum) into the TS recover engine; extend the TS recover-conformance runner for the new cases. Port Task 3 (`recoverSchemaFor`/`assemble`/`recoverObject`/`orThrow`) on the TS Phase A model. Verdict test. `bun test` recover + the new object-recover green; typecheck. Commit.

---

## Task 6: Python runtime recover

- [ ] Same as Task 5 for Python (`server/python/src/metaobjects/render/recover/`): generalized `@default` + array-of-enum in the Python engine + conformance cases; `recover_schema_for`/`assemble`/`recover_object`/`or_throw` on the Python Phase A model; verdict test; `pytest` + ruff + mypy. Commit.

---

## Task 7: C# runtime recover

- [ ] Same for C# (`server/csharp/MetaObjects.Render/Recover/`): generalized `@default` + array-of-enum + conformance; `RecoverSchemaFor`/`Assemble`/`RecoverObject`/`OrThrow` on the C# Phase A model (reflection-free — uses `ITypedFieldAccessor`/registry); verdict test; `dotnet test`, 0 warnings. Commit.

---

## Task 8: Codegen `recover()` delegates to the runtime path (all 5 ports)

- [ ] For each port's output-parser generator (Java `SpringOutputParserGenerator` + `RecoverSchemaEmitter`; Kotlin; TS `recover-schema-emitter`/codegen; Python; C#): reimplement the emitted `recover()` to resolve its payload `MetaObject` and call the runtime `recover(mo, text)`, returning the typed result (cast / populate the mirror). Remove the baked-`RecoverSchema`/constructor-args duplication where superseded. **Gate:** the existing FR-010/FR-011 codegen recover tests + recover-conformance stay green, AND a generated parser now recovers a NESTED payload into a populated typed object (the original Plan-2.1 ask, now via delegation). Per-port compile/import-and-run proof. Commit per port (or one commit if tightly coupled).

---

## Task 9: Close-out

- [ ] Final whole-branch review (all 5 ports: generalized `@default`, array-of-enum, runtime recover into object graph, codegen delegation; recover-conformance byte-green; reflection-free; Phase A invariants intact; hygiene). Update `codegen-spring/.../KNOWN_GAPS.md` (Plan 2.1 CLOSED) + per-port KNOWN_GAPS; `spec/roadmap.md`; memory. Merge forward (FF-push) — remove the worktree (Phase B is the last phase). **Then surface `Publish` for the user's confirm** (do NOT publish without it).

---

## Notes for the executor

- **recover() never throws** — the cross-port invariant. `orThrow()` is the opt-in. Don't break it; recover-conformance pins it.
- **Conformance is the gate** — recover-conformance (engine, byte-pinned: states + canonical data) + object-recover (behavioral: object graph). A divergence is a port bug, never a corpus edit.
- **Reflection-free** — runtime recover assembles via the Phase A SPI (ValueObject map / `ITypedFieldAccessor` / registered factory); no `Type.GetType`/`Activator`/`reflect-metadata`/`importlib`.
- **Generalized `@default` is recover + `newInstance` only** — NOT strict `parse()`/DDL (out of scope). Non-enum scalar arrays stay `asStringList` (only array-of-enum).
- **Cycle/depth guard** in both `recoverSchemaFor` and `assemble` (shared `MAX_NEST_DEPTH`, identity visited-set) — unit-tested per port.
- **Absolute worktree paths; `mvn install` changed JVM modules before dependents; no `git checkout` of SHAs; confirm branch before commit.**
- **Publish** is deferred — surface it at close-out for explicit confirm.
