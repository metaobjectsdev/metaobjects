# `template.output` Render-Helper Codegen — Phase 2 (C# / Python / Kotlin) + cross-port `@objectRef` alignment

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Each port's generator is gated by a compile-and-run proof (the helper renders correctly) + a build-time-drift-gate proof (a mustache `{{field}}` not on the VO FAILS codegen). Phase 1 (TS+Java) is shipped; this brings C#/Python/Kotlin to parity + makes `@objectRef` resolution consistent across all 5 so a *packaged* nested email works everywhere.

**Goal:** Ship the `template.output` render helper in C#, Python, and Kotlin (matching the shipped TS+Java behavior), and align the Java render-helper's `@objectRef` resolution to the cross-port bare-short-name consensus so the shared fixture's nested/email case is byte-identical across all 5 ports.

**Architecture:** Reuse each port's existing native `render()`/`verify()` engine + filesystem provider (codegen-only). Per port: add `@kind`/email part-refs to the loader (C#/Python; Kotlin inherits JVM), an `EmailDocument` type (C#/Python; Kotlin reuses JVM), and a render-helper generator emitting `render<Name>(payload, provider)` (document→string, email→EmailDocument) with a build-time drift gate (resolve each in-repo `.mustache` via the filesystem provider + run `verify()`; fail codegen on a non-VO `{{field}}`). All field-tree `@objectRef` resolution uses bare short-name (the existing cross-port codegen convention).

**Tech Stack:** C# (Roslyn-tested), Python (materialize+import), Kotlin (kotlin-compile-testing, emits Kotlin calling the JVM render lib). Spec: `docs/superpowers/specs/2026-06-01-template-output-render-helper-design.md`. Phase-1 references: TS `codegen-ts/src/{templates/render-helper.ts,generators/render-helper-file.ts}`, Java `codegen-spring/.../SpringRenderHelperGenerator.java`.

---

## Worktree & conventions

Worktree `worktree-render-helper-phase2` at `<repo-root>/.claude/worktrees/render-helper-phase2`, off origin/main. Absolute paths; confirm branch before commit; `mvn install` changed JVM modules before dependents; single branch, single merge. mustache is pre-installed in the worktree node_modules (for TS tests). Don't commit `bunfig.toml`/`node_modules`.

## Shared facts (from recon)

- **C# engine:** `MetaObjects.Render/{Renderer.cs (Render(RenderRequest)), Verify.cs (Check(text, IReadOnlyList<PayloadField>, VerifyOptions?)), Provider.cs (IProvider.Resolve), FilesystemProvider.cs (ctor(root, ext=".mustache"))}`. `PayloadField` record (Name + Fields?), `ERR_VAR_NOT_ON_PAYLOAD`. `EmailDocument` MISSING. `@kind`/email attrs MISSING in `MetaObjects/Template/TemplateConstants.cs`. Closest generator: `MetaObjects.Codegen/Generators/OutputPromptGenerator.cs` (`IGenerator`/`GenContext`). C# codegen has NO field-tree builder — add one (bare-name walk). Test harness: Roslyn in-memory compile (`MetaObjects.Codegen.Tests/DbContextCompileTests.cs` pattern; the existing render-helper analog in TS/Java).
- **Python engine:** `render/renderer.py (render(RenderRequest))`, `render/verify.py (check(...), PayloadField, Provider Protocol, error codes)`. `FilesystemProvider` MISSING (add it, mirror C#/Java). `EmailDocument` MISSING (add a frozen dataclass). `@kind`/email attrs MISSING in `meta/template/template_constants.py`. Closest generator: `codegen/generators/{output_parser_generator.py, payload_vo_generator.py}` (`_resolve_object_by_short_or_fqn` bare-name walk + `mustache`/field-tree). Test: materialize package + import (existing codegen tests).
- **Kotlin:** reuses the JVM render lib (`com.metaobjects.render.{Renderer,RenderRequest,Verify,PayloadField,FilesystemProvider,EmailDocument}`) + inherits `@kind`/email attrs from the JVM loader. Closest generator: `codegen-kotlin/.../KotlinPayloadGenerator.kt` (+ `KotlinOutputPromptGenerator.kt`) extending `MultiFileDirectGeneratorBase<MetaObject>`. Test: kotlin-compile-testing (existing `KotlinOutputParserGeneratorTest`/compile-run pattern).
- **`@objectRef` resolution:** TS/C#/Python/Kotlin codegen use bare short-name (`c.name === ref`); the JVM render-helper (`SpringRenderHelperGenerator`) uses `MetaDataUtil.getObjectRef` (package-folded) — the OUTLIER. Standardize all render-helpers on bare short-name.
- **Shared fixture:** `fixtures/template-output-render-conformance/` (document `WelcomePage` + email `WelcomeEmail` + a `nested/` sub-corpus `OrderEmail` (nested+array+partial) + a `drift/` case). README is the cross-port oracle.

---

## Task 1: Align Java render-helper `@objectRef` resolution to bare short-name

**Files:**
- Modify: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringRenderHelperGenerator.java` (the field-tree builder's `@objectRef` resolution).
- Test: `GeneratedRenderHelperCompileRunTest.java` / `GeneratedRenderHelperConformanceTest.java`.

- [ ] **Step 1:** Add a failing test: a `template.output` whose payload VO is in a PACKAGE (e.g. `acme::ai::Order`) with a nested `field.object @objectRef "Customer"` (bare short name) — assert the Java render-helper generates + the nested field-tree resolves `Customer` (so the drift check sees `customer.name`). Currently `getObjectRef` package-expands `"Customer"` and may fail to find a bare-named VO. Run → FAIL.
- [ ] **Step 2:** Change the generator's `@objectRef` → VO resolution from `MetaDataUtil.getObjectRef(...)` to a bare short-name lookup (find the `object.value` child whose `getName()` equals the ref's short name), mirroring the TS `findObject(c.name === ref)` + the other ports' codegen. (Keep cycle-guard + the SUBTYPE_VALUE gate.) This aligns Java with the cross-port consensus.
- [ ] **Step 3:** Run → PASS + the full existing render-helper tests stay green (the unpackaged cases still work; the packaged nested case now works). `cd server/java && mvn -q -pl metadata,render install -DskipTests && mvn -pl codegen-spring test -Dtest='GeneratedRenderHelper*' -DfailIfNoTests=false`.
- [ ] **Step 4: Commit** (`fix(codegen-java): render-helper resolves @objectRef by bare short-name (cross-port codegen consensus)`).

---

## Task 2: C# + Python metamodel — `@kind` + email part-refs + validation

**Files:**
- C#: `server/csharp/MetaObjects/Template/TemplateConstants.cs` + the template registration/validation (mirror `@format`/`@promptStyle`).
- Python: `server/python/src/metaobjects/meta/template/template_constants.py` + the template schema/validation.
- Tests: C# `MetaObjects.Tests`/template tests; Python `tests/` template tests.

- [ ] **Step 1: Failing tests** (both ports), mirroring the TS+Java Task-1 cases: `@kind=email` + subjectRef + htmlBodyRef → loads OK; `@kind=email` missing subjectRef → load error; `@kind=document`/absent missing textRef → load error; `@kind=bogus` → closed-enum error.
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** Add `@kind` (optional, default `"document"`, closed enum `[document,email]`) + `@subjectRef`/`@htmlBodyRef`/`@textBodyRef` (optional strings) to the `template.output` declaration; relax `@textRef` to conditionally-required (document requires it, email doesn't); cross-field validation `kind=email` requires subjectRef+htmlBodyRef. Match the TS canonical contract + the Java port (look at the shipped TS `template-schema.ts`/`validation-passes.ts` + Java `OutputTemplate.java`/`ValidationPhase.java` from phase 1 for the exact rules).
- [ ] **Step 4: Run → PASS** + full metadata/template suites (no regression).
- [ ] **Step 5: Commit** (`feat(metadata): template.output @kind + email part-refs + validation (C#+Python)`).

---

## Task 3: render-lib additions — C# `EmailDocument`; Python `EmailDocument` + `FilesystemProvider`

**Files:**
- C#: `server/csharp/MetaObjects.Render/EmailDocument.cs`.
- Python: `server/python/src/metaobjects/render/email_document.py` + `server/python/src/metaobjects/render/filesystem_provider.py` (+ exports).
- Tests: light value-type + provider tests per port.

- [ ] **Step 1-3:**
  - C#: `public sealed record EmailDocument(string Subject, string HtmlBody, string? TextBody);` in `MetaObjects.Render`.
  - Python: `@dataclass(frozen=True) class EmailDocument: subject: str; html_body: str; text_body: str | None = None` in `metaobjects/render/`. Plus `FilesystemProvider` (resolve `group/source` → `<root>/group/source.mustache`, mirroring `MetaObjects.Render/FilesystemProvider.cs` + the Java `FilesystemProvider`) implementing the `Provider` protocol; export from the render package.
  - Light tests: construct EmailDocument (incl. null/None textBody); FilesystemProvider resolves an on-disk `.mustache` + returns None for missing.
- [ ] **Step 4: Commit** (`feat(render): EmailDocument (C#+Python) + Python FilesystemProvider`).

---

## Task 4: C# render-helper generator + build-time drift gate

**Files:**
- Create: `server/csharp/MetaObjects.Codegen/Generators/RenderHelperGenerator.cs` (`IGenerator`, iterate `template.output`, build the bare-name payload field-tree, run the build-time drift gate via `FilesystemProvider` + `Verify.Check`, emit `<Name>RenderHelper.cs`).
- Test: `server/csharp/MetaObjects.Codegen.Tests/RenderHelperCodegenTests.cs` (Roslyn compile + reflection).

- [ ] **Step 1: Failing Roslyn compile-and-run + drift tests** (mirror the TS/Java cases): `document` `WelcomePage` (`@format=html`, `@textRef`, payload VO) + in-memory/temp mustache → `render(payload, provider)` returns the rendered string; `email` `WelcomeEmail` → `EmailDocument` parts; build-time drift gate → `{{missing}}` THROWS at codegen with `ERR_VAR_NOT_ON_PAYLOAD` naming template+ref+field. Run → FAIL.
- [ ] **Step 2: Implement.** Emit `public static class <Name>RenderHelper` with `public static string Render(<Payload> payload, IProvider provider)` (document) → `Renderer.Render(new RenderRequest(...ref:@textRef, payload, provider, format:@format, verify:<field-tree>, maxChars))`; `public static EmailDocument Render(<Payload>, IProvider)` (email) → the 3 part renders + `new EmailDocument(...)`. Build a `List<PayloadField>` from the payload VO (bare-name `@objectRef` recursion, cycle-guard). Drift gate: a `--templateRoot`/config arg → `new FilesystemProvider(root)`, `Verify.Check(text, fieldTree, opts)`, throw a codegen exception on a non-warning error (≠ `ERR_REQUIRED_SLOT_UNUSED`) naming template+ref+code+field (match the TS/Java message style).
- [ ] **Step 3: Run → PASS** + `dotnet test MetaObjects.Codegen.Tests/...` (no regression). Confirm engine (`MetaObjects.Render`) + render-conformance UNCHANGED.
- [ ] **Step 4: Commit** (`feat(codegen-csharp): per-template.output render helper (document+email) + build-time drift gate`).

---

## Task 5: Python render-helper generator + build-time drift gate

**Files:**
- Create: `server/python/src/metaobjects/codegen/generators/render_helper_generator.py` + factory; export.
- Test: `server/python/tests/codegen/test_render_helper_generator.py` (materialize + import).

- [ ] **Step 1: Failing materialize-import + drift tests** (mirror): document → `render_<snake>(payload, provider) -> str`; email → `render_<snake>(...) -> EmailDocument`; drift `{{missing}}` → the generator RAISES at codegen with `ERR_VAR_NOT_ON_PAYLOAD` + field/ref/template. Run → FAIL.
- [ ] **Step 2: Implement.** `RenderHelperGenerator` (mirror `output_parser_generator`/`payload_vo_generator`): emit `render_<snake>(payload, provider)` delegating to the existing `render(RenderRequest(ref=@textRef, payload=payload, provider=provider, format=@format, verify=<field-tree>, max_chars=...))` (document) / building `EmailDocument(subject=..., html_body=..., text_body=...)` (email). Field-tree via the existing bare-name VO walk. Drift gate: a templateRoot config → `FilesystemProvider` + `verify.check(...)`, raise on a non-warning error naming template+ref+code+field.
- [ ] **Step 3: Run → PASS** + `pytest tests/codegen` + ruff clean. Engine (`render/`) + render-conformance UNCHANGED.
- [ ] **Step 4: Commit** (`feat(codegen-python): per-template.output render helper (document+email) + build-time drift gate`).

---

## Task 6: Kotlin render-helper generator + build-time drift gate

**Files:**
- Create: `server/java/codegen-kotlin/src/main/kotlin/com/metaobjects/generator/kotlin/KotlinRenderHelperGenerator.kt` (`MultiFileDirectGeneratorBase<MetaObject>`, emits an `object <Name>RenderHelper` calling the JVM `Renderer`/`EmailDocument`; drift gate via JVM `FilesystemProvider` + `Verify.check`).
- Test: `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/KotlinRenderHelperCompilesTest.kt` (kotlin-compile-testing).

- [ ] **Step 1: Failing kotlin-compile-testing + drift tests** (mirror): document → `fun render(payload, provider): String`; email → `fun render(payload, provider): EmailDocument`; drift → the generator throws at codegen with `ERR_VAR_NOT_ON_PAYLOAD`. Run → FAIL.
- [ ] **Step 2: Implement.** `KotlinRenderHelperGenerator` (mirror `KotlinPayloadGenerator`): emit `object <Name>RenderHelper { fun render(payload: <Payload>, provider: Provider): String = Renderer().render(RenderRequest(null, "<@textRef>", payload, provider, "<@format>", <fieldTree>, <maxChars>)) }` (document) / `EmailDocument(...)` (email), referencing the JVM render types by FQN. Field-tree via a bare-name walk (mirror Task 1's aligned Java logic). Drift gate: `--templateRoot` → JVM `FilesystemProvider` + `Verify.check`, throw `GeneratorException` on a non-warning error.
- [ ] **Step 3: Run → PASS** + `mvn -q -pl codegen-kotlin test -DfailIfNoTests=false` (no regression).
- [ ] **Step 4: Commit** (`feat(codegen-kotlin): per-template.output render helper (document+email) + build-time drift gate`).

---

## Task 7: Shared-fixture consolidation (all 5 identical) + closeout

**Files:**
- `fixtures/template-output-render-conformance/` — now that `@objectRef` resolution is consistent (bare-name everywhere incl. Java), MOVE the `nested/` `OrderEmail` (nested+array+partial) into the MAIN corpus (packaged is fine — bare-name resolves it everywhere), so ALL 5 ports run the same document + email + nested-email + drift cases. Update the README oracle.
- Wire C#/Python/Kotlin render-helper tests to also load the shared corpus (like TS/Java do) and assert IDENTICAL output.

- [ ] **Step 1:** Consolidate the fixture; ensure all 5 ports' render-helper conformance tests load it and assert byte-identical document/email/nested-email output + the drift failure. If any port diverges, that's a real bug — fix/report.
- [ ] **Step 2: Run all 5 ports' render-helper + render + metadata suites:** TS `bun test packages/{metadata,render,codegen-ts}`; Java `mvn -pl metadata,render,codegen-spring,codegen-kotlin test`; C# `dotnet test` (Codegen+Render+Tests); Python `pytest tests/codegen tests/render`. All render-helper tests green + identical output; engine + render-conformance unchanged. (Note any PRE-EXISTING unrelated failures — e.g. the FR-016 source-rdb conformance ones — separately; they're not this work.)
- [ ] **Step 3: Final whole-branch review.** Reviewer over `git diff $(git merge-base origin/main HEAD)..HEAD`: (a) all 5 ports emit the render helper (document→string, email→EmailDocument) reusing `render()`; (b) the build-time drift gate FAILS codegen on a non-VO `{{field}}` in every port (proven); (c) `@objectRef` bare-name resolution consistent across all 5; (d) engine + render-conformance UNCHANGED; (e) the shared fixture produces identical output cross-port; (f) hygiene. Fix findings.
- [ ] **Step 4: Docs + memory + merge.** Update the roadmap entry (phase 2 shipped → render helper in ALL 5 ports). Memory note. Forward-merge onto current origin/main (fetch; merge if advanced; re-verify; FF-push). Remove worktree. Publish deferred.

---

## Notes for the executor

- **Codegen-only per new port** — reuse each port's existing `render()`/`verify()`/filesystem provider. The render ENGINE + render-conformance corpus must NOT change. If a render/verify test goes red, stop.
- **Bare short-name `@objectRef`** everywhere (the cross-port codegen consensus) — including the Java alignment (Task 1). This is what makes a packaged nested email identical across all 5.
- **Build-time drift gate is the headline per port** — codegen MUST throw on a non-VO `{{field}}`; prove it with a dedicated failing-codegen test in each port.
- **Match the shipped TS+Java behavior + the drift message style** (`render-helper drift: template "<N>" ref "<r>" — <CODE>: {{<f>}} not on payload VO`).
- **EmailDocument:** C# record / Python frozen dataclass (in the render lib); Kotlin reuses the JVM record.
- Absolute paths; `mvn install` changed JVM modules before dependents; confirm branch before commit; don't commit bunfig/node_modules.
