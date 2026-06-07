# Java api-docs SP-2a — JavaApiModel IR + accuracy gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Build a `JavaApiModel` IR that documents the full Java generated SDK surface by reusing the real generators' naming + skip logic (so documented == generated, drift-proof), with a Java accuracy conformance gate proving it.

**Architecture:** Extract each Spring/Java generator's inline name-concat + skip-guard into a shared seam (`SpringNaming` name methods + per-generator `appliesTo()` predicates), behavior-preserving (existing generator tests prove no output change). Then a `JavaApiModelBuilder` calls those same seams to enumerate symbols — names cannot drift from the generated code. An accuracy gate runs the REAL generators on a rich fixture and asserts every documented symbol appears in the generated Java (forward) + skip shapes aren't over-documented (inverse).

**Tech Stack:** Java 17, JUnit, Maven; modules `server/java/codegen-spring` (+ `codegen-base`).

Reference (read once): spec `docs/superpowers/specs/2026-06-06-java-api-docs-design.md`. Naming seams live in `codegen-spring/.../generator/spring/SpringNaming.java` (`splitFqn`, `pluralLowercase`, `firstRdbSource`), `SpringM2mSupport.java` (`resolve` → `M2mNav`, `m2mFinderName`). Generators (all under `codegen-spring/.../generator/spring/` except entity/extractor under `codegen-base/.../generator/direct/object/javacode/`): `JavaObjectCodeGenerator`, `SpringDtoGenerator`, `SpringRepositoryGenerator`, `SpringControllerGenerator`, `SpringFilterAllowlistGenerator`, `ExtractorCodeGenerator`, `SpringRenderHelperGenerator`, `SpringPayloadGenerator`, `SpringOutputPromptGenerator`, `SpringOutputParserGenerator`, `LlmTraceHelperGenerator`. `Generator.execute(MetaDataLoader)`; tests via `SpringTestFixtures.loadFixture(workspace, name, json)` + `gen.setArgs(Map.of("outputDir", dir)).execute(loader)` + `Files.readString(...)`. Run: `mvn -pl server/java/codegen-spring test -Dtest=<Test>` (from repo root; add `-am` if base module changes).

**CRITICAL principle:** every seam method is extracted **verbatim** — it must return exactly the string the generator concatenates today (read the current inline expression; move it unchanged). Behavior-preserving = existing generator unit/conformance tests stay green with zero output diff. That green is the proof the refactor is safe.

---

## Task 1: Extract the naming seam into `SpringNaming`

**Files:** `codegen-spring/src/main/java/com/metaobjects/generator/spring/SpringNaming.java`; test `codegen-spring/src/test/java/com/metaobjects/generator/spring/SpringNamingTest.java` (create).

- [ ] **Step 1: Write the failing test.** Create `SpringNamingTest.java` asserting the name methods return today's exact strings:
```java
import org.junit.Test;
import static org.junit.Assert.assertEquals;
public class SpringNamingTest {
  @Test public void names() {
    assertEquals("Author", SpringNaming.capitalize("author"));
    assertEquals("AuthorDto", SpringNaming.dtoName("Author"));
    assertEquals("AuthorRepository", SpringNaming.repositoryName("Author"));
    assertEquals("AuthorController", SpringNaming.controllerName("Author"));
    assertEquals("AuthorFilterAllowlist", SpringNaming.filterAllowlistName("Author"));
    assertEquals("AuthorExtractor", SpringNaming.extractorName("Author"));
    assertEquals("/api/authors", SpringNaming.controllerPath("Author"));
    assertEquals("prompts", SpringNaming.promptsPackage(""));
    assertEquals("acme.blog.prompts", SpringNaming.promptsPackage("acme.blog"));
  }
}
```
- [ ] **Step 2: Run → FAIL.** `mvn -pl server/java/codegen-spring test -Dtest=SpringNamingTest` (methods don't exist).
- [ ] **Step 3: Implement the seam.** Add to `SpringNaming` (read each generator's current inline expression and mirror it EXACTLY):
```java
static String capitalize(String s) {
    if (s == null || s.isEmpty()) return s;
    char c0 = s.charAt(0);
    return Character.isUpperCase(c0) ? s : Character.toUpperCase(c0) + s.substring(1);
}
static String dtoName(String shortName)            { return shortName + "Dto"; }
static String repositoryName(String shortName)     { return shortName + "Repository"; }
static String controllerName(String shortName)     { return shortName + "Controller"; }
static String filterAllowlistName(String shortName){ return shortName + "FilterAllowlist"; }
static String extractorName(String className)      { return className + "Extractor"; }
static String controllerPath(String shortName)     { return "/api/" + pluralLowercase(shortName); }
static String promptsPackage(String pkg)           { return pkg.isEmpty() ? "prompts" : pkg + ".prompts"; }
// template-helper names (read the EXACT current suffixes from each generator before writing — verify
// renderHelper/payload/prompt/parser/traceHelper suffixes against the live concat; mirror verbatim):
static String renderHelperName(String templateShort){ return capitalize(templateShort) + "RenderHelper"; }
static String payloadName(String templateShort)     { return capitalize(templateShort) + "Payload"; }
static String promptName(String templateShort)      { return capitalize(templateShort) + "Prompt"; }
static String parserName(String templateShort)      { return capitalize(templateShort) + "OutputParser"; }
static String traceHelperName(String shortName)     { return shortName + "TraceHelper"; }
```
> Before finalizing each template-helper method, OPEN the generator and confirm the exact suffix it concatenates (the scout saw both `Prompt`/`OutputPrompt` and `Parser`/`OutputParser` in different notes). The method MUST equal the generator's current output. Adjust the literal to match.
- [ ] **Step 4: Run → PASS.** Fix the test's expected strings if a verified suffix differs; the test then documents the real names.
- [ ] **Step 5: Commit.** `git add -A server/java/codegen-spring && git commit -m "refactor(java-codegen): extract generated-name seam into SpringNaming" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 2: Route the generators through the naming seam (behavior-preserving)

**Files:** each generator listed in Reference; no test changes (existing generator tests are the gate).

- [ ] **Step 1: Replace inline name-concat with seam calls.** In each generator's `execute()`/emit body, replace the local string-concat with the `SpringNaming.*` call (e.g. in `SpringDtoGenerator` replace `String recordName = shortName + "Dto";` with `String recordName = SpringNaming.dtoName(shortName);`). Do this for: dto, repository, controller (+ `controllerName`/`controllerPath`/the `allowlistName` reference), filter-allowlist, extractor, render-helper (`renderHelperName`/`payloadName`/`promptsPackage`), payload (`payloadName`/`promptsPackage`), output-prompt (`promptName`/`payloadName`/`promptsPackage`), output-parser (`parserName`/`promptsPackage`), trace-helper (`traceHelperName`). Replace each generator's private `capitalizeFirst` with `SpringNaming.capitalize` (delete the duplicated privates).
- [ ] **Step 2: Run the FULL codegen-spring + codegen-base suite → expect 0 fail, ZERO output diff.** `mvn -pl server/java/codegen-spring -am test`. Every existing generator test + conformance (e.g. `SpringDtoGeneratorTest`, `SpringRepositoryGeneratorTest`, `SpringControllerGeneratorTest`, `TemplateOutputFixtureConformanceTest`) must pass unchanged — that proves the refactor changed no generated output.
- [ ] **Step 3: Commit.** `git add -A server/java && git commit -m "refactor(java-codegen): generators emit names via SpringNaming seam (no output change)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 3: Extract per-generator `appliesTo()` skip predicates

**Files:** the entity generators (`SpringDtoGenerator`, `SpringRepositoryGenerator`, `SpringControllerGenerator`, `SpringFilterAllowlistGenerator`, `LlmTraceHelperGenerator`) and template generators (`SpringRenderHelperGenerator`, `SpringPayloadGenerator`, `SpringOutputPromptGenerator`, `SpringOutputParserGenerator`); test `SpringAppliesToTest.java` (create).

- [ ] **Step 1: Write the failing test.** Load a fixture with an entity (table), an abstract entity, a value object, and a template.output(json) + template.prompt; assert each generator's `appliesTo` matches the generator's real skip behavior:
```java
// e.g.
assertTrue(SpringRepositoryGenerator.appliesTo(authorEntity));
assertFalse(SpringRepositoryGenerator.appliesTo(abstractEntity));
assertFalse(SpringRepositoryGenerator.appliesTo(valueObject));
assertTrue(SpringPayloadGenerator.appliesTo(outputTemplate));
assertFalse(SpringPayloadGenerator.appliesTo(promptTemplateWithoutPayloadRef));
```
(Use `SpringTestFixtures.loadFixture` + `loader.getMetaObjectByName(...)` to get nodes.)
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement.** In each generator, extract the inline guard chain from `execute()` into a `public static boolean appliesTo(MetaData node)` (or `MetaObject`/`MetaData` as fits), returning the SAME condition (e.g. repository: is entity SUBTYPE_ENTITY && !abstract && has rdb source && source kind == table). Replace the inline guard in `execute()` with the `appliesTo` call (behavior-preserving). For template generators the predicate takes the template node (e.g. payload: `@payloadRef` present && resolves to `object.value`).
- [ ] **Step 4: Run → PASS** the new test AND re-run `mvn -pl server/java/codegen-spring -am test` (0 fail, no output diff — the guard extraction didn't change behavior).
- [ ] **Step 5: Commit.** `git add -A server/java && git commit -m "refactor(java-codegen): extract per-generator appliesTo() skip predicates" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 4: The `JavaApiModel` IR types

**Files:** create under `codegen-spring/src/main/java/com/metaobjects/generator/apidocs/`: `JavaApiModel.java`, `ApiUnit.java`, `ApiSymbol.java`, `FieldShape.java`, `UnitExample.java`; test `JavaApiModelTypesTest.java`.

- [ ] **Step 1: Write a minimal failing test** constructing the records (compile + accessor check):
```java
ApiSymbol s = new ApiSymbol("AuthorDto", ApiSymbolKind.DTO, "acme.blog.AuthorDto",
    "record AuthorDto(Long id, String name)", List.of(), "the wire/validation shape",
    null, null, List.of(new FieldShape("id", "Long", false, null)));
assertEquals(ApiSymbolKind.DTO, s.kind());
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the records + enum.** Mirror the TS `ApiModel`/`ApiSymbol`/`FieldShape`/`UnitExample` shapes:
```java
public enum ApiSymbolKind { MODEL, DTO, DATA_ACCESS, REST, VALIDATION, EXTRACTOR, RENDER, PAYLOAD, PROMPT, OUTPUT_PARSER, FILTER, TRACE }
public record FieldShape(String name, String type, boolean optional, String note) {}
public record UnitExample(List<String> imports, List<String> body) {}
public record ApiSymbol(String name, ApiSymbolKind kind, String importFqn, String signature,
    List<String> params, String usage, String throwsNote, UnitExample example, List<FieldShape> fields) {}
public record ApiUnit(String node, String pkg, String kind /* "entity"|"template" */, List<ApiSymbol> symbols) {}
public record JavaApiModel(String project, List<ApiUnit> units) {}
```
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(java-apidocs): JavaApiModel IR record types" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 5: `JavaApiModelBuilder` — enumerate symbols via the seams

**Files:** `…/apidocs/JavaApiModelBuilder.java`; test `JavaApiModelBuilderTest.java`.

- [ ] **Step 1: Write the failing test** over a fixture entity + template:
```java
JavaApiModel m = new JavaApiModelBuilder().build(loader, "acme-blog");
ApiUnit author = unit(m, "Author");
// entity categories present, names from the seam:
assertTrue(hasSymbol(author, ApiSymbolKind.MODEL, "Author"));
assertTrue(hasSymbol(author, ApiSymbolKind.DTO, "AuthorDto"));
assertTrue(hasSymbol(author, ApiSymbolKind.DATA_ACCESS, "AuthorRepository"));
assertTrue(hasSymbol(author, ApiSymbolKind.REST, "GET /api/authors")); // verb+path symbol
assertTrue(hasSymbol(author, ApiSymbolKind.FILTER, "AuthorFilterAllowlist"));
// value object → MODEL only:
ApiUnit vo = unit(m, "Address");
assertEquals(Set.of(ApiSymbolKind.MODEL), kinds(vo));
// template.output → extractor + render + payload + prompt + parser:
ApiUnit tmpl = unit(m, "SupportAnswerOutput");
assertTrue(hasSymbol(tmpl, ApiSymbolKind.EXTRACTOR, "SupportAnswerOutputExtractor"));
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement the builder.** For each `loader` object/template node, use each generator's `appliesTo()` to decide inclusion and `SpringNaming.*`/`SpringM2mSupport` for names; emit one `ApiSymbol` per category:
  - Entities (object node): MODEL (`getClassName`), DTO (`dtoName`), DATA_ACCESS (`repositoryName` + the 6 method signatures + one `find<Rel>` per `SpringM2mSupport.resolve`), REST (one symbol per verb+path via `controllerPath`, only when controller `appliesTo`; `{id}/<rel>` per M:N), VALIDATION (the DTO record's Jakarta-annotated fields — see Task 6), FILTER (`filterAllowlistName` when `appliesTo`), TRACE (`traceHelperName` when `LlmTraceHelperGenerator.appliesTo`).
  - Templates (template.output): EXTRACTOR (`extractorName`), RENDER (`renderHelperName`), PAYLOAD (`payloadName`), PROMPT (`promptName`, json/xml only), OUTPUT_PARSER (`parserName`). Each gated by the matching `appliesTo`.
  - `importFqn` = the generated type's package + name (entity pkg, or `promptsPackage(pkg)` for template helpers), via `SpringNaming.splitFqn` + `toJavaPackage`.
  - Signatures: build from the known method shapes (repository methods, extractor `extract/extractLenient`, render `render`, etc.) — these are stable per category; the NAMES come from the seam so they can't drift.
- [ ] **Step 4: Run → PASS.**
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(java-apidocs): JavaApiModelBuilder enumerates the Java SDK surface via the seams" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 6: Field shapes from the generated DTO/payload records

**Files:** `…/apidocs/JavaFieldShapes.java`; test `JavaFieldShapesTest.java`.

- [ ] **Step 1: Failing test.** Assert the DTO field shapes match the entity's fields + Jakarta optionality (required `@NotNull/@NotBlank` → optional:false; enum via `@Pattern`/enum type → note carries the allowed values):
```java
List<FieldShape> fs = JavaFieldShapes.dtoFields(authorEntity);
assertEquals(new FieldShape("name", "String", false, null), find(fs, "name"));
assertEquals(false, find(fs, "id").optional());
```
- [ ] **Step 2: Run → FAIL.**
- [ ] **Step 3: Implement** by reusing `SpringDtoGenerator.validationAnnotations(field)` (the existing static, per scout) + the scalar-field iteration the DTO generator uses (skip `ObjectField`), mapping field subtype → Java type + `@NotNull/@NotBlank` → required. For PAYLOAD fields, reuse `SpringPayloadGenerator.resolveFieldType()` over the payload VO. Attach the resulting `List<FieldShape>` to the DTO/VALIDATION/PAYLOAD symbols in the builder (Task 5).
- [ ] **Step 4: Run → PASS** (builder test extended to assert a symbol's `fields()`).
- [ ] **Step 5: Commit.** `git add -A && git commit -m "feat(java-apidocs): field shapes from generated DTO/payload records" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 7: Rich fixture for the accuracy gate

**Files:** create `codegen-spring/src/test/resources/apidocs-fixture/meta.json` (Java-test-local — NOT the shared `fixtures/conformance/` corpus, per the SP-1 fixture-hygiene lesson; this is a Java-only IR test input, no cross-port expectations). The cross-port end-to-end fixture is SP-2c.

- [ ] **Step 1: Author the fixture** in the MetaDataLoader JSON format (mirror `fixtures/conformance/template-output-json-simple/input/meta.json`). Include: a table entity with PK + a `field.enum` + a `@filterable` field; a value object (no identity); an `@emitRoutes:false` entity (if that attr exists — verify; else a non-table-source entity to exercise controller-skip); a TPH abstract base + one concrete subtype (if TPH fixtures exist to copy from); an M:N pair (two entities + `@through`); a `template.output` (json) with `@payloadRef`; a `template.output` (email) with subject/body refs. Keep it minimal but covering every skip branch.
- [ ] **Step 2: Load it in a test** and assert it loads with zero errors (`SpringTestFixtures.loadFixture` or a disk-read loader). Commit the fixture + the load-smoke test.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "test(java-apidocs): rich apidocs fixture (entity/VO/M:N/template/skip-cases)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 8: The accuracy gate

**Files:** `JavaApiDocsAccuracyTest.java`.

- [ ] **Step 1: Write the gate.** Load the rich fixture; build the `JavaApiModel`. Run the REAL generators (entity: dto/repository/controller/filter; templates: extractor/render/payload/prompt/parser; trace) into a temp dir via `gen.setArgs(Map.of("outputDir", tmp)).execute(loader)`. Concatenate all emitted `.java` text. Then:
  - **Forward:** for every `ApiSymbol` whose kind maps to a generated TYPE (model/dto/data-access/filter/extractor/render/payload/prompt/output-parser/trace), assert `symbol.name` appears as an identifier (word-boundary regex) in the generated text.
  - **REST:** for each REST symbol `"<VERB> <path>"`, assert the controller text contains the mapping (the path via `controllerPath` + the verb annotation).
  - **Inverse (no over-doc):** assert a value object unit has ONLY MODEL; a controller-skipped entity has no REST symbols; a `template.prompt` (if present) is not documented as having a parser/render where the generator skips it.
- [ ] **Step 2: Run → expect PASS** (the seam guarantees names match). If a symbol name is NOT found, the IR builder used a name the generator doesn't emit — fix the builder (or a missed seam), NOT the test.
- [ ] **Step 3: Commit.** `git add -A && git commit -m "test(java-apidocs): accuracy gate — documented symbols == real generated Java" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`

## Task 9: Closeout

- [ ] Full `mvn -pl server/java/codegen-spring -am test` green; record counts.
- [ ] Whole-branch review (Java) + code-simplifier; fix findings. (Focus: the refactor changed NO generated output; the IR builder reuses seams, no duplicated naming; appliesTo predicates equal the originals.)
- [ ] Forward-merge to origin/main via a temp worktree off latest origin/main (main checkout has other sessions' WIP). Remove worktrees/branches. Update memory (SP-2a shipped; SP-2b/2c remain).

## Guard
- PUBLIC repo: no private/other-project names, no home paths (code, fixtures, commit messages). Use generic `acme.blog`/`Author` style.
- Tasks 1-3 are BEHAVIOR-PRESERVING: every existing Java generator test/conformance MUST stay green with zero output diff — that is the safety proof. If any generated output changes, a seam method or appliesTo doesn't match the original; fix it.
- DRIFT-PROOFING is the point: the IR builder must get names from `SpringNaming`/`SpringM2mSupport` and inclusion from `appliesTo()` — never re-concatenate names or re-implement guards. The accuracy gate enforces it.
- No rendering, no Maven goal, no cross-port fixture here — those are SP-2b / SP-2c.
- Don't touch the TS side, verify.ts, or non-Java generators.
