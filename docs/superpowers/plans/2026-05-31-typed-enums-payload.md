# Typed Enums in Payload VOs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each port is one task; the gate is a compile-and-run proof that the strict payload enum field is the value-constrained type AND populates from dirty input, plus a shared-abstract-enum naming/dedup case. No new unit-test scaffolding beyond extending the existing extractor compile-run tests.

**Goal:** Type every port's strict payload `field.enum` (and enum arrays) with a value-constrained, idiomatic type (TS union / Python `Literal` / C#-Java-Kotlin real enum) instead of `unknown`/`str`/`object`/`String`; the lenient mirror stays raw string; the extract mapper coerces.

**Architecture:** Per-port payload generator emits the enum type (reusing each port's existing ENTITY enum-emitter logic + the shared `<Super>`/`<Owner><Field>` naming where it exists; Java gets a new emitter, Python a small `Literal` annotation), types the enum field + enum array as that type, and the extract mapper coerces the engine-validated mirror string into the typed value (identity for TS/Python; `valueOf`/`Parse` for JVM/C#). Engine + `extract-conformance` corpus are untouched.

**Tech Stack:** Per-port codegen. Spec: `docs/superpowers/specs/2026-05-31-typed-enums-payload-design.md`. Builds on the shipped extract tier + FR-010/011 enum coercion.

---

## Worktree & conventions

Worktree `worktree-typed-enums` at `<repo-root>/.claude/worktrees/typed-enums`, branch `worktree-typed-enums`, off origin/main. Absolute paths; confirm branch before commit; `mvn install` changed JVM modules before dependents; single branch → single merge. The shipped extract tier names the strict tier `extract<Name>` and the never-throws tier `extractLenient<Name>`; the all-nullable mirror is `<Name>Extracted`.

## Shared facts (apply in every port)

- Enum value set: the field's **effective** `@values` (`"values"` attr; read the EFFECTIVE view so `extends`-inherited values resolve — TS `field.attrs()`, C# `EffectiveEnumValues`, etc.). Members are valid identifiers, verbatim (symbol == stored string).
- Naming rule (already used by entity emitters): if the field `extends`/resolves a super → use `Pascal(super.name)`; else `Pascal(owner.name) + Pascal(field.name)`. Dedupe by generated type name per output unit.
- The lenient `<Name>Extracted` mirror enum leaf stays `string`/`str` (scalar) and the enum-array leaf stays `string[]`/`list[str]` — DO NOT change the mirror.
- Only the STRICT payload field (+ the extract mapper that builds it) changes.
- The engine + the `fixtures/extract-conformance/` corpus + its 4 runners are UNCHANGED (engine emits validated strings; typing is codegen-only).

---

## Task 1: TypeScript — union-typed enum payload field

**Files:**
- Modify: `server/typescript/packages/codegen-ts/src/payload-codegen.ts` (the payload type mapper — enum branch) + emit the union alias into the payload module (reuse `renderEnumTypeAliases` from `templates/inferred-types.ts`)
- Modify: `server/typescript/packages/codegen-ts/src/templates/extractor.ts` (the `toStrict<Type>` mapper enum branch — identity)
- Test: `server/typescript/packages/codegen-ts/test/extractor-codegen.test.ts`

- [ ] **Step 1: Write the failing compile-and-run assertions.** Extend the existing Order fixture with `priority` (`field.enum` `@values ["LOW","HIGH"]`) and `labels` (enum array `@values ["A","B"]`). Regenerate payloads+parser+extractor, `await import`, and assert:
  - the emitted payload source contains `export type OrderPriority = "LOW" | "HIGH";` (union alias) and `priority: OrderPriority` (NOT `unknown`/`string`);
  - `extractOrder(dirtyWithPriorityHIGH).priority === "HIGH"`; the enum array `extractOrder(...).labels` deep-equals `["A","B"]`;
  - the lenient `extractLenientOrder(...)` mirror still returns `priority` as a plain string (mirror unchanged).
  Run → FAIL: `cd server/typescript && bun test packages/codegen-ts/test/extractor-codegen.test.ts` (the worktree may need `bunfig.toml` emptied to bypass the jsdom preload — empty it to run, do NOT commit that change). Expected FAIL: payload types `priority` as `unknown`.

- [ ] **Step 2: Implement.** In `payload-codegen.ts`, for a `FIELD_SUBTYPE_ENUM` field, emit/reference the union alias type (name via the shared rule, reusing the `renderEnumTypeAliases` naming helper from `inferred-types.ts`) instead of the `?? "unknown"` fallback; for an enum array, type it `<UnionName>[]`. Ensure the union alias is emitted into the payload module (dedup by name). In `extractor.ts`, the enum branch stays IDENTITY (`m.priority!` already assigns the string; just ensure the strict type is the union — no `toStrict` conversion for enums; for the enum array, the existing scalar-array null-drop already yields `string[]` assignable to `<Union>[]`).

- [ ] **Step 3: Run → PASS** + `bun test packages/codegen-ts` (no regression; restore bunfig).
- [ ] **Step 4: Commit** (`feat(codegen-ts): union-typed enum payload fields + arrays (extract returns the typed union)`).

---

## Task 2: Python — `Literal`-typed enum payload field

**Files:**
- Modify: `server/python/src/metaobjects/codegen/type_map.py` (`py_type_for` — add an enum branch returning `Literal[...]`) + `server/python/src/metaobjects/codegen/generators/payload_vo_generator.py` (emit a named alias `X = Literal[...]` when the field extends a shared enum; import `Literal` from `typing`)
- Modify: `server/python/src/metaobjects/codegen/generators/extractor_generator.py` (`_to_strict_*` enum branch — identity)
- Test: `server/python/tests/codegen/test_extractor_generator.py`

- [ ] **Step 1: Write the failing assertions.** Extend the Order fixture with `priority` (`field.enum` `@values ["LOW","HIGH"]`) + `labels` (enum array). Materialize+import, assert:
  - the emitted payload annotates `priority: Literal["LOW", "HIGH"]` (or the named alias `OrderPriority = Literal[...]` + `priority: OrderPriority`), NOT bare `str`;
  - `extract_order(dirty).priority == "HIGH"`; `extract_order(...).labels == ["A", "B"]`;
  - the lenient `extract_lenient_order(...)` mirror still has `priority` as `str`.
  Run → FAIL: `cd server/python && python3 -m pytest tests/codegen/test_extractor_generator.py -v` (payload types `priority` as `str`).

- [ ] **Step 2: Implement.** In `type_map.py`, add a `FIELD_SUBTYPE_ENUM` branch to `py_type_for` returning `PyType("Literal[" + ", ".join(repr(v) for v in effective_values) + "]", ("from typing import Literal",))`; for an enum array, `list[Literal[...]]`. In `payload_vo_generator.py`, when the field extends a shared enum, emit a module-level alias `OrderPriority = Literal[...]` and reference it (dedup by name); else inline. `extractor_generator.py` enum branch stays identity (`m.priority` — a `str` already satisfies `Literal`).

- [ ] **Step 3: Run → PASS** + `python3 -m pytest tests/codegen -q` + `ruff check` clean.
- [ ] **Step 4: Commit** (`feat(codegen-python): Literal-typed enum payload fields + arrays`).

---

## Task 3: C# — nested-`enum`-typed payload field + `Enum.Parse` coercion

**Files:**
- Modify: `server/csharp/MetaObjects.Codegen/PayloadCodegen.cs` (the `ScalarType`/`FieldType` path — enum → the generated nested enum type name; emit the nested `enum` decl into the payload record reusing the `CollectEnumDecls` pattern from `EntityGenerator.cs`; naming via `CSharpNaming.EnumTypeName`)
- Modify: `server/csharp/MetaObjects.Codegen/Generators/ExtractorGenerator.cs` (`StrictArg`/`ToStrict_*` enum branch → `System.Enum.Parse<X>(s)`)
- Test: `server/csharp/MetaObjects.Codegen.Tests/ExtractorCodegenTests.cs`

- [ ] **Step 1: Write the failing Roslyn compile-and-run assertions.** Extend the Order fixture with `priority` (`field.enum @values ["LOW","HIGH"]`, `@required`) + `labels` (enum array). Generate, Roslyn-compile (CS8619-as-error), reflectively invoke `Extract(mo, dirty)`, assert:
  - the payload property type is the nested enum `Order.OrderPriority` (reflect `prop.PropertyType.IsEnum == true`, name `OrderPriority`), NOT `object`;
  - the extracted value equals the enum member `OrderPriority.HIGH` (reflect the enum value); the `labels` list is `IReadOnlyList<OrderLabels>` with the right members;
  - the lenient `ExtractLenient(...)` mirror still types `priority` as `string`.
  Run → FAIL: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj --filter ExtractorCodegen` (payload `priority` is `object`).

- [ ] **Step 2: Implement.** In `PayloadCodegen.cs`: for an enum field, use `CSharpNaming.EnumTypeName(owner, field)` as the property type (instead of the `"object"` fallback) and collect+emit a nested `public enum <Name> { <members> }` into the payload record (reuse the `CollectEnumDecls` dedup-by-name logic). Enum array → `IReadOnlyList<<Name>>`. In `ExtractorGenerator.cs` `StrictArg`: enum scalar → `System.Enum.Parse<<Name>>(m.<field>!)`; enum array → `m.<field>!.Where(x => x is not null).Select(x => System.Enum.Parse<<Name>>(x!)).ToList()`.

- [ ] **Step 3: Run → PASS** + `dotnet test MetaObjects.Codegen.Tests/MetaObjects.Codegen.Tests.csproj` (no regression).
- [ ] **Step 4: Commit** (`feat(codegen-csharp): nested-enum-typed payload fields + Enum.Parse coercion in extract`).

---

## Task 4: Kotlin — `enum class`-typed payload field + `valueOf` coercion

**Files:**
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinPayloadGenerator.kt` (type the enum field/array as the enum `ClassName` via `KotlinTypeMapper.enumTypeName`; emit the enum class file reusing `KotlinEntityGenerator.emitEnumFile`'s logic — extract it to a shared helper if cleaner)
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinTypeMapper.kt` (make `kotlinTypeName(EnumField)` return the enum `ClassName` for the PAYLOAD path — or add a payload-typed accessor; keep the entity path unchanged if needed)
- Modify: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinExtractorGenerator.kt` (enum branch → `<X>.valueOf(s)`; `scalarArrayElementConversion` enum branch → `<X>.valueOf(it)`)
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinExtractorCompilesTest.kt`

- [ ] **Step 1: Write the failing kotlin-compile-testing assertions.** Extend the fixture with `priority` (`field.enum @values ["LOW","HIGH"]`) + `labels` (enum array). Compile the generated payload + parser + extractor + the emitted enum file, reflectively invoke `extract`, assert:
  - the payload `priority` property type is the generated `enum class` (e.g. `OrderPriority`), value `OrderPriority.HIGH`;
  - `labels` is `List<OrderLabels>` with the right members;
  - the lenient mirror `priority` is still `String`.
  Run → FAIL: `cd server/java && mvn -q -pl metadata,render,om install -DskipTests && mvn -pl codegen-kotlin test -Dtest=KotlinExtractorCompilesTest -DfailIfNoTests=false` (payload `priority` is `String`).

- [ ] **Step 2: Implement.** `KotlinPayloadGenerator`: for an enum field, type it `KotlinTypeMapper.enumTypeName(field, owner)` and emit the enum class file (reuse/extract `emitEnumFile`); enum array → `List<<EnumClass>>`. `KotlinExtractorGenerator`: enum scalar → `<EnumClass>.valueOf(m.<field>!!)`; the `scalarArrayElementConversion` enum case → `<EnumClass>.valueOf(it)` (currently passthrough string). Keep the entity codegen's enum path working.

- [ ] **Step 3: Run → PASS** + `mvn -q -pl codegen-kotlin test -DfailIfNoTests=false` (no regression).
- [ ] **Step 4: Commit** (`feat(codegen-kotlin): enum-class-typed payload fields + valueOf coercion in extract`).

---

## Task 5: Java — new payload enum emitter + `valueOf` coercion

**Files:**
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringPayloadGenerator.java` (type the enum field/array as a generated Java `enum`; emit `public enum <Name> { <members> }` — a NEW emitter mirroring the C#/Kotlin shape + the shared naming; nested in the payload record or a sibling file matching this generator's file model)
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringTypeMapper.java` (enum → the generated enum type name for the PAYLOAD path, was `"String"`)
- Modify: the Java extract mapper that builds the strict payload — `server/java/codegen-base/src/main/java/com/metaobjects/generator/direct/object/javacode/ExtractorCodeGenerator.java` (enum branch → `<X>.valueOf(s)`; enum array per-element `valueOf`)
- Test: `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/GeneratedExtractorCompileRunTest.java` (or the payload test that compiles the generated payload)

- [ ] **Step 1: Write the failing in-memory-javac assertions.** Extend the fixture with `priority` (`field.enum @values ["LOW","HIGH"]`) + `labels` (enum array). Compile the generated payload + the emitted enum + extractor; invoke `extract`; assert via reflection:
  - the payload `priority` getter/field type is the generated `enum` (`Class.isEnum()`), value the `HIGH` constant;
  - `labels` is `List<OrderLabels>` with the right members;
  - the lenient mirror `priority` is still `String`.
  Run → FAIL: `cd server/java && mvn -q -pl metadata,render,om install -DskipTests && mvn -pl codegen-spring test -Dtest=GeneratedExtractorCompileRunTest -DfailIfNoTests=false` (payload `priority` is `String`).

- [ ] **Step 2: Implement.** Add a Java enum emitter to `SpringPayloadGenerator` (`public enum <Name> { <members> }`, name via the shared rule, dedup by name, nested or sibling per the generator's file model). `SpringTypeMapper`: enum → `<Name>` for the payload path (keep entity/other paths as-is if separate). `ExtractorCodeGenerator`: enum scalar → `<Name>.valueOf(s)`; enum array per-element `valueOf`.

- [ ] **Step 3: Run → PASS** + `mvn -q -pl codegen-spring test -DfailIfNoTests=false` (no regression).
- [ ] **Step 4: Commit** (`feat(codegen-java): generated payload enum type + valueOf coercion in extract`).

---

## Task 6: Shared-abstract-enum naming/dedup proof + closeout

**Files:**
- Test: one assertion in EACH port's extractor test (or a small dedicated test) for the shared-enum case.

- [ ] **Step 1: Shared-enum dedup proof (per port).** In each port's extractor test, add a fixture with TWO payload fields that `extends` ONE abstract `field.enum` (e.g. abstract `Status @values ["ACTIVE","INACTIVE"]`, fields `state` + `prevState` both `extends Status`). Generate and assert: exactly ONE enum type named `Status` (the super name, NOT `OrderState`/`OrderPrevState`) is emitted, and BOTH fields are typed `Status`. This proves the `<Super>` naming + dedup per port. Run each port's extractor test → green.

- [ ] **Step 2: Full per-port suites + value-oracle.** Run each port's codegen + render(conformance) suite; confirm the `extract-conformance` 4 runners are STILL green (engine unchanged) and all extractor compile-run tests green. (JVM `mvn -pl render,codegen-base,codegen-spring,codegen-kotlin test`; C# `dotnet test` the Codegen+Render projects; TS `bun test packages/codegen-ts packages/render`; Python `pytest tests/codegen tests/conformance`.)

- [ ] **Step 3: Final whole-branch review.** Reviewer over `git diff origin/main..HEAD`: confirm (a) each port's strict payload enum field is the value-constrained type + enum arrays typed; (b) the extract mapper coerces correctly (identity TS/Python; `valueOf`/`Parse` JVM/C#) and is safe (validated member); (c) the lenient mirror is UNCHANGED (still string); (d) the engine + `extract-conformance` corpus are UNCHANGED; (e) the shared `<Super>` naming + dedup holds per port; (f) no behavior change beyond typing; (g) hygiene. Fix findings.

- [ ] **Step 4: Docs + memory + merge.** Roadmap entry (typed enums in payload VOs, all 5 ports, lenient stays string). Memory note. Forward-merge onto current origin/main (fetch; merge if advanced; re-verify; FF-push). Remove worktree. Publish stays deferred.

---

## Notes for the executor

- **Reuse the entity enum-emitter + naming** (TS `renderEnumTypeAliases`, C# `CollectEnumDecls`, Kotlin `emitEnumFile`); only Java + Python add new emission. Do NOT invent a new naming scheme — use `<Super>`/`<Owner><Field>`.
- **Lenient mirror stays string** — the `<Name>Extracted` enum leaf must NOT change. Only the strict payload + extract mapper change.
- **Identity vs valueOf:** TS union + Python `Literal` need NO runtime conversion (string ⊆ type). C#/Java/Kotlin need `valueOf`/`Parse` on the validated member.
- **Engine + extract-conformance corpus UNCHANGED** — if a conformance case goes red, you changed the engine by mistake; stop.
- **Compile-and-run is the gate** — it compiling proves the type is value-constrained; running proves coercion works. Assert the enum CONSTANT/member, not just a string.
- Absolute worktree paths; `mvn install` changed JVM modules before dependents; confirm branch before commit; don't commit a temporary `bunfig.toml` change.
