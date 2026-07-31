# #228 — Collision-scoped payload naming in the extract/output-parser tier (all 5 ports) Implementation Plan

> **For agentic workers:** Execute with superpowers:subagent-driven-development, one fresh implementer per task + per-task review. Steps use checkbox syntax.

**Goal:** ADR-0044 made payload-record naming collision-scoped in every port's PAYLOAD generator (two cross-package same-short-name `object.value`s → package-qualified names like `AcmeAlphaNotePayload`). #228: the **extract / output-parser tier** — which imports those nested classes — still names/imports them by BARE short name, so under a collision it references a class the payload generator no longer emits. Extend the collision-scoped naming to that tier in all 5 ports, gated by a new json/xml collision fixture. **Latent today** (the only collision fixture is `@format: html`; the extract tier gates on `@format ∈ {json,xml}`), so nothing shipped is wrong — but it's the last known instance of the bare-name bug class (sibling of #219/#220/#244).

**Design settled (fable ruling, 2026-07-29):** TS uses **Option A** — the extractor's strict type is the per-VO ENTITY module (not the payload interface, which deliberately differs: `?:T|null` vs `?:T`, decimal `number` vs `string`, uuid/uri/inet/map → `unknown`, and lives in the optional relocatable `promptRender()` output). Cross-port invariant: the extractor's strict type = **each port's canonical strict artifact** — payload record (Py/C#/Kotlin), flavored class (Java), per-VO entity module (TS). So the 4 non-TS ports reuse their OWN payload name-map (mechanical); TS additionally brings its entity tier into ADR-0044 scope (the entity-file clobber is the load-bearing half in TS — NOT deferrable).

**Reference:** ADR-0044 (`spec/decisions/ADR-0044-payload-record-naming-cross-package-collision.md`). Backstop `ERR_PAYLOAD_NAME_COLLISION` already in the shared ledger since 0.19.3.

## Global Constraints

- **Byte-identical, all ports, when non-colliding.** Qualification activates ONLY when two closure/domain members share a bare short name. A collision-free model emits today's exact names/paths. Pin with no-churn tests. **TS: the golden byte-gate lives OUTSIDE the per-package suite — run `cd server/typescript/packages/codegen-ts && bun test test/golden/` and regen only with proof.**
- **The collision domain differs by tier (TS-specific, load-bearing):** the PAYLOAD/prompts artifact keeps its per-payload-closure domain; the ENTITY tier's domain is the run/target's emitted-object SET (filenames + `runner.ts` `packageOf` are per-outDir global). These two artifacts may assign different names to the same VO — each internally consistent. The extract tier imports from entity modules, so it MUST use the entity-domain name map, never payload-codegen's closure map.
- **Resolution stays ADR-0041/0042 FQN-exact/package-local.** Where a port's extract tier resolves a `@objectRef` by bare name (Python `ref_vo`/`_find_object`, C# `RefVo`/`FindObject`), route it through the port's canonical resolver (`resolve_object_ref` / `NamingRefs.ResolveObjectRef`) — this fixes a wrong-node resolution bug (the #219 disease), not just naming.
- Reuse `ERR_PAYLOAD_NAME_COLLISION` as the backstop (already central, all ports). No new vocabulary; no metamodel change (ADR-0023 unaffected).
- Each port compiles + tests locally before its commit. Scope tests to the port (`scripts/ci-local.sh --only <port>` or the port's native runner). Never bare repo-root `bun test`.
- Stage explicit paths; never `git add -A` (untracked `.serena/`). Commit to this branch.
- Detailed per-file:line scope lives in each task below (captured from the scoping pass).

---

### Task 1: Shared json/xml collision fixture

**Files:** Create `fixtures/template-output-render-conformance/xpkg-collision-json/{meta.alpha.json,meta.beta.json,meta.app.json}`; modify that corpus's `README.md`; modify `docs/CONFORMANCE.md`.

The extract/parser tier gates on `@format ∈ {json,xml}`; the existing `xpkg-collision/` fixture is `@format: html`, so it never exercises the tier. This fixture is a near-copy that DOES.

- [ ] **Step 1:** Copy the three metadata files from `fixtures/template-output-render-conformance/xpkg-collision/` verbatim (`meta.alpha.json` = pkg `acme::alpha`, `object.value Note{alphaText @required}`; `meta.beta.json` = pkg `acme::beta`, `object.value Note{betaText @required}`; `meta.app.json` = pkg `acme::app`, `object.value Digest` with `field.object fromAlpha @objectRef=acme::alpha::Note` + `fromBeta @objectRef=acme::beta::Note`, and a `template.output DigestDoc @payloadRef=Digest @textRef=xpkg/digest`). In the copy, change the `template.output`'s `"@format": "html"` → `"@format": "json"`. Everything else identical. No `expected.json` (this corpus pins expectations in prose + inline per-port test assertions).
- [ ] **Step 2:** Add a section to `fixtures/template-output-render-conformance/README.md` mirroring the existing "Cross-package short-name collision" section, describing the json variant and that it exercises the extract/output-parser tier; state the expected emitted nested names (`AcmeAlphaNotePayload`/`AcmeBetaNotePayload` for Py/Java/Kotlin; `AcmeAlphaNote`/`AcmeBetaNote` for TS/C#).
- [ ] **Step 3:** Bump the fixture count in `docs/CONFORMANCE.md` (the template-output-render-conformance row).
- [ ] **Step 4:** Validate the three JSON files parse (`node -e "JSON.parse(require('fs').readFileSync('<f>'))"` each). Commit `test(#228): add json xpkg-collision fixture for the extract/output-parser tier`.

Note: `template-output-render-conformance` has NO auto-discovery — each port's test hardcodes the dir + filenames. So this fixture does nothing until a port adds a test method referencing it (done per-port in Tasks 4-8).

---

### Task 2: TS — shared collision-naming module (pure refactor, no behavior change)

**Files:** Create `server/typescript/packages/codegen-ts/src/naming/collision-names.ts`; modify `src/payload-codegen.ts`; Test `test/naming/collision-names.test.ts`.

`assignEmittedNames` (payload-codegen.ts:139) and `packageQualifiedName` (within payload-codegen.ts:111-176) are pure functions of `(fqn, bareName, package)` triples. Extract them to a shared module so the entity + extract tiers can reuse the identical algorithm.

- [ ] **Step 1 (test):** Write `collision-names.test.ts`: assert `assignEmittedNames` over a closure with a unique bare name → bare emitted name; over a closure with two same-bare-name FQNs → both package-qualified (`AcmeAlphaNote`/`AcmeBetaNote`); a still-colliding derived name → throws `ERR_PAYLOAD_NAME_COLLISION`. Mirror the existing payload-codegen collision tests.
- [ ] **Step 2:** Move `assignEmittedNames` + `packageQualifiedName` (+ the `ERR_PAYLOAD_NAME_COLLISION` throw) verbatim into `collision-names.ts`, exported. Keep signatures identical.
- [ ] **Step 3:** `payload-codegen.ts` re-imports them (delete the local copies). Run `bun test test/payload-codegen.test.ts` — must stay green (byte-identical payload output). Run the golden gate `bun test test/golden/`.
- [ ] **Step 4:** Typecheck (`cd server/typescript && bun run --filter '@metaobjectsdev/codegen-ts' typecheck`). Commit `refactor(#228): extract collision-name assignment into a shared module`.

---

### Task 3: TS — entity tier into ADR-0044 scope (Option A)

**Files:** modify `src/templates/entity-file.ts` (+ `src/generators/entity-file.ts` if the filename is decided there), `src/templates/inferred-types.ts`, `src/templates/zod-validators.ts`, `src/templates/drizzle-schema.ts`, `src/import-path.ts`, `src/runner.ts`; Tests: extend the relevant per-template tests + a new collision test.

Make the per-VO entity module (interface name + output filename) collision-aware, keyed by the **run/target emitted-object set** (NOT the payload closure). This is the load-bearing half of TS #228 (the extract tier imports FROM here).

- [ ] **Step 1 (test):** Add a collision test: two same-short-name `object.value`s across packages, run entity-file generation, assert both emit distinct interfaces (`AcmeAlphaNote`/`AcmeBetaNote`) to distinct module paths, and every `valueObjectModuleSpecifier`-routed reference (Zod `<Ref>InsertSchema`, Drizzle `.$type<>()`, inferred-types field.object/map) uses the qualified name. Assert non-colliding case byte-identical (no-churn).
- [ ] **Step 2 (impl):**
  - Build the entity-domain name map once (over the run's emitted `object.value` set) using `collision-names.ts` `assignEmittedNames`.
  - `runner.ts` (~146-148): `packageOf` currently `Map` keyed by bare `o.name` — the second same-named object overwrites the first (the #244 disease, load-order-dependent misbinding in package layout). Key it by the emitted name (unique by construction via the backstop), so `valueObjectModuleSpecifier` resolves the right module.
  - `inferred-types.ts` (`valueObjectFieldType` field.object/field.map ref branches, ~260-264/274-278): `stripPackage(ref)` → name-map lookup by `resolutionKey()`. `renderValueObjectInterface` (~314) declaration name → emitted name.
  - `entity-file.ts` output filename → emitted name; `import-path.ts` `valueObjectModuleSpecifier` (~69-78) → emitted name.
  - `zod-validators.ts` `<Ref>InsertSchema` imports; `drizzle-schema.ts` `.$type<>()` imports → emitted names.
  - Enum alias names follow the emitted owner name (`enumUnionAliasName(ownerName, …)`), matching what payload-codegen.ts:265 already does.
- [ ] **Step 3:** Run the codegen-ts suite + the golden gate. Non-colliding output MUST be byte-identical (regen golden only with proof the diff is collision-only). Typecheck.
- [ ] **Step 4:** Commit `fix(#228): TS entity tier emits collision-scoped value-object names (Option A)`.

---

### Task 4: TS — extract/output-parser tier + TS collision test

**Files:** modify `src/templates/extractor.ts`, `src/templates/extract-delegate-emitter.ts`, `src/templates/output-parser.ts`; Test: a TS test method vs the Task-1 fixture + inline collision tests.

Thread the entity-domain name map through the extract tier; replace every bare `vo.name` name/dedupe key with `resolutionKey()`-keyed lookups.

- [ ] **Step 1 (test):** TS test loading `fixtures/template-output-render-conformance/xpkg-collision-json/` (hardcoded path, like the existing render-helper-conformance xpkg test at `test/render-helper-conformance.test.ts`), running `extractor()` + `outputParser()` + `entityFile()`, asserting the emitted extractor/parser source imports/references `AcmeAlphaNote`/`AcmeBetaNote` (matching Task 3's entity module) and NOT bare `Note`; and that both mirror types/mappers are emitted (not dropped). Compile the generated output if the test harness supports it.
- [ ] **Step 2 (impl):**
  - `extract-delegate-emitter.ts`: `mirrorName`(54)/`mapperName`(59) → name-map; the four `seen`-by-`vo.name`/`cur.name` sets (109,171,245,288) → `resolutionKey()`. Signature changes ripple to exported `nestedMirrorInterfaces`/`nestedMappers`/`mirrorName`/`usedHelpers`/`hasNested` (thread the map).
  - `extractor.ts`: `mapperName`(91-93), `emitMapper` dedupe/mir (181,186), `reachablePayloadGroups` dedupe+naming+module-target (229-230,235,243 — module target = the entity-domain emitted name from Task 3), `reachableMirrorTypes` (259,264-266), `strictType = vo.name`(308) → entity-domain name map.
  - `output-parser.ts`: the extract-delegate calls (180,205,207) thread the map. (Its inline Zod schema has no type names — no change. The `root.findObject(vo.name)` runtime lookup at 196/224 is a separate FQN-runtime hazard — note it, but keep in scope only if a fixture exercises it; otherwise leave a `// #228: bare findObject...` comment and a follow-up note in the report.)
  - `refVo()` in both files already resolves FQN-exact (no change needed).
- [ ] **Step 3:** codegen-ts suite + golden gate + typecheck. Non-colliding byte-identical.
- [ ] **Step 4:** Commit `fix(#228): TS extract/output-parser tier uses collision-scoped names`.

---

### Task 5: Python — extract tier collision naming + wrong-node fix

**Files:** modify `server/python/src/metaobjects/codegen/extract_delegate_emitter.py`, `server/python/src/metaobjects/codegen/generators/extractor_generator.py`; promote 2 funcs from `codegen/generators/payload_vo_generator.py` (or a small shared module); Test: `server/python/tests/codegen/` new collision test.

Python has TWO bug classes here (worse than naming): `reachable_vos` drops the 2nd colliding VO; `ref_vo` mis-resolves.

- [ ] **Step 1 (test):** pytest loading `xpkg-collision-json/` (hardcoded path like `test_render_helper_conformance.py`), asserting the extractor + output-parser emit BOTH `AcmeAlphaNotePayload`/`AcmeBetaNotePayload` mirror/mapper/imports (not a dropped 2nd VO, not bare `NotePayload`).
- [ ] **Step 2 (impl):**
  - Promote `_assign_nested_names` + `_package_qualified_name` (payload_vo_generator.py:471-479,547-582) to shared/exported; reuse `ERR_PAYLOAD_NAME_COLLISION` (errors.py:138).
  - `extract_delegate_emitter.py`: `ref_vo`/`_find_object` (38-63) → `resolve_object_ref(root, ref, referrer_pkg)` (naming_refs.py:190), drop the bare-tail fallback; `reachable_vos` (131-148) dedupe key `cur.name` → `cur.resolution_key()`; `mirror_name`/`_mapper_name` (72-79) → name-map; thread the map through `_nested_mirror_type`(109), `nested_mirror_dataclasses`/`_one_mirror`(177,190), `nested_mappers`/`_one_mapper`/`_mapper_arg`(219-270).
  - `extractor_generator.py`: `_strict_class`(62-68), `_mapper_name`(71-73), strict_imports loop (181-185) → name-map.
- [ ] **Step 3:** `cd server/python && uv run --extra integration pytest tests/codegen/` (scope to codegen). Commit `fix(#228): Python extract tier collision-scoped naming + FQN resolution`.

---

### Task 6: C# — extract tier collision naming (shared ExtractDelegateEmitter)

**Files:** modify `server/csharp/MetaObjects.Codegen/Generators/ExtractDelegateEmitter.cs`, `Generators/ExtractorGenerator.cs`, `Generators/OutputParserGenerator.cs`, `MetaObjects.Codegen/PayloadCodegen.cs` (visibility); Test: `MetaObjects.Codegen.Tests/` new collision test.

Both generators funnel through `ExtractDelegateEmitter` — highest leverage.

- [ ] **Step 1 (test):** test loading `xpkg-collision-json/`, asserting extractor + output-parser emit `AcmeAlphaNote`/`AcmeBetaNote` mirror/mapper/refs, not bare/dropped. Mirror `PayloadGeneratorTests.cs:121`.
- [ ] **Step 2 (impl):**
  - `PayloadCodegen.cs`: promote `CollectClosure`(123)+`AssignEmittedNames`(171) private→internal (or add one internal wrapper returning `(order, byFqn, nameMap)`). `ResolveEmittedName`(218) already internal.
  - `ExtractDelegateEmitter.cs`: `FindObject`(40-42)/`RefVo`(49-57) → `NamingRefs.ResolveObjectRef`/`EffectivePackage` (NamingRefs.cs:49,70, public); `MirrorName`(68)/`MapperName`(71) → name-map; thread through all consumers.
  - `ExtractorGenerator.cs`: root strict/mirror/class (87-89), `EmitMapper`(157-158), `StrictArg`(187-190), `EnumTypeRef`(238 — pass the EMITTED owner name to `PayloadCodegen.EnumTypeName`).
  - `OutputParserGenerator.cs`: payload-root resolution (95/107 `StripPkg`+root-scan) → FQN-aware.
- [ ] **Step 3:** `cd server/csharp && dotnet test` (or `scripts/ci-local.sh --only csharp`). Commit `fix(#228): C# extract/output-parser tier collision-scoped naming`.

---

### Task 7: Java — SpringOutputParserGenerator collision naming

**Files:** modify `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringOutputParserGenerator.java`, `SpringPayloadGenerator.java` (visibility); Test: `SpringOutputParserGeneratorTest.java` (or a new test).

Smallest port — single-file fix + reuse the payload name-map.

- [ ] **Step 1 (test):** test loading `xpkg-collision-json/` (hardcoded, like `SpringPayloadGeneratorTest.java:812`), asserting the output-parser's `from<PayloadClass>` mappers reference `AcmeAlphaNotePayload`/`AcmeBetaNotePayload`.
- [ ] **Step 2 (impl):**
  - `SpringPayloadGenerator.java`: `computePayloadNameMap`(159-207)+`collectNestedClosure`+`nestedTargetOf`+`packageQualifiedName` protected/instance → `public static`.
  - `SpringOutputParserGenerator.java`: `execute()`(113-131) gather ALL `MetaTemplate` (not just `SUBTYPE_OUTPUT`) so the nameMap domain matches the payload generator's; thread a `Map<String,String> nameMap` through `emit → emitMapperMethods → emitMapper → mapperArgForField`; fix `nestedPayloadClass`(369-371) to consult it.
- [ ] **Step 3:** `cd server/java && mvn -pl codegen-spring test` (or `scripts/ci-local.sh --only java`; NO `-T`). Commit `fix(#228): Java output-parser tier collision-scoped payload naming`.

---

### Task 8: Kotlin — extract tier collision naming (three-tier)

**Files:** modify `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinPayloadGenerator.kt` (or lift to `KotlinGenUtil.kt`), `KotlinOutputParserGenerator.kt`, `KotlinExtractSchemaEmitter.kt`, `KotlinExtractMapperEmitter.kt`, `KotlinExtractorGenerator.kt`; Test: `KotlinOutputParserGeneratorTest.kt`/new.

Heaviest — three tiers (Payload → Extracted mirror → strict Payload); Kotlin `protected` ≠ same-package.

- [ ] **Step 1 (test):** test loading `xpkg-collision-json/`, asserting the extractor/parser reference `AcmeAlphaNotePayload`/`AcmeBetaNotePayload` (strict) AND collision-scoped `...Extracted` mirror names.
- [ ] **Step 2 (impl):**
  - LIFT `computePayloadNameMap`+`collectNestedClosure`+`nestedTargetOf`+`packageQualifiedName` from `KotlinPayloadGenerator.kt`(107-221) into `KotlinGenUtil` (public object).
  - `KotlinOutputParserGenerator.kt`: `execute()` gather ALL MetaTemplate; thread nameMap.
  - `KotlinExtractSchemaEmitter.kt`: `nestedExtractedClass`(66-67) — collision-scope the "Extracted" mirror family (its own second naming scheme); thread nameMap through `extractedClassDeclsNested→emitMirror→nestedNullableTypeName`.
  - `KotlinExtractMapperEmitter.kt`: 74,91 — thread nameMap.
  - `KotlinExtractorGenerator.kt`: 239-242,271 — use the strict Payload nameMap (for `toStrict<Name>`) AND the mirror nameMap (for `<Name>Extracted`).
- [ ] **Step 3:** `cd server/java && mvn -pl codegen-kotlin test` (or `scripts/ci-local.sh --only kotlin`). Commit `fix(#228): Kotlin extract/output-parser tier collision-scoped naming`.

---

### Task 9: Docs + CHANGELOG

**Files:** modify `CHANGELOG.md`; touch ADR-0044 Consequences (mark the extract-tier follow-up shipped) if apt.

- [ ] **Step 1:** `CHANGELOG.md` `## [Unreleased]` — coordinated cross-port bug fix (all 5 ports): the extract/output-parser tier now uses ADR-0044 collision-scoped payload names (was bare — under a cross-package short-name collision it referenced a class the payload generator no longer emits; Python/C# additionally mis-resolved the wrong node, TS additionally clobbered the entity module). Note it's LATENT (no shipped-wrong output; the collision fixture was html-only), byte-identical for non-colliding models, gated by the new json fixture. TS = Option A (entity tier). `ERR_PAYLOAD_NAME_COLLISION` reused.
- [ ] **Step 2:** In ADR-0044 Consequences, note the extract/output-parser sibling-generator recurrence (line ~51) is now addressed by #228.
- [ ] **Step 3:** Commit `docs(#228): CHANGELOG + ADR-0044 note for the extract-tier collision-naming fix`.

---

## Self-Review

**Spec coverage:** fixture → Task 1; TS Option A (naming module → entity tier → extract tier) → Tasks 2-4; Python → 5; C# → 6; Java → 7; Kotlin → 8; docs → 9. Each port task carries its own collision test vs the shared fixture (per-port hardcoded path — no auto-discovery). Byte-identical-when-non-colliding pinned per port. Wrong-node resolution (Python/C#) fixed via each port's canonical resolver.

**Domain correctness:** the TS entity tier uses the run/target emitted-object domain (Task 3), the extract tier consumes THAT map (Task 4) — not payload-codegen's per-payload-closure domain. The 4 non-TS ports reuse their own payload name-map (their strict artifact IS the payload record/flavored class).

**Ordering:** Task 1 (fixture) first so every port test can reference it. Task 2 (shared module) before 3-4. Ports 5-8 independent. Task 9 last.
