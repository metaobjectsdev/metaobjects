# Cross-port native SDK-docs conformance gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cross-port conformance gate that fails RED for ports without native SDK docs, then implement idiomatic, accuracy-by-construction native SDK docs for C#, Python, and Kotlin so all five ports go green.

**Architecture:** Two-layer gate. (1) A shared path/coverage/cross-link contract (`expected-paths.json`) extended to five api surfaces — the layer that goes red for a missing port. (2) Per-port accuracy-by-construction tests (symbols must match real generated identifiers). C#/Python/Kotlin each grow an `ApiModel` IR + builder (naming-seam reuse) + renderer (per-entity/README/AGENT-API) + a `docs` command, mirroring the shipped TS (`codegen-ts` api-docs) and Java (`codegen-spring` apidocs + `DocsMojo`) implementations.

**Tech Stack:** TS/Bun (oracle + contract), C# (.NET/xUnit), Python (pytest), Kotlin/JVM (Maven/JUnit). Spec: `docs/superpowers/specs/2026-06-13-cross-port-sdk-docs-conformance-design.md`.

---

## Reference implementations (read these before each port phase)

- **TS api-docs (the IR + renderer reference):**
  - `server/typescript/packages/codegen-ts/src/generators/api-model.ts` — `ApiModel`/`ApiUnitDoc`/`ApiSymbol`/`ApiSymbolKind`/`FieldShape`/`UnitExample`.
  - `server/typescript/packages/codegen-ts/src/generators/api-doc-render.ts` — `renderEntityApiPage` / `renderApiIndex` / `renderAgentApi`.
  - `server/typescript/packages/codegen-ts/test/golden/api-docs-accuracy.test.ts` — accuracy gate (forward + inverse).
  - `server/typescript/packages/codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts` — the oracle + `buildManifest()` + `UPDATE_CONTRACT`.
- **Java api-docs (the per-port-native reference + Mojo + cross-port runner):**
  - `server/java/codegen-spring/src/main/java/com/metaobjects/generator/apidocs/` — `JavaApiModel`, `ApiUnit`, `ApiSymbol`, `ApiSymbolKind`, `JavaApiModelBuilder`, `JavaApiDocsRenderer`, `DocsPaths`.
  - `server/java/maven-plugin/src/main/java/com/metaobjects/mojo/DocsMojo.java` — the `metaobjects:docs` goal.
  - `server/java/codegen-spring/src/test/java/com/metaobjects/generator/apidocs/JavaApiDocsAccuracyTest.java` and `ApiDocsCrossPortConformanceTest.java`.
- **Naming-seam pattern (accuracy by construction):** `SpringNaming` + each generator's static `appliesTo(obj)` — the builder enumerates symbols via the seam, never re-concatenating names.

---

## File Structure

**Phase 0 (the RED) — shared contract + failing runners:**
- Modify: `fixtures/conformance/api-docs-cross-port/expected-paths.json` (add 3 surfaces + per-unit paths/hrefs).
- Modify: `server/typescript/packages/codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts` (`buildManifest()` computes the 3 new surfaces' path math; assert the 3 new subdirs).
- Create: `server/csharp/MetaObjects.Codegen.Tests/ApiDocsCrossPortConformanceTests.cs` (fails red).
- Create: `server/python/tests/test_api_docs_cross_port_conformance.py` (fails red).
- Create: `server/java/integration-tests-kotlin/src/test/kotlin/.../ApiDocsCrossPortConformanceKtTest.kt` (fails red).

**Phase 1 (C#):**
- Create: `server/csharp/MetaObjects.Codegen/ApiDocs/CSharpApiModel.cs`, `CSharpApiModelBuilder.cs`, `CSharpApiDocsRenderer.cs`, `DocsPaths.cs`.
- Create: `server/csharp/MetaObjects.Cli/DocsCommand.cs`; Modify: `server/csharp/MetaObjects.Cli/Program.cs` (add `"docs"` case + usage).
- Create: `server/csharp/MetaObjects.Codegen.Tests/CSharpApiDocsAccuracyTests.cs`.

**Phase 2 (Python):**
- Create: `server/python/src/metaobjects/apidocs/__init__.py`, `api_model.py`, `builder.py`, `renderer.py`, `paths.py`.
- Modify: `server/python/src/metaobjects/cli.py` (add `docs` subparser + `_cmd_docs`).
- Create: `server/python/tests/test_api_docs_accuracy.py`.

**Phase 3 (Kotlin):**
- Create: `server/java/codegen-kotlin/src/main/kotlin/.../apidocs/KotlinApiModel.kt`, `KotlinApiModelBuilder.kt`, `KotlinApiDocsRenderer.kt`.
- Modify: `server/java/maven-plugin/.../mojo/DocsMojo.java` (add `language` param → build java and/or kotlin surface).
- Create: `server/java/codegen-kotlin/src/test/kotlin/.../KotlinApiDocsAccuracyKtTest.kt`.
- Modify (finalize cross-links): the model-docs `apiSurfaces` list (TS `docs-file.ts` defaults + Java/Kotlin Mojo) to list all five surfaces.

---

## Phase 0 — The RED gate

### Task 0.1: Extend the shared manifest interface + oracle to five surfaces

**Files:**
- Modify: `server/typescript/packages/codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts`

- [ ] **Step 1: Add the new subdir constants + manifest fields**

Near the existing `API_TS_SUBDIR` / `API_JAVA_SUBDIR` constants add:

```ts
const API_CSHARP_SUBDIR = "api/csharp";
const API_PYTHON_SUBDIR = "api/python";
const API_KOTLIN_SUBDIR = "api/kotlin";
```

Extend `interface ManifestUnit` with: `apiCsharpPath`, `apiPythonPath`, `apiKotlinPath`,
`modelToApiCsharp`, `modelToApiPython`, `modelToApiKotlin`, `apiCsharpToModel`,
`apiPythonToModel`, `apiKotlinToModel` (all `string`). Extend `interface Manifest` with
`apiCsharpSubDir`, `apiPythonSubDir`, `apiKotlinSubDir`.

- [ ] **Step 2: Compute the new surfaces in `buildManifest()`**

The new surfaces share TS's `placement` (`apiTsPath.slice(API_TS_SUBDIR.length + 1)`). For each
new surface, mirror the existing `apiJavaPath` / `modelToApiJava` / `apiJavaToModel` math
(same `posixPath` relative computation, swapping the subdir). Example for C# (repeat for python,
kotlin):

```ts
const apiCsharpPath = `${API_CSHARP_SUBDIR}/${placement}`;
const apiCsharpToModel = relModel(posixPath.dirname(apiCsharpPath), node); // same helper used for apiJavaToModel
const modelToApiCsharp = (() => {
  const fromModelDir = posixPath.dirname(modelPath);
  return posixPath.relative(fromModelDir, apiCsharpPath);
})();
```

Add the nine new fields to the returned unit object, and `apiCsharpSubDir`/`apiPythonSubDir`/
`apiKotlinSubDir` to the returned manifest. (Use `refs.csharp ?? modelToApiCsharp` etc. so the
manifest is correct before the model page renders those refs.)

- [ ] **Step 3: Regenerate the committed contract**

Run: `cd server/typescript && UPDATE_CONTRACT=1 bun test packages/codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts`
Expected: `fixtures/conformance/api-docs-cross-port/expected-paths.json` now contains the three
new subdirs and the nine new per-unit fields for all four units.

- [ ] **Step 4: Assert the new subdirs in the TS test**

Add to the existing "matches the committed contract" block:

```ts
expect(manifest.apiCsharpSubDir).toBe(API_CSHARP_SUBDIR);
expect(manifest.apiPythonSubDir).toBe(API_PYTHON_SUBDIR);
expect(manifest.apiKotlinSubDir).toBe(API_KOTLIN_SUBDIR);
```

- [ ] **Step 5: Run the TS suite (still green — TS oracle only)**

Run: `cd server/typescript && bun test packages/codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts`
Expected: PASS (TS computes the path math; it does not emit the new pages).

- [ ] **Step 6: Commit**

```bash
git add fixtures/conformance/api-docs-cross-port/expected-paths.json server/typescript/packages/codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts
git commit -m "test(api-docs): extend cross-port contract to api/csharp,python,kotlin (oracle)"
```

### Task 0.2: C# failing cross-port runner (RED)

**Files:**
- Create: `server/csharp/MetaObjects.Codegen.Tests/ApiDocsCrossPortConformanceTests.cs`

- [ ] **Step 1: Write the failing test** — load `expected-paths.json`, build the C# api model for
the shared input, assert the documented unit set equals the manifest unit set and each unit's
`apiCsharpPath` equals `DocsPaths.DocPageOutputPath(Package, pkg, node)` under `api/csharp`, and
the rendered page carries the `**Model / metadata:** [node](apiCsharpToModel)` back-link. Mirror
`ApiDocsCrossPortConformanceTest.java` field-for-field. Reference the (not-yet-existing)
`CSharpApiModelBuilder` / `CSharpApiDocsRenderer` / `DocsPaths` so the test fails to compile/fail.

- [ ] **Step 2: Run — verify it fails red**

Run: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests --filter ApiDocsCrossPort`
Expected: FAIL (builder/renderer types do not exist). **This is the intended C# red.**

- [ ] **Step 3: Commit the red**

```bash
git add server/csharp/MetaObjects.Codegen.Tests/ApiDocsCrossPortConformanceTests.cs
git commit -m "test(csharp): failing api-docs cross-port conformance (RED, awaiting impl)"
```

### Task 0.3: Python failing cross-port runner (RED)

**Files:**
- Create: `server/python/tests/test_api_docs_cross_port_conformance.py`

- [ ] **Step 1: Write the failing test** — load the manifest, `from metaobjects.apidocs import
build_api_model, render_unit_page, doc_page_output_path` (not yet existing), assert unit-set
equality, `apiPythonPath` path math, and the model back-link literal. Mirror the Java runner.

- [ ] **Step 2: Run — verify it fails red**

Run: `cd server/python && python -m pytest tests/test_api_docs_cross_port_conformance.py -q`
Expected: FAIL (`ModuleNotFoundError: metaobjects.apidocs`). **Intended Python red.**

- [ ] **Step 3: Commit the red**

```bash
git add server/python/tests/test_api_docs_cross_port_conformance.py
git commit -m "test(python): failing api-docs cross-port conformance (RED, awaiting impl)"
```

### Task 0.4: Kotlin failing cross-port runner (RED)

**Files:**
- Create: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/codegen/kotlin/apidocs/ApiDocsCrossPortConformanceKtTest.kt`

- [ ] **Step 1: Write the failing test** — load the manifest (from the repo-root fixture), build
the Kotlin api model for the shared input via `KotlinApiModelBuilder` (not yet existing), assert
unit-set equality + `apiKotlinPath` path math + the model back-link literal. Mirror the Java
runner.

- [ ] **Step 2: Run — verify it fails red**

Run: `cd server/java && mvn -q -pl codegen-kotlin test -Dtest=ApiDocsCrossPortConformanceKtTest`
Expected: FAIL (compile error — `KotlinApiModelBuilder` absent). **Intended Kotlin red.**

- [ ] **Step 3: Commit the red**

```bash
git add server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/codegen/kotlin/apidocs/ApiDocsCrossPortConformanceKtTest.kt
git commit -m "test(kotlin): failing api-docs cross-port conformance (RED, awaiting impl)"
```

**End of Phase 0: the three new ports are RED; TS+Java green. The gap is now enforced.**

---

## Phase 1 — C# native SDK docs (→ green)

Mirror `JavaApiModel`/builder/renderer/`DocsPaths`. Each task is TDD: write the per-piece test,
run red, port the implementation from the Java reference (idiomatic C#: EF Core entity / DbSet /
minimal-API routes / validators / extractor / render / payload / prompt symbol kinds), run green,
commit.

- [ ] **Task 1.1 — `DocsPaths.cs`**: port `DocsPaths` (package/flat layout path math +
  `ModelCrossHref`). Test: path math equals the manifest's `apiCsharpPath` / `apiCsharpToModel`
  for all four units. Commit.
- [ ] **Task 1.2 — `CSharpApiModel.cs`**: the IR records (`ApiModel`/`ApiUnit`/`ApiSymbol`/
  `ApiSymbolKind`/`FieldShape`/`UnitExample`) mirroring Java's. Compile-only test. Commit.
- [ ] **Task 1.3 — `CSharpApiModelBuilder.cs`**: enumerate symbols via the **real C# generator
  naming seam** (extract a `CSharpNaming` seam from the EF/route/validator generators if one does
  not exist — behavior-preserving) and each generator's `AppliesTo` predicate. Test: builds the
  four manifest units with the expected symbol kinds. Commit.
- [ ] **Task 1.4 — `CSharpApiDocsRenderer.cs`**: `RenderUnitPage` / `RenderIndex` / `RenderAgentApi`
  mirroring `JavaApiDocsRenderer` section order + the `**Model / metadata:**` back-link. Test:
  rendered page has the header, the symbol sections, the back-link. Commit.
- [ ] **Task 1.5 — accuracy gate** `CSharpApiDocsAccuracyTests.cs`: run the REAL C# generators on
  the rich fixture; FORWARD — every `ApiSymbol.Name` appears as an emitted identifier; INVERSE —
  nothing documented that the generator suppressed (TPH model-only, routes-off entities). Commit.
- [ ] **Task 1.6 — `dotnet meta docs`**: `DocsCommand.cs` + `Program.cs` `"docs"` case + usage
  line. Test: `dotnet meta docs <input> --out <tmp>` writes `api/csharp/...` pages + README +
  AGENT-API. Commit.
- [ ] **Task 1.7 — turn the cross-port runner green**: run Task 0.2's test → PASS. Commit (no code,
  just confirm + any path-math fixups).

Run after each task: `cd server/csharp && dotnet test MetaObjects.Codegen.Tests`.

## Phase 2 — Python native SDK docs (→ green)

Same shape, idiomatic Python (Pydantic model / `ObjectManager` / FastAPI routes / validators /
extractor / render / payload / prompt). Package `server/python/src/metaobjects/apidocs/`.

- [ ] **Task 2.1 — `paths.py`**: `doc_page_output_path` + `model_cross_href`. Test vs manifest
  `apiPythonPath`/`apiPythonToModel`. Commit.
- [ ] **Task 2.2 — `api_model.py`**: dataclasses `ApiModel`/`ApiUnit`/`ApiSymbol`/`ApiSymbolKind`/
  `FieldShape`/`UnitExample`. Commit.
- [ ] **Task 2.3 — `builder.py`**: `build_api_model(loader, project)` enumerating via the real
  Python codegen naming (extract a naming seam if needed) + each generator's applies predicate.
  Test: four units, expected kinds. Commit.
- [ ] **Task 2.4 — `renderer.py`**: `render_unit_page` / `render_index` / `render_agent_api`. Test:
  sections + back-link. Commit.
- [ ] **Task 2.5 — accuracy gate** `tests/test_api_docs_accuracy.py`: forward + inverse vs real
  generated Python identifiers. Commit.
- [ ] **Task 2.6 — `metaobjects docs`**: `docs` subparser + `_cmd_docs` in `cli.py`. Test: writes
  `api/python/...` + README + AGENT-API. Commit.
- [ ] **Task 2.7 — turn Task 0.3's runner green**: PASS. Commit.

Run after each task: `cd server/python && python -m pytest -q`.

## Phase 3 — Kotlin native SDK docs (→ green)

Idiomatic Kotlin (data class / Exposed table+DAO / Spring controller / validator / extractor /
render / payload / prompt). Builder/renderer in `codegen-kotlin`; its own `api/kotlin` surface.

- [ ] **Task 3.1 — `KotlinApiModel.kt`**: IR (reuse the Java `ApiSymbolKind` set; Kotlin-specific
  data-access kind label). Commit.
- [ ] **Task 3.2 — `KotlinApiModelBuilder.kt`**: enumerate via the **`codegen-kotlin` generator
  naming** (KotlinNaming seam) + each generator's `appliesTo`. Test: four units, expected kinds.
  Commit.
- [ ] **Task 3.3 — `KotlinApiDocsRenderer.kt`**: unit/index/agent pages mirroring the Java
  renderer; reuse `DocsPaths` from `codegen-spring` (shared path math). Test: sections + back-link.
  Commit.
- [ ] **Task 3.4 — accuracy gate** `KotlinApiDocsAccuracyKtTest.kt`: forward + inverse vs real
  KotlinPoet-emitted identifiers. Commit.
- [ ] **Task 3.5 — `DocsMojo` `language` param**: build java and/or kotlin surface; emit
  `api/kotlin`. Test (maven-plugin or integration): goal writes `api/kotlin/...`. Commit.
- [ ] **Task 3.6 — turn Task 0.4's runner green**: PASS. Commit.

- [ ] **Task 3.7 — finalize model-docs five-surface cross-links**: extend the model-docs
  `apiSurfaces` defaults (TS `docs-file.ts`; Java/Kotlin Mojo) to list all five. Update the TS
  oracle's `refs.*` so `modelToApi*` come from the rendered refs (not the computed fallback);
  `UPDATE_CONTRACT=1` regen; all five cross-port runners green. Commit.

Run after each task: `cd server/java && mvn -q -pl codegen-kotlin test`.

**End state: all five ports green on both the cross-port contract and per-port accuracy.**

---

## Self-review notes

- **Spec coverage:** Phase 0 = the RED gate (decision 1); Phases 1-3 accuracy gates = decision 2;
  Kotlin own surface = §"Kotlin is its own surface"; model-docs cross-link = Task 3.7. All spec
  sections mapped.
- **Naming-seam risk:** C#/Python/Kotlin may not yet expose a naming seam like Java's
  `SpringNaming`. Extracting one (behavior-preserving, then enumerated by the builder) is called
  out in Tasks 1.3 / 2.3 / 3.2 — this is the load-bearing accuracy step; do not re-concatenate.
- **Red window:** main is red from Task 0.2 until Task 3.6. Sequence Phases 1→3 without long gaps.
