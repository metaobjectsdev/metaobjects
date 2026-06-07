# Java api-docs SP-2c — cross-port one-tree conformance — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Prove a TS+Java solution produces ONE cross-linked doc tree — TS emits the model + `api/ts`, Java emits `api/java`, and every cross-surface link resolves — via a shared expectation manifest both ports assert against (the registry-conformance idiom).

**Architecture:** A shared cross-port fixture (`fixtures/conformance/api-docs-cross-port/`) holds `input/meta.json` (a small multi-entity model in one package, to exercise package-layout folding) + a custom `expected-paths.json` (the contract: per unit, the model / api-ts / api-java page paths + the model↔api cross-link hrefs, in package layout). A TS conformance test asserts its real model + `api/ts` emit + the declared `api/java` link targets match the manifest; a Java conformance test asserts its real `api/java` emit + model cross-links match the same manifest. Both asserting the ONE manifest ⟹ the surfaces cohere into one resolvable tree. No cross-toolchain process needed (the byte-parity `DocsPaths`/`docs-paths` contract, gated in SP-2b, makes the manifest the single source of truth).

**Tech Stack:** TS (bun test, codegen-ts) + Java (JUnit, codegen-spring), sharing a JSON fixture.

Reference (read once): the registry-conformance idiom — `fixtures/generator-registry-conformance/registry.json` + `codegen-ts/test/golden/generator-registry-conformance.test.ts` + `codegen-spring/.../GeneratorRegistryConformanceTest.java` (shared JSON, per-port assert, repo-root walk). TS docs cross-link gate `codegen-ts/test/golden/docs-cross-link-conformance.test.ts` (`emitMulti`/`findBrokenCrossLinks`, `apiSurfaceHref`). TS `src/docs-paths.ts`. Java `codegen-spring/.../generator/apidocs/{DocsPaths,JavaApiModelBuilder,JavaApiDocsRenderer}.java` + `maven-plugin/.../mojo/DocsMojo.java`. Java fixture-load pattern: `codegen-spring/.../apidocs/JavaApiDocsAccuracyTest.java` / `TemplateOutputFixtureConformanceTest.java` (repo-root walk → `fixtures/conformance/<case>/input/meta.json`). Corpus safety (scout-confirmed): a custom `expected-paths.json` (NOT `expected.json`/`expected/`) is ignored by the C#/TS metadata-conformance harnesses, so this fixture is safe in the shared corpus.

Commands: TS `cd server/typescript && bun test <path>`; Java `cd server/java && mvn -pl codegen-spring -am test` (`-am` REQUIRED; `-DfailIfNoTests=false` with `-Dtest=`).

**Registry manifest:** DO NOT add `java` to the `api-docs` entry in `registry.json` — Java's api-docs is the `metaobjects:docs` GOAL, not a `GeneratorRegistry` generator; adding `java` would break the Java `GeneratorRegistryConformanceTest`. Leave it `ports:["typescript"]`.

---

## Task 1: Shared cross-port fixture + `expected-paths.json` manifest

**Files:** create `fixtures/conformance/api-docs-cross-port/input/meta.json` and `fixtures/conformance/api-docs-cross-port/expected-paths.json`.

- [ ] **Step 1: Author `input/meta.json`.** A minimal model in package `acme::shop` (read an existing cross-port fixture e.g. `fixtures/conformance/template-output-json-simple/input/meta.json` for the exact JSON encoding): entities `Order` (pk `id`, `@required name`, `field.enum status`, `source.rdb` table) and `Customer` (pk `id`, `name`, table); a `template.output` json `OrderSummary` with `@payloadRef` → an `object.value` payload VO. Keep it minimal but with a package (so package-layout folding `acme/shop/...` is exercised). Confirm it loads (both ports load the same format).
- [ ] **Step 2: Author `expected-paths.json`** — the cross-port contract, PACKAGE layout. Compute each value from the shared path math (`docPageOutputPath`: package → `<pkg-folded>/<Name>.md`; `apiSurfaceHref(modelPath, {subDir}, page)` for model→api; `surfaceCrossHref(apiPath, modelPath)` for api→model). Structure:
```json
{
  "$comment": "Cross-port api-docs layout contract. Both the TS and Java api-docs conformance tests assert their emitted page paths + cross-link hrefs against this. Layout: package.",
  "layout": "package",
  "apiTsSubDir": "api/ts",
  "apiJavaSubDir": "api/java",
  "units": [
    {
      "node": "Order",
      "modelPath": "acme/shop/Order.md",
      "apiTsPath": "api/ts/acme/shop/Order.md",
      "apiJavaPath": "api/java/acme/shop/Order.md",
      "modelToApiTs": "../../api/ts/acme/shop/Order.md",
      "modelToApiJava": "../../api/java/acme/shop/Order.md",
      "apiTsToModel": "../../../../acme/shop/Order.md",
      "apiJavaToModel": "../../../../acme/shop/Order.md"
    }
    // … Customer, OrderSummary (template → only apiTs/apiJava if the surface documents templates; model page is the template's neutral doc page)
  ]
}
```
  IMPORTANT: verify each href against the math — e.g. `apiJavaToModel` from `api/java/acme/shop/Order.md` (fromDir `api/java/acme/shop`, 4 segments) to `acme/shop/Order.md` is `../../../../acme/shop/Order.md` (4 `..`, matching the SP-2b node-parity correction). For the template unit `OrderSummary`, include only the surfaces actually produced (the api surfaces document templates per the IR; the model page is `acme/shop/OrderSummary.md`). Get the unit set right by checking which units each port documents (entities: model+api; template: model page + api template page).
- [ ] **Step 3: Commit.** `git add fixtures/conformance/api-docs-cross-port && git commit -m "test(conformance): cross-port api-docs layout contract fixture (input + expected-paths)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 2: TS conformance — model + api/ts emit matches the manifest

**Files:** `codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts` (create).

- [ ] **Step 1: Write the test.** Walk to repo root (mirror `generator-registry-conformance.test.ts`'s `findRepoRoot`); load `fixtures/conformance/api-docs-cross-port/input/meta.json` (via `MetaDataLoader`, as `docs-cross-link-conformance.test.ts` loads fixtures) and `expected-paths.json`. Emit the model + `api/ts` surface for PACKAGE layout, declaring both api surfaces so the model page links each (reuse `emitMulti`-style emission: `docsFile({apiSurfaces:[{label:"TypeScript",subDir:"api/ts"},{label:"Java",subDir:"api/java"}]})` + `apiDocsFile({subDir:"api/ts", modelSurface:true})`). Then assert, per manifest unit:
  - the emitted model page exists at `unit.modelPath`;
  - the emitted api/ts page exists at `unit.apiTsPath`;
  - the model page's link to api/ts == `unit.modelToApiTs` and to api/java == `unit.modelToApiJava` (parse the `[..](href)` from the emitted model page; compare strings);
  - the api/ts page's link back to the model == `unit.apiTsToModel`;
  - resolving `modelToApiTs` from the model page dir lands on `apiTsPath` (sanity).
  Use the existing link-parse/resolve helpers where possible.
- [ ] **Step 2: Run → it should PASS** (the TS emit follows the same `docs-paths` math the manifest encodes). If a value mismatches, FIX the manifest (Task 1) if it was hand-miscomputed, else investigate the emit. `cd server/typescript && bun test packages/codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts`.
- [ ] **Step 3: Full TS check.** `bun test packages/codegen-ts` → 0 fail.
- [ ] **Step 4: Commit.** `git add -A server/typescript && git commit -m "test(codegen-ts): cross-port api-docs conformance — TS model+api/ts matches the shared contract" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 3: Java conformance — api/java emit matches the same manifest

**Files:** `codegen-spring/src/test/java/com/metaobjects/generator/apidocs/ApiDocsCrossPortConformanceTest.java` (create).

- [ ] **Step 1: Write the test.** Walk to repo root (mirror `JavaApiDocsAccuracyTest`/`TemplateOutputFixtureConformanceTest`); load the SAME `fixtures/conformance/api-docs-cross-port/input/meta.json` + parse `expected-paths.json` (Jackson, as `GeneratorRegistryConformanceTest` does). Build `JavaApiModel m = new JavaApiModelBuilder().build(loader, "api-docs-cross-port")`. For PACKAGE layout, for each manifest unit that the Java builder documents:
  - compute the api/java page path the same way `DocsMojo` does: `"api/java" + "/" + DocsPaths.docPageOutputPath(Layout.PACKAGE, unit.pkg(), unit.node())`; assert it equals `unit.apiJavaPath`;
  - compute the model cross-link the same way `DocsMojo` does: `DocsPaths.modelCrossHref(apiJavaPath, DocsPaths.docPageOutputPath(Layout.PACKAGE, unit.pkg(), unit.node()), null)`; assert it equals `unit.apiJavaToModel`;
  - render the api/java page via `JavaApiDocsRenderer.renderUnitPage(unit, apiJavaToModel)` and assert it contains the `**Model / metadata:** [..](<apiJavaToModel>)` link (the page actually carries the contract href).
  (Java documents entities + template api pages; assert over the units it produces — match the manifest's unit set; if Java omits a unit the manifest lists (e.g. a template api surface the Java builder doesn't emit), reconcile the manifest to what BOTH ports actually document, and note it.)
- [ ] **Step 2: Run → PASS.** `cd server/java && mvn -pl codegen-spring -am test -Dtest=ApiDocsCrossPortConformanceTest -DfailIfNoTests=false`. If a path/href mismatches the manifest: it's a real cross-port divergence (or a manifest typo) — reconcile (fix the port or the manifest), do not weaken the test.
- [ ] **Step 3: Full Java check.** `mvn -pl codegen-spring -am test` → 0 fail.
- [ ] **Step 4: Commit.** `git add -A server/java && git commit -m "test(codegen-spring): cross-port api-docs conformance — Java api/java matches the shared contract" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 4: ADR-0027 closeout note + SP-2 wrap + closeout

**Files:** `spec/decisions/ADR-0027-polyglot-docs-composition.md` (append a short SP-2 status note).

- [ ] **Step 1: ADR note.** Append a brief "Java api surface (SP-2) shipped" paragraph to ADR-0027: the Java `metaobjects:docs` goal emits `api/java` into the `apiSurfaces` contract; the cross-port layout is gated by `fixtures/conformance/api-docs-cross-port/expected-paths.json` (both ports assert). Note the registry manifest stays TS-only (Java api-docs is a goal); examples/setup-preamble/EXTRACTOR doc are the remaining hardening follow-on.
- [ ] **Step 2: Full suites.** `cd server/typescript && bun test packages/codegen-ts` (0 fail); `cd server/java && mvn -pl codegen-spring,maven-plugin -am test` (0 fail). Record counts.
- [ ] **Step 3: Whole-branch review + code-simplifier; fix findings.** (Focus: the manifest values are correct per the math; both ports genuinely assert the SAME file; no weakened assertions; corpus-safety of the custom expectation file.)
- [ ] **Step 4: Forward-merge** to origin/main via a temp worktree off latest origin/main (main checkout has other sessions' WIP). Remove worktrees/branches. Update memory: SP-2 (Java api-docs) COMPLETE (a/b/c) — Java emits `api/java` into the apiSurfaces contract, cross-port layout gated; remaining = the SP-2b-hardening (examples/setup/EXTRACTOR) + publishing for a real adopter run.

## Guard
- PUBLIC repo: no private/other-project names, no home paths (fixture, tests, ADR, commit messages). Generic `acme.shop`/`Order`.
- The manifest `expected-paths.json` is the SINGLE shared contract — both the TS and Java tests assert against the SAME file (reconcile, don't fork). Hrefs computed via the byte-parity path math (verify the 4-`..` package cases).
- Custom expectation filename (`expected-paths.json`) so the metadata-conformance harnesses ignore the fixture (corpus-safe). Do NOT add `expected.json`/`expected/` to this fixture.
- Do NOT add `java` to the `api-docs` registry manifest (goal, not a registry generator).
- No new rendering/goal features here; SP-2c is conformance only. Don't touch verify.ts, the generators, or the TS docs door beyond the new test.
