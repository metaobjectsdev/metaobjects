# `template.output` Render-Helper Codegen — Implementation Plan (Phase 1: TS + Java)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Each port's generator is gated by a compile-and-run proof (the helper renders correctly) + a build-time-drift-gate proof (a mustache referencing a non-VO field FAILS codegen). Reuses the existing `render()`/`verify()` engines unchanged.

**Goal:** Generate, per `template.output`, a typed render helper — `render<Name>(payload, provider): string` for `@kind=document`, `render<Name>(payload, provider): EmailDocument` for `@kind=email` — that wraps the existing shared `render()` engine, with the mustache↔VO drift check (existing `verify()`) enforced at BUILD time against the in-repo `.mustache` files.

**Architecture:** Add `@kind` (+ email part-refs) to the `template.output` metamodel (TS + Java loaders). A new per-port generator iterates `template.output` nodes, derives the payload field-tree (existing builder), resolves each referenced `.mustache` via the existing filesystem provider, runs `verify()` at codegen (fail-on-drift), and emits a helper that calls `render()` with the baked `@textRef`/`@format`/`@maxChars`/field-tree. The `render()`/`verify()` engines + the filesystem providers already exist in both ports.

**Tech Stack:** TS codegen (ts-poet/string emit) + Java codegen (`MultiFileDirectGeneratorBase`). Spec: `docs/superpowers/specs/2026-06-01-template-output-render-helper-design.md`. Phase 2 (C#/Python/Kotlin) is a documented follow-up.

---

## Worktree & conventions

Worktree `worktree-template-output-render` at `<repo-root>/.claude/worktrees/template-output-render`, branch `worktree-template-output-render`, off origin/main. Absolute paths; confirm branch before commit; `mvn install` changed JVM modules before dependents. Single branch, single phase-1 merge. The metamodel is declared per-port (TS canonical + Java port) — Task 1 lands it in BOTH so the loader parses `@kind` everywhere phase-1 needs it.

## Shared facts (from recon)

- **TS render+verify:** `render(o: RenderOptions): string` (`packages/render/src/render.ts`) — `{ ref?, template?, payload, provider, format?, verify?: PayloadField[], maxChars? }`. `verify(text, fields, opts): VerifyError[]` (`packages/render/src/verify.ts`) — error codes `ERR_VAR_NOT_ON_PAYLOAD`/`ERR_PARTIAL_UNRESOLVED`/`ERR_OUTPUT_TAG_MISSING`. `PayloadField = { name; fields? }`. Builder: `derivePayloadFieldTree(root, voName)` (`packages/cli/src/lib/payload-field-tree.ts`). Build-time provider: `FileSystemProvider`/`projectProvider(projectRoot)` (`codegen-ts/src/render-engine/framework-provider.ts`).
- **Java render+verify:** `Renderer.render(RenderRequest)` (`server/java/render/.../Renderer.java`); `RenderRequest(template, ref, payload, provider, format, List<PayloadField> verify, Integer maxChars)`; `Verify.check(text, List<PayloadField>, VerifyOptions): List<VerifyError>`; `PayloadField(name, fields)` with `scalar(name)`/`object(name, children)`; `Provider.resolve(ref)`; build-time provider `FilesystemProvider(Path root)` (`server/java/render/.../FilesystemProvider.java`).
- **TS template schema:** `packages/metadata/src/template/template-schema.ts` (`genericAttrs` + `TEMPLATE_ATTRS_MAP`) + `template-constants.ts`. Closed enums via `allowedValues`; conditional validation via the loader's `validation-passes.ts`.
- **Java template schema:** `server/java/metadata/.../template/OutputTemplate.java` (`registerTypes`) + `TemplateConstants.java`; conditional validation in the validation phase.
- **Closest generators to copy:** TS `outputPrompt` (`codegen-ts/src/generators/output-prompt-file.ts`) + `renderOutputPrompt` (`templates/output-prompt.ts`); Java `SpringOutputPromptGenerator` + `SpringPayloadGenerator`.
- **Test harnesses:** TS temp-dir + dynamic `import()` (`codegen-ts/test/fr010-output-codegen.test.ts`; jsdom bunfig caveat — empty bunfig to run, don't commit). Java in-memory javac + reflection (`GeneratedOutputPromptCompileRunTest`).

---

## Task 1: Metamodel — `@kind` + email part-refs + validation (TS + Java)

**Files:**
- TS: `packages/metadata/src/template/template-constants.ts` (+ `template-schema.ts`)
- TS validation: `packages/metadata/src/loader/validation-passes.ts` (or wherever template cross-field validation lives — grep `ERR_INVALID_TEMPLATE`)
- Java: `server/java/metadata/.../template/TemplateConstants.java` (+ `OutputTemplate.java`) + the validation phase
- Tests: TS `packages/metadata/test/template-*.test.ts`; Java `server/java/metadata/.../template/*Test.java`

- [ ] **Step 1: Write failing metamodel tests** (TS + Java): load a `template.output` with `@kind="email"` + `@subjectRef`/`@htmlBodyRef` → valid; `@kind="email"` WITHOUT `@subjectRef` → load error; `@kind="document"` (or absent) without `@textRef` → load error; `@kind="bogus"` → closed-enum error. (Mirror existing `@format`/`@promptStyle` closed-enum + the template validation tests.)
- [ ] **Step 2: Run → FAIL** (attrs unknown / no validation). TS `cd server/typescript && bun test packages/metadata` (empty bunfig if needed); Java `cd server/java && mvn -q -pl metadata test -Dtest=*Template* -DfailIfNoTests=false`.
- [ ] **Step 3: Implement.**
  - Constants (both): `TEMPLATE_ATTR_KIND="kind"`, `TEMPLATE_KINDS=["document","email"]`, `TEMPLATE_ATTR_SUBJECT_REF="subjectRef"`, `TEMPLATE_ATTR_HTML_BODY_REF="htmlBodyRef"`, `TEMPLATE_ATTR_TEXT_BODY_REF="textBodyRef"`.
  - TS schema: add `@kind` (optional, default `"document"`, `allowedValues: TEMPLATE_KINDS`) + `@subjectRef`/`@htmlBodyRef`/`@textBodyRef` (optional strings) to the `template.output` attr set.
  - Java: add the same optional attributes to `OutputTemplate.registerTypes()` (`optionalAttributeWithConstraints(...).ofType(StringAttribute.SUBTYPE_STRING).asSingle()`); `@kind` closed-enum constraint matching the format/promptStyle pattern.
  - Cross-field validation (both, in the validation phase): `kind=email` → require `@subjectRef` + `@htmlBodyRef` (error if missing); `kind=document`/absent → require `@textRef`. Clear error messages (template name + which ref is missing).
- [ ] **Step 4: Run → PASS** + full `bun test packages/metadata` / `mvn -pl metadata test` (no regression).
- [ ] **Step 5: Commit** (`feat(metadata): template.output @kind (document|email) + email part-refs + validation (TS+Java)`).

---

## Task 2: `EmailDocument` type (TS + Java render libraries)

**Files:**
- TS: `packages/render/src/email-document.ts` (+ export from the render barrel)
- Java: `server/java/render/src/main/java/com/metaobjects/render/EmailDocument.java`

- [ ] **Step 1: Write the (trivial) shape test** asserting the type exists + carries `subject`/`htmlBody`/`textBody?`.
- [ ] **Step 2-3: Implement.** TS: `export interface EmailDocument { subject: string; htmlBody: string; textBody?: string }`. Java: `public record EmailDocument(String subject, String htmlBody, String textBody) {}` (textBody nullable). One shared shape per port (the generator references it; it's NOT regenerated per template).
- [ ] **Step 4: Commit** (`feat(render): EmailDocument type (subject/htmlBody/textBody) — TS + Java`).

---

## Task 3: TypeScript render-helper generator + build-time drift gate

**Files:**
- Create: `packages/codegen-ts/src/templates/render-helper.ts` (`renderRenderHelper(root, templateName, provider): string` — emits the helper source; runs the build-time drift gate)
- Create: `packages/codegen-ts/src/generators/render-helper-file.ts` (the `renderHelper(opts?)` generator — `oncePerRun`, iterate `template.output`, resolve provider via `projectProvider(ctx.projectRoot)`, emit `<Name>.render.ts`)
- Modify: `packages/codegen-ts/src/generators/index.ts` (export `renderHelper`)
- Test: `packages/codegen-ts/test/render-helper-codegen.test.ts`

- [ ] **Step 1: Write the failing compile-and-run + drift tests.**
  - **Document case:** a `template.output` `WelcomePage` (`@kind=document`, `@format=html`, `@textRef="pages/welcome"`, `@payloadRef=WelcomeVO{name}`); provide an in-memory/temp `pages/welcome.mustache` = `Hello {{name}}`. Generate, `await import`, call `renderWelcomePage({name:"Ada"}, provider)` → `"Hello Ada"` (html-escaped per format). Assert the emitted signature returns `string` and bakes `verify` (the field-tree) + `format`.
  - **Email case:** `WelcomeEmail` (`@kind=email`, `@subjectRef="emails/welcome.subject"`, `@htmlBodyRef="emails/welcome.html"`, optional `@textBodyRef="emails/welcome.txt"`, `@payloadRef=WelcomeVO{name}`); templates render subject/html/text; call `renderWelcomeEmail({name:"Ada"}, provider)` → `{ subject, htmlBody, textBody? }` with correct parts; return type `EmailDocument`.
  - **Build-time drift gate:** a template whose mustache is `Hi {{missing}}` (not on the VO) → assert the GENERATOR throws at codegen with `ERR_VAR_NOT_ON_PAYLOAD` naming `missing` + the template/ref. Inverse: clean template → codegen succeeds.
  - Run → FAIL: `cd server/typescript && bun test packages/codegen-ts/test/render-helper-codegen.test.ts` (empty bunfig to run; don't commit).
- [ ] **Step 2: Implement.**
  - `render-helper.ts`: resolve the `template.output` + payload VO; `derivePayloadFieldTree(root, payloadRef)` for the field-tree; for EACH referenced `.mustache` (`document`: `@textRef`; `email`: the 3 part-refs) resolve via the passed provider + run `verify(text, fieldTree, { provider })` — if any non-warning error, THROW a `GeneratorError` (codegen fails) with code + field + template. Emit:
    - document → `export function render<Name>(payload, provider): string { return render({ ref:"<textRef>", payload, format:<format>, provider, verify:<fieldTreeLiteral>, maxChars:<n?> }); }`
    - email → `export function render<Name>(payload, provider): EmailDocument { return { subject: render({ref:"<subjectRef>",payload,format:"text",provider,verify:<ft>}), htmlBody: render({ref:"<htmlBodyRef>",payload,format:"html",provider,verify:<ft>}), textBody: <textBodyRef? render(...) : undefined> }; }`
    - import `render` from `@metaobjectsdev/render`, `EmailDocument` from the render barrel, the payload type from the payload module.
  - `render-helper-file.ts`: `oncePerRun`; build the codegen-time provider via `projectProvider(ctx.projectRoot)` (so the drift gate reads the project's `templates/`); emit one `<Name>.render.ts` per `template.output`. Export from the barrel.
- [ ] **Step 3: Run → PASS** + `bun test packages/codegen-ts` (no regression; restore bunfig).
- [ ] **Step 4: Commit** (`feat(codegen-ts): per-template.output render helper (document+email) + build-time mustache-VO drift gate`).

---

## Task 4: Java render-helper generator + build-time drift gate

**Files:**
- Create: `server/java/codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringRenderHelperGenerator.java` (`MultiFileDirectGeneratorBase<MetaObject>`, emits `<Name>RenderHelper.java`; runs the build-time drift gate via `FilesystemProvider` + `Verify.check`)
- Maybe create: a small `PayloadField`-tree builder from a payload VO (Java) if one isn't already extractable — mirror `derivePayloadFieldTree` (walk `vo.getMetaFields()`, recurse `field.object` `@objectRef`, cycle-guard). Put it where the generator can reuse it.
- Test: `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/GeneratedRenderHelperCompileRunTest.java`

- [ ] **Step 1: Write the failing in-memory-javac + drift tests** (mirror `GeneratedOutputPromptCompileRunTest`): same document + email + drift cases as TS. Document → compile `<Name>RenderHelper`, invoke `render(payload, provider)` → the rendered string; email → `EmailDocument` parts; drift case → the GENERATOR throws at execute() with the verify error (assert the exception names the field + ref). Run → FAIL: `cd server/java && mvn -q -pl metadata,render install -DskipTests && mvn -pl codegen-spring test -Dtest=GeneratedRenderHelperCompileRunTest -DfailIfNoTests=false`.
- [ ] **Step 2: Implement.** `SpringRenderHelperGenerator.execute`: iterate `template.output` nodes (stable order, like `SpringOutputPromptGenerator`); resolve `@payloadRef` VO; build the `List<PayloadField>` tree; take a `--templateRoot` arg → `new FilesystemProvider(Paths.get(templateRoot))`; for each referenced `.mustache` run `Verify.check(provider.resolve(ref), fieldTree, opts)` → if any error, throw `GeneratorException` (codegen fails) naming code+field+ref; emit `public final class <Name>RenderHelper { public static String render(<Payload> payload, Provider provider) { return new Renderer().render(new RenderRequest(null, "<textRef>", payload, provider, "<format>", <fieldTree>, <maxChars>)); } }` (document) or the `EmailDocument render(...)` (email, 3 parts). Reference the payload record + `EmailDocument` + `Renderer`/`RenderRequest`/`Provider` by FQN.
- [ ] **Step 3: Run → PASS** + `mvn -q -pl codegen-spring test -DfailIfNoTests=false` (no regression).
- [ ] **Step 4: Commit** (`feat(codegen-java): per-template.output render helper (document+email) + build-time mustache-VO drift gate`).

---

## Task 5: Shared conformance fixture + cross-port (TS+Java) consistency + closeout

**Files:**
- Create: `fixtures/template-output-render-conformance/` — `meta.json` (a `document` template + an `email` template + their payload VOs) + the `.mustache` files (clean) + a `drift/` case (mustache referencing a non-VO field) + a README describing the expected helper output + the expected build-time drift failure.
- Wire both ports' render-helper tests to the shared fixture.

- [ ] **Step 1: Build the shared fixture** (document + email + drift cases). Both TS + Java generator tests load it: assert identical rendered output (document string + email parts) and identical build-time drift failure (same error code + field). This pins behavior for phase-2 ports.
- [ ] **Step 2: Run all phase-1 suites:** TS `bun test packages/metadata packages/render packages/codegen-ts`; Java `mvn -pl metadata,render,codegen-base,codegen-spring test`. All green. Confirm the existing render-conformance + verify tests are UNCHANGED (engine reused).
- [ ] **Step 3: Final whole-branch review.** Reviewer over `git diff origin/main..HEAD`: (a) `@kind`/part-refs + validation correct in both ports; (b) the generated helper reuses `render()` (no re-implemented rendering) + bakes textRef/format/maxChars/field-tree; (c) the build-time drift gate genuinely FAILS codegen on a non-VO `{{field}}` (proven by the drift test) and reuses `verify()` unchanged; (d) email → `EmailDocument` correct; (e) engine + render-conformance UNCHANGED; (f) hygiene. Fix findings.
- [ ] **Step 4: Docs + memory + merge.** Roadmap entry (template.output render-helper + email + build-time drift gate, TS+Java; C#/Python/Kotlin phase 2). Memory note. Forward-merge onto current origin/main (fetch; merge if advanced; re-verify; FF-push). Remove worktree (or keep for phase 2). Publish deferred.

---

## Notes for the executor

- **Reuse `render()` + `verify()` + the filesystem provider + the payload-field-tree builder** — do NOT re-implement Mustache rendering or drift parsing. The generator is assembly: derive field-tree → drift-check the mustache at build → emit a call to `render()`.
- **Build-time drift gate is the headline:** codegen MUST fail (throw) when a referenced mustache `{{field}}` isn't on the payload VO. Prove it with a dedicated failing-codegen test in each port.
- **`@kind=email` → `EmailDocument`** (subject/htmlBody/textBody?); `@kind=document` → `string`. The lenient/strict tiers are unrelated here (this is output rendering, not LLM extraction).
- **Engine + render-conformance corpus UNCHANGED.** If a render/verify test goes red, you changed the engine by mistake — stop.
- **Templates stay provider-resolved** (not embedded): the generated helper takes a `provider`; only the build-time DRIFT CHECK reads the files at codegen.
- Phase 1 = TS + Java only. C#/Python/Kotlin are a documented phase-2 follow-up (the metamodel + generator + EmailDocument per port, against the shared fixture).
- Absolute worktree paths; `mvn install` changed JVM modules before dependents; don't commit a temporary `bunfig.toml` change.
