# Java api-docs SP-2b — rendering + the `metaobjects:docs` goal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Render the `JavaApiModel` IR (SP-2a) into Java-idiomatic api-doc markdown (per-unit pages + index + AGENT-API) and emit it via a Maven `metaobjects:docs` goal into a configurable subdir, cross-linked to a model-docs root — byte-compatible with SP-1's `apiSurfaces` layout contract.

**Architecture:** Reuse the production JVM `Renderer` (metaobjects-render Mustache) with Java api template resources (own copies — ` ```java ` fences, repository/Spring framing; mirror the TS template STRUCTURE). Reimplement the TS `docs-paths` math in a Java `DocsPaths` util, parity-gated byte-identical. A `DocsMojo` (extends `AbstractMetaDataMojo`) loads metadata, builds the IR, renders, and writes `<outDir>/<subDir>/...` with model cross-links; layout/subDir/model-link-base are Maven plugin parameters (each port configures its own docs; they agree per ADR-0027).

**Tech Stack:** Java 17, JUnit, Maven; modules `server/java/codegen-spring` (IR/renderer/DocsPaths) + `server/java/maven-plugin` (the goal).

Reference (read once): SP-2 design `docs/superpowers/specs/2026-06-06-java-api-docs-design.md`; SP-2a IR in `codegen-spring/.../generator/apidocs/` (`JavaApiModel/ApiUnit/ApiSymbol/FieldShape/UnitExample/ApiSymbolKind`, `JavaApiModelBuilder`); the JVM render engine `server/java/render/.../render/{Renderer,RenderRequest,Provider}.java` (`new Renderer().render(RenderRequest.of(ref, payloadMap, provider))`, provider resolves a ref→template text); TS renderers `server/typescript/packages/codegen-ts/src/generators/api-doc-render.ts` + `templates/api/{entity-api,index,agent-api}.md.mustache` (the STRUCTURE to mirror); TS path math `src/docs-paths.ts` + parity cases in `test/docs-paths-cross.test.ts`; `maven-plugin/.../mojo/{AgentDocsMojo,AbstractMetaDataMojo,MetaDataGeneratorMojo}.java` + `MetaDataGeneratorMojoTest.java` (MojoRule pattern) + `maven-plugin/pom.xml`.

All commands from `server/java`: `mvn -pl codegen-spring -am test` and `mvn -pl maven-plugin -am test` (`-am` REQUIRED; `-DfailIfNoTests=false` with `-Dtest=` filters).

**Scope note:** SP-2b renders signatures + imports + field tables + cross-links + index + AGENT-API (the full symbol surface). Runnable EXAMPLES + the SETUP preamble + an agent-usability gate are a deliberate **SP-2b-hardening follow-on** (the TS api-docs evolved the same way: signatures first, then a hardening round). The IR gains the `example` slot now but it is left empty; rendering handles absent examples gracefully (as the TS renderer does).

---

## Task 1: IR additions — `returns` on `ApiSymbol`, `example` on `ApiUnit`

**Files:** `codegen-spring/.../generator/apidocs/ApiSymbol.java`, `ApiUnit.java`, `JavaApiModelBuilder.java`; test `JavaApiModelBuilderTest.java` (extend).

- [ ] **Step 1: Failing test.** In `JavaApiModelBuilderTest`, assert a data-access/render symbol now carries a `returns` description and the unit exposes an `example` accessor:
```java
ApiSymbol render = symbol(tmpl, ApiSymbolKind.RENDER);
assertEquals("String", render.returns());      // render helper returns String
ApiUnit author = unit(m, "Author");
assertNull(author.example());                  // example slot present, empty for now
```
- [ ] **Step 2: Run → FAIL** (`returns()`/`example()` don't exist).
- [ ] **Step 3: Implement.** Add `String returns` to the `ApiSymbol` record (after `usage`, before `throwsNote` — update all `new ApiSymbol(...)` call sites in `JavaApiModelBuilder` to pass it; for kinds without a meaningful return use `null` or `""`). Add `UnitExample example` to the `ApiUnit` record (after `symbols`); pass `null` from the builder for now. In `JavaApiModelBuilder`, populate `returns` per category: data-access methods → their declared return (e.g. `Optional<AuthorDto>`, `List<AuthorDto>`, `boolean`), extractor → `<Class>` / `ExtractionResult<<Class>>`, render → `String` (or `EmailDocument` for email), others → `null`. Keep names from the seam unchanged.
- [ ] **Step 4: Run → PASS** the builder test + accuracy gate (`JavaApiDocsAccuracyTest`) + full `mvn -pl codegen-spring -am test` (0 fail; the accuracy gate still holds — `returns` is descriptive, not a documented symbol name).
- [ ] **Step 5: Commit.** `git add -A server/java/codegen-spring && git commit -m "feat(java-apidocs): add returns to ApiSymbol + example slot to ApiUnit" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 2: `DocsPaths` Java util (byte-parity with the TS path math)

**Files:** `codegen-spring/.../generator/apidocs/DocsPaths.java`; test `DocsPathsParityTest.java`.

- [ ] **Step 1: Failing parity test** using the EXACT cases from the TS `docs-paths-cross.test.ts`:
```java
import static org.junit.Assert.assertEquals;
// surfaceCrossHref
assertEquals("./api/Order.md",  DocsPaths.surfaceCrossHref("Order.md", "api/Order.md"));
assertEquals("../Order.md",     DocsPaths.surfaceCrossHref("api/Order.md", "Order.md"));
assertEquals("../../api/acme/sales/Order.md", DocsPaths.surfaceCrossHref("acme/sales/Order.md", "api/acme/sales/Order.md"));
assertEquals("../../../acme/sales/Order.md",  DocsPaths.surfaceCrossHref("api/acme/sales/Order.md", "acme/sales/Order.md"));
// docPageOutputPath (pkg is java-dotted, as ApiUnit stores it; folds to slashes)
assertEquals("Order.md",            DocsPaths.docPageOutputPath(DocsPaths.Layout.FLAT, "acme.shop", "Order"));
assertEquals("acme/shop/Order.md",  DocsPaths.docPageOutputPath(DocsPaths.Layout.PACKAGE, "acme.shop", "Order"));
// modelCrossHref: api page -> model page (relative) or absolute baseUrl
assertEquals("../../../acme/shop/Order.md",
    DocsPaths.modelCrossHref("api/java/acme/shop/Order.md", "acme/shop/Order.md", null));
assertEquals("https://d/model/acme/shop/Order.md",
    DocsPaths.modelCrossHref("api/java/acme/shop/Order.md", "acme/shop/Order.md", "https://d/model"));
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement `DocsPaths`** mirroring `docs-paths.ts` exactly:
```java
public final class DocsPaths {
  public enum Layout { FLAT, PACKAGE }
  private DocsPaths() {}

  /** java-dotted pkg ("acme.shop") OR metadata pkg ("acme::shop") → posix dir ("acme/shop"); empty → "". */
  public static String packageToPath(String pkg) {
    if (pkg == null || pkg.isEmpty()) return "";
    return pkg.replace("::", "/").replace(".", "/");
  }
  public static String docPageOutputPath(Layout layout, String pkg, String name) {
    String file = name + ".md";
    if (layout == Layout.FLAT) return file;
    String dir = packageToPath(pkg);
    return dir.isEmpty() ? file : dir + "/" + file;
  }
  /** Relative posix href from fromOutputPath's dir to toOutputPath (mirrors surfaceCrossHref). */
  public static String surfaceCrossHref(String fromOutputPath, String toOutputPath) {
    String fromDir = fromOutputPath.contains("/")
        ? fromOutputPath.substring(0, fromOutputPath.lastIndexOf('/')) : "";
    String rel = posixRelative(fromDir, toOutputPath);
    return rel.startsWith(".") ? rel : "./" + rel;
  }
  /** From an api page (apiPagePath, relative to docs root) to its model page; absolute when modelBaseUrl set. */
  public static String modelCrossHref(String apiPagePath, String modelPagePath, String modelBaseUrl) {
    if (modelBaseUrl != null && !modelBaseUrl.isEmpty())
      return modelBaseUrl.replaceAll("/$", "") + "/" + modelPagePath;
    return surfaceCrossHref(apiPagePath, modelPagePath);
  }
  // posixRelative(fromDir, toPath): split on "/", drop common prefix, "../" per remaining fromDir segment,
  // append remaining toPath segments; "" fromDir → toPath; equal → ".". (Replicate node:path/posix relative.)
  private static String posixRelative(String fromDir, String toPath) { /* implement per the worked examples */ }
}
```
  Implement `posixRelative` to satisfy every parity case above (common-prefix walk + `..` for remaining from-segments + remaining to-segments).
- [ ] **Step 4: Run → PASS** the parity test + full `mvn -pl codegen-spring -am test`.
- [ ] **Step 5: Commit.** `git add -A server/java/codegen-spring && git commit -m "feat(java-apidocs): DocsPaths util (byte-parity with TS docs-paths math)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 3: Java api templates + `JavaApiDocsRenderer`

**Files:** `codegen-spring/src/main/resources/templates/api/{entity-api,index,agent-api}.md.mustache`; `codegen-spring/.../generator/apidocs/{JavaApiDocsRenderer,ClasspathTemplateProvider}.java`; test `JavaApiDocsRenderTest.java`.

- [ ] **Step 1: Author Java api templates** mirroring the TS `templates/api/*.mustache` STRUCTURE (read them) but Java-idiomatic: ` ```java ` fences, the `**Model / metadata:** [{{node}}]({{modelHref}})` cross-link, section headings per kind (Model / Data access / REST / Validation / Extractor / Render / Payload / Prompt / Output parser / Filter / Trace), per-symbol `### \`{{signature}}\`` + `{{usage}}` + an ` ```java {{importFqn}} ``` ` import line + a Field/Type/Required/Notes table when `{{#hasFields}}`, and `{{#returns}}Returns: {{returns}}{{/returns}}` / `{{#throwsNote}}Throws: {{throwsNote}}{{/throwsNote}}`. Index + agent-api mirror the TS ones.
- [ ] **Step 2: Failing render test** `JavaApiDocsRenderTest`: build a `JavaApiModel` from the SP-2a fixture (`apidocs-fixture/meta.json`), render an entity page and assert it contains the expected Java-idiomatic markers:
```java
String page = renderer.renderEntityPage(authorUnit, "../../../acme/shop/Author.md");
assertTrue(page.contains("# Author API"));
assertTrue(page.contains("**Model / metadata:** [Author](../../../acme/shop/Author.md)"));
assertTrue(page.contains("AuthorRepository"));
assertTrue(page.contains("```java"));
assertTrue(page.contains("| Field | Type | Required |"));  // DTO/validation field table
String index = renderer.renderIndex(model, DocsPaths.Layout.PACKAGE);
assertTrue(index.contains("[Author]("));
String agent = renderer.renderAgentApi(model);
assertTrue(agent.contains("## Author"));
```
- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement `JavaApiDocsRenderer`.** A `ClasspathTemplateProvider implements Provider` that resolves `api/<name>` → the classpath resource `/templates/api/<name>.md.mustache` (so adopters can override by shadowing the resource). The renderer builds a view-model `Map<String,Object>` per page (group symbols by kind into ordered sections; build field rows; compute the per-unit model cross-link href via `DocsPaths`) and calls `new Renderer().render(new RenderRequest(null, "api/entity-api", vm, provider, "text", null, null))` (read `RenderRequest`'s exact ctor/`of` — use `RenderRequest.of(ref, vm, provider)` if it fits). Methods: `renderEntityPage(unit, modelHref)`, `renderTemplatePage(unit, modelHref)` (or one method keyed on `unit.kind()`), `renderIndex(model, layout)`, `renderAgentApi(model)`. Java-idiomatic content; reuse `DocsPaths` for all hrefs.
- [ ] **Step 5: Run → PASS** the render test + full `mvn -pl codegen-spring -am test`.
- [ ] **Step 6: Commit.** `git add -A server/java/codegen-spring && git commit -m "feat(java-apidocs): Java api templates + JavaApiDocsRenderer (JVM Mustache)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 4: The `metaobjects:docs` Maven goal

**Files:** `maven-plugin/pom.xml` (add `codegen-spring` dep); `maven-plugin/.../mojo/DocsMojo.java`; `maven-plugin/src/test/resources/mojo/pom-docs.xml` (test pom); test `maven-plugin/.../mojo/DocsMojoTest.java`.

- [ ] **Step 1: Add the dependency.** In `maven-plugin/pom.xml`, add `metaobjects-codegen-spring` (version `${project.version}`) — it brings the IR/builder/renderer + transitively `metaobjects-render`. Confirm the reactor builds: `mvn -pl maven-plugin -am compile`.
- [ ] **Step 2: Write the failing Mojo test** `DocsMojoTest` (mirror `MetaDataGeneratorMojoTest`'s MojoRule pattern). Create `src/test/resources/mojo/pom-docs.xml` configuring the `docs` goal with a `<loader>` pointing at a small metadata source (reuse the generator test's loader/source shape), `<outputDirectory>target/test-docs</outputDirectory>`, `<apiSubDir>api/java</apiSubDir>`. Assert after `execute()`:
```java
DocsMojo mojo = (DocsMojo) rule.lookupMojo("docs", pom);
mojo.execute();
Path base = Path.of(outDir, "api", "java");
assertTrue(Files.exists(base.resolve("<Pkg path>/<Entity>.md")));   // an entity api page
assertTrue(Files.exists(base.resolve("README.md")));                 // index
assertTrue(Files.exists(base.resolve("AGENT-API.md")));              // agent form
String page = Files.readString(base.resolve("<...>/<Entity>.md"));
assertTrue(page.contains("**Model / metadata:**"));                  // cross-link present
```
- [ ] **Step 3: Run → FAIL** (goal `docs` not found).
- [ ] **Step 4: Implement `DocsMojo`.** Mirror `AgentDocsMojo`/`MetaDataGeneratorMojo` but extend `AbstractMetaDataMojo` so it loads the `MetaDataLoader` from the `<loader>` config. `@Mojo(name="docs", requiresDependencyResolution=COMPILE_PLUS_RUNTIME, defaultPhase=GENERATE_RESOURCES)`. `@Parameter` fields: `outputDirectory` (default `${project.build.directory}/docs`), `apiSubDir` (default `"api/java"`), `layout` (default `"flat"`), `modelDocsBaseUrl` (optional, for federation). In `executeGenerators(loader, gens)` (or override the work hook): build `JavaApiModel m = new JavaApiModelBuilder().build(loader, project name)`; for each unit compute its api page path `apiSubDir + "/" + DocsPaths.docPageOutputPath(layout, unit.pkg(), unit.node())` and its model page path `DocsPaths.docPageOutputPath(layout, unit.pkg(), unit.node())`, the model cross-link href `DocsPaths.modelCrossHref(apiPagePath, modelPagePath, modelDocsBaseUrl)`; render via `JavaApiDocsRenderer`; write each page + `README.md` (index) + `AGENT-API.md` under `<outputDirectory>/<apiSubDir>/`. Use `assertNoDuplicateDocPaths`-style collision safety if convenient (the TS side throws on dup paths — at least don't silently overwrite). Log a summary line.
- [ ] **Step 5: Run → PASS** `mvn -pl maven-plugin -am test -Dtest=DocsMojoTest -DfailIfNoTests=false`, then `mvn -pl maven-plugin -am test` (0 fail).
- [ ] **Step 6: Commit.** `git add -A server/java/maven-plugin && git commit -m "feat(maven-plugin): metaobjects:docs goal emits the Java api surface into the apiSurfaces contract" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 5: Closeout

- [ ] Full `mvn -pl codegen-spring -am test` and `mvn -pl maven-plugin -am test` green; record counts.
- [ ] Whole-branch review + code-simplifier; fix findings. (Focus: DocsPaths byte-parity with TS; renderer reuses the IR + DocsPaths, no re-derived names/paths; the Mojo writes the correct tree with resolving cross-links; templates are Java-idiomatic; no generated-code/behavior change to the SP-2a generators.)
- [ ] Forward-merge to origin/main via a temp worktree off latest origin/main (main checkout has other sessions' WIP). Remove worktrees/branches. Update memory (SP-2b shipped; SP-2c — cross-port one-tree conformance + registry manifest java — remains; examples/setup/agent-usability = SP-2b-hardening follow-on).

## Guard
- PUBLIC repo: no private/other-project names, no home paths (code, templates, fixtures, pom, commit messages). Generic `acme.shop`/`Author`.
- DocsPaths MUST be byte-parity with the TS `docs-paths` math (the parity test cases are copied from the TS test — they must match exactly). Cross-links must resolve in flat AND package layouts.
- Renderer + Mojo get names/inclusion from the IR (SP-2a, drift-proof) and paths from `DocsPaths` — never re-derive a symbol name or hand-roll a relative path.
- Reuse the JVM `Renderer` (don't add a Mustache dep; don't hand-roll markdown via StringBuilder). Java api templates are own copies (Tier-1 per-port), classpath-overridable.
- Do NOT change SP-2a generator behavior, the TS side, verify.ts, or other generators. EXTRACTOR stays undocumented (SP-2a deferral). Examples/setup-preamble/agent-usability gate = SP-2b-hardening follow-on, NOT this plan.
- maven-plugin must depend on codegen-spring (currently missing).
