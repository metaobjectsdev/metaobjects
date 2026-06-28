# SP-1b — JVM declarative Mustache template-codegen (Java + Kotlin) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Bring the declarative Mustache template generator (`scope` ∈ perEntity/perPackage/perModel + `outputPattern`, no walk code) to the JVM, gated byte-identical against the same `fixtures/template-codegen-conformance/` corpus the TS port passes. Kotlin gains a template generator for the first time (it reuses the JVM generator on the shared classpath).

**Architecture:** One JVM implementation in `codegen-base` (`com.metaobjects.generator.template`) — a Map-based neutral data-dict builder + three named scope walks + an output-pattern expander + a `TemplateScopeGenerator extends GeneratorBase` adapter that feeds the walk into the existing byte-equivalent `render/TemplateGenerator.generate(...)` and writes the files. The render engine is already cross-port byte-equal (`fixtures/render-conformance/`), so only the data dict + scope + pattern are new. Both a Java conformance test and a Kotlin reachability+output test gate it.

**Tech Stack:** Java 21, Maven, `metaobjects-metadata` (MetaObject/MetaField/MetaIdentity/MetaRelationship), `metaobjects-render` (TemplateGenerator factory + FilesystemProvider + Renderer/JMustache), JUnit4 (repo convention), Kotlin (codegen-kotlin module test).

## Global Constraints

- **Neutral data-dict keys are the byte-gated cross-port contract** — must match the TS `EntityTemplateData` EXACTLY: `name`, `package`, `fields[]` (`name`,`type`,`required`,`isArray`,`maxLength?`,`enumValues?`), `identities[]` (`kind`,`fields`), `relationships[]` (`name`,`cardinality`,`targetRef`). Use `LinkedHashMap`/`ArrayList` so iteration order is deterministic; OMIT optional keys (`maxLength`/`enumValues`) when absent (so `{{#maxLength}}` gates correctly, matching TS).
- **Scope names**: `perEntity`/`perPackage`/`perModel` (exact strings).
- **Output-pattern grammar**: `{name}`/`{Name}`(PascalCase)/`{package}`(`::`→`/`); empty package collapses its slash; unknown placeholder → throw. Mirror `output-pattern.ts` semantics exactly.
- **`type` is the neutral field subtype** (`field.getSubType()`), NOT a Java type; arrayness via the `isArray` boolean only.
- **TS is the byte-equality oracle.** The expected output lives in `fixtures/template-codegen-conformance/expected/` (produced by TS). Java/Kotlin MUST reproduce it byte-for-byte.
- **Named constants** for metamodel attrs — use `MetaField.ATTR_MAX_LENGTH`, `ATTR_VALUES`(verify name), `ATTR_REQUIRED`, `MetaData.ATTR_IS_ABSTRACT`, `MetaIdentity.ATTR_FIELDS`. Never inline.
- **Public-repo hygiene**: no private names / absolute home paths in committed files.
- **Build locally** (CI java-reactor is flaky): `cd server/java && mvn -q -pl codegen-base -am test` for the unit/conformance tests; `mvn -q -pl codegen-kotlin -am test` for the Kotlin gate. Run the affected-module build, not the whole reactor.
- **Commit trailers** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky`.

---

## File Structure

In `server/java/codegen-base/src/main/java/com/metaobjects/generator/template/`:
- `OutputPattern.java` — `expand(pattern, name, pkg)` static helper.
- `TemplateData.java` — `entity(MetaObject)`, `pkg(String, List<MetaObject>)`, `model(List<MetaObject>)` → `Map<String,Object>` neutral dicts; plus `effectivePackageOf`/`isConcrete` helpers.
- `ScopeWalk.java` — `forScope(scope, pattern)` → `Function<List<MetaObject>, List<TemplateWalkResult>>`.
- `TemplateScopeGenerator.java` — `extends GeneratorBase`; reads args (`template`,`scope`,`outputPattern`,`format`,`templatesDir`), builds the walk, calls `render TemplateGenerator.generate`, writes files under `ARG_OUTPUTDIR`.

Tests:
- `server/java/codegen-base/src/test/java/com/metaobjects/generator/template/OutputPatternTest.java`
- `.../template/TemplateDataTest.java`
- `.../template/TemplateCodegenConformanceTest.java` (runs the shared corpus)
- `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/TemplateScopeKotlinConformanceTest.kt` (Kotlin reachability + corpus output)

No new Maven module; no pom changes (codegen-base already has metadata + render).

---

## Task 1: Output-pattern expander (Java)

**Files:** Create `OutputPattern.java` + `OutputPatternTest.java`.

**Interfaces:** `public static String expand(String pattern, String name, String pkg)` — `name`/`pkg` may be null (perModel passes both null; perPackage passes null name). `{name}`/`{Name}` with null name → throw IllegalArgumentException; `{package}` with null/empty pkg → empty + collapse a leading/duplicate slash; unknown `{token}` → throw.

- [ ] **Step 1: Failing test** (`OutputPatternTest.java`)

```java
package com.metaobjects.generator.template;
import org.junit.Test;
import static org.junit.Assert.*;

public class OutputPatternTest {
    @Test public void nameAndPackage() {
        assertEquals("acme/sales/orderService.java",
            OutputPattern.expand("{package}/{name}Service.java", "order", "acme::sales"));
    }
    @Test public void pascalName() {
        assertEquals("OrderLine.kt", OutputPattern.expand("{Name}.kt", "order_line", null));
    }
    @Test public void literalPassthrough() {
        assertEquals("registry.kt", OutputPattern.expand("registry.kt", null, null));
    }
    @Test public void emptyPackageCollapses() {
        assertEquals("x.java", OutputPattern.expand("{package}/{name}.java", "x", ""));
    }
    @Test(expected = IllegalArgumentException.class) public void unknownPlaceholder() {
        OutputPattern.expand("{bogus}.java", "x", "p");
    }
    @Test(expected = IllegalArgumentException.class) public void nameWithoutNameVar() {
        OutputPattern.expand("{name}.java", null, "p");
    }
}
```

- [ ] **Step 2: Run, expect FAIL** — `cd server/java && mvn -q -pl codegen-base -am test -Dtest=OutputPatternTest` (compile error: class missing).

- [ ] **Step 3: Implement** (`OutputPattern.java`)

```java
package com.metaobjects.generator.template;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Expands the cross-port output-pattern grammar (SP-1 §3.3): {name} {Name} {package}.
 *  Byte-equivalent to the TS output-pattern.ts. */
public final class OutputPattern {
    private OutputPattern() {}
    private static final Pattern TOKEN = Pattern.compile("\\{(\\w+)\\}");

    public static String expand(String pattern, String name, String pkg) {
        Matcher m = TOKEN.matcher(pattern);
        StringBuffer sb = new StringBuffer();
        boolean[] pkgEmpty = { false };
        while (m.find()) {
            String token = m.group(1);
            String rep;
            switch (token) {
                case "package": {
                    String p = pkg == null ? "" : pkg.replace("::", "/");
                    if (p.isEmpty()) pkgEmpty[0] = true;
                    rep = p;
                    break;
                }
                case "name":
                    if (name == null) throw new IllegalArgumentException(
                        "output pattern '" + pattern + "' uses {name} but no entity name is in scope");
                    rep = name;
                    break;
                case "Name":
                    if (name == null) throw new IllegalArgumentException(
                        "output pattern '" + pattern + "' uses {Name} but no entity name is in scope");
                    rep = pascal(name);
                    break;
                default:
                    throw new IllegalArgumentException(
                        "unknown placeholder {" + token + "} in output pattern '" + pattern + "'");
            }
            m.appendReplacement(sb, Matcher.quoteReplacement(rep));
        }
        m.appendTail(sb);
        String out = sb.toString();
        if (pkgEmpty[0]) out = out.replaceAll("^/+", "").replaceAll("/{2,}", "/");
        return out;
    }

    private static String pascal(String s) {
        StringBuilder b = new StringBuilder();
        for (String w : s.split("[^A-Za-z0-9]+")) {
            if (w.isEmpty()) continue;
            b.append(Character.toUpperCase(w.charAt(0))).append(w.substring(1));
        }
        return b.toString();
    }
}
```

- [ ] **Step 4: Run, expect PASS** — `mvn -q -pl codegen-base -am test -Dtest=OutputPatternTest`.
- [ ] **Step 5: Commit** (`feat(codegen-base): JVM output-pattern expander for template codegen`).

---

## Task 2: Neutral data-dict builder (Java, Map-based)

**Files:** Create `TemplateData.java` + `TemplateDataTest.java`.

**Interfaces:**
- `public static Map<String,Object> entity(MetaObject o)` — keys: `name`, `package` (effective), `fields` (List<Map>), `identities` (List<Map>), `relationships` (List<Map>).
- `public static Map<String,Object> pkg(String p, List<MetaObject> entities)` — `{package, entities:[entity()…]}`.
- `public static Map<String,Object> model(List<MetaObject> objects)` — `{packages:[{package, entities:[…]}]}`; concrete-only; packages ascending.
- `public static String effectivePackageOf(MetaObject o)` and `public static boolean isConcrete(MetaObject o)` (not abstract).

Field map (LinkedHashMap, in this key order): `name`(String), `type`(String subtype), `required`(Boolean), `isArray`(Boolean), then `maxLength`(Integer) ONLY if present, `enumValues`(List<String>) ONLY if subtype==enum and present. Identity map: `kind`(subType), `fields`(List<String>). Relationship map: `name`, `cardinality`, `targetRef`.

> Implementer notes (verify against the real classes, adjust if a getter differs):
> - effective package: probe whether `MetaObject.getPackage()` returns the file package (Java assigns packages to children, unlike TS); if it returns the package directly, `effectivePackageOf` = `getPackage()` (empty-string when null). If it returns null/bare, fall back to parsing the package prefix from a fully-qualified name. Decide with a one-off probe test asserting Product's package is `shop`.
> - required: `o`/field required = `field.getMetaAttr(MetaField.ATTR_REQUIRED)` truthy OR a required validator (mirror TS `isRequired`). If `MetaField` exposes an `isRequired()`/`requiresValue()` accessor, prefer it.
> - maxLength: `field.getMetaAttr(MetaField.ATTR_MAX_LENGTH)` as Integer when set.
> - enum values: `field.getMetaAttr("values")` (confirm the constant name, e.g. `MetaField.ATTR_VALUES`/an enum subclass) → `List<String>`.
> - isArray: `field.isArrayType()`.
> - identities: `o.getChildren(MetaIdentity.class)`; `getSubType()` + `getFields()`.
> - relationships: `o.getChildren(MetaRelationship.class)`; `getName()` + `getCardinality()` (null→"") + `getObjectRef()` (null→"").

- [ ] **Step 1: Failing test** (`TemplateDataTest.java`) — load the corpus metadata and assert the dict:

```java
package com.metaobjects.generator.template;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.simple.SimpleLoader;            // use the repo's standard file loader
import com.metaobjects.object.MetaObject;
import org.junit.Test;
import java.nio.file.*;
import java.util.*;
import static org.junit.Assert.*;

public class TemplateDataTest {
    private static MetaDataLoader loadShop() {
        Path corpus = RepoRoot.find().resolve("fixtures/template-codegen-conformance");
        // Load corpus/metadata/meta.shop.json via the project's standard JSON file loader.
        return TestLoaders.loadJson(corpus.resolve("metadata/meta.shop.json"));   // helper per repo convention
    }

    @Test public void entityDictHasNeutralFields() {
        MetaDataLoader loader = loadShop();
        MetaObject product = loader.getMetaObjects().stream()
            .filter(o -> o.getName().equals("Product")).findFirst().orElseThrow();
        Map<String,Object> d = TemplateData.entity(product);
        assertEquals("Product", d.get("name"));
        assertEquals("shop", d.get("package"));
        @SuppressWarnings("unchecked")
        List<Map<String,Object>> fields = (List<Map<String,Object>>) d.get("fields");
        Map<String,Object> name = fields.stream().filter(f -> f.get("name").equals("name")).findFirst().orElseThrow();
        assertEquals("string", name.get("type"));
        assertEquals(Boolean.TRUE, name.get("required"));
        assertEquals(Boolean.FALSE, name.get("isArray"));
        assertEquals(120, ((Number) name.get("maxLength")).intValue());
        Map<String,Object> status = fields.stream().filter(f -> f.get("name").equals("status")).findFirst().orElseThrow();
        assertEquals("enum", status.get("type"));
        assertEquals(List.of("ACTIVE","ARCHIVED"), status.get("enumValues"));
    }

    @Test public void modelGroupsByPackageConcreteOnly() {
        MetaDataLoader loader = loadShop();
        Map<String,Object> model = TemplateData.model(loader.getMetaObjects());
        @SuppressWarnings("unchecked")
        List<Map<String,Object>> pkgs = (List<Map<String,Object>>) model.get("packages");
        assertEquals(1, pkgs.size());
        assertEquals("shop", pkgs.get(0).get("package"));
    }
}
```

> The plan assumes two tiny test helpers (`RepoRoot.find()` walking up for the `fixtures/` dir, and a JSON file loader call following the repo's existing test pattern — copy from `TemplateGeneratorConformanceTest`/an existing loader test). If the repo already has a loader-from-file helper, use it; otherwise add a 10-line `RepoRoot`/`TestLoaders` under the test source root.

- [ ] **Step 2: Run, expect FAIL** — `mvn -q -pl codegen-base -am test -Dtest=TemplateDataTest`.
- [ ] **Step 3: Implement `TemplateData.java`** — build the LinkedHashMaps per the contract above; group `model` by `effectivePackageOf`, packages `TreeMap`/sorted; exclude `!isConcrete`.
- [ ] **Step 4: Run, expect PASS.** Fix accessor names against the real classes if compile/assert fails (the implementer notes list the candidates).
- [ ] **Step 5: Commit** (`feat(codegen-base): JVM neutral template data-dict builder`).

---

## Task 3: Scope walks + `TemplateScopeGenerator` adapter

**Files:** Create `ScopeWalk.java`, `TemplateScopeGenerator.java`. (Adapter test is the conformance test in Task 4.)

**Interfaces:**
- `ScopeWalk.forScope(String scope, String outputPattern)` → `Function<List<MetaObject>, List<TemplateWalkResult>>`:
  - `perEntity`: concrete objects → `new TemplateWalkResult(TemplateData.entity(o), OutputPattern.expand(pattern, o.getName(), TemplateData.effectivePackageOf(o)))`.
  - `perPackage`: group concrete by `effectivePackageOf` (ascending) → `TemplateData.pkg(p, list)` + `expand(pattern, null, p)`.
  - `perModel`: single → `TemplateData.model(objects)` + `expand(pattern, null, null)`.
  - unknown scope → IllegalArgumentException.
- `TemplateScopeGenerator extends GeneratorBase`: in `execute(MetaDataLoader loader)`, read args `template`,`scope`,`outputPattern`,`format`(default "text"),`templatesDir`; build a `FilesystemProvider(Paths.get(templatesDir))`; call `TemplateGenerator.generate(getArg("name", scope), template, root -> ScopeWalk.forScope(scope, outputPattern).apply(loader.getMetaObjects()), provider, format, loader.getMetaObjects())`; write each `EmittedFile` under `getOutputDir()` (create parent dirs), guarding the `@generated`-style overwrite policy consistent with other generators (write/overwrite; tests use a fresh temp dir).

- [ ] **Step 1:** (No standalone test — exercised by Task 4 conformance.) Implement `ScopeWalk.java` and `TemplateScopeGenerator.java`.
- [ ] **Step 2: Compile** — `mvn -q -pl codegen-base -am test-compile`.
- [ ] **Step 3: Commit** (`feat(codegen-base): scope walks + TemplateScopeGenerator (Maven-wirable)`).

---

## Task 4: Java conformance gate (shared corpus)

**Files:** Create `TemplateCodegenConformanceTest.java`.

**Interface:** Loads `fixtures/template-codegen-conformance/spec.json` (Jackson), loads `metadata/meta.shop.json`, and for each spec entry builds + runs the walk via `TemplateGenerator.generate(...)` with a `FilesystemProvider(corpus/templates)`, writing into a temp dir; then asserts the temp tree is byte-identical to `expected/`.

- [ ] **Step 1: Failing test** — assert byte-equality:

```java
// pseudo-structure; mirror TemplateGeneratorConformanceTest's fixture discovery
@Test public void corpusMatchesExpectedByteForByte() throws Exception {
    Path corpus = RepoRoot.find().resolve("fixtures/template-codegen-conformance");
    JsonNode spec = JSON.readTree(corpus.resolve("spec.json").toFile());
    MetaDataLoader loader = TestLoaders.loadJson(corpus.resolve("metadata/meta.shop.json"));
    Provider provider = new FilesystemProvider(corpus.resolve("templates"));
    Path out = Files.createTempDirectory("tmpl-conf-java");
    for (JsonNode g : spec.get("generators")) {
        String scope = g.get("scope").asText(), pattern = g.get("outputPattern").asText();
        String fmt = g.has("format") ? g.get("format").asText() : "text";
        List<EmittedFile> files = TemplateGenerator.generate(
            g.get("name").asText(), g.get("template").asText(),
            root -> ScopeWalk.forScope(scope, pattern).apply(loader.getMetaObjects()),
            provider, fmt, loader.getMetaObjects());
        for (EmittedFile f : files) {
            Path p = out.resolve(f.path());
            Files.createDirectories(p.getParent() == null ? out : p.getParent());
            Files.writeString(p, f.content());
        }
    }
    Path expected = corpus.resolve("expected");
    // assert same relative file set + identical bytes (walk both trees)
    assertTreesEqual(expected, out);
}
```

- [ ] **Step 2: Run, expect FAIL then iterate** — `mvn -q -pl codegen-base -am test -Dtest=TemplateCodegenConformanceTest`. If bytes differ, diff the actual vs `expected/<file>` and fix the data dict / walk until identical (the render engine is already byte-equal, so any diff is a data-dict or pattern bug — NOT a reason to edit `expected/`, which is the TS-produced oracle).
- [ ] **Step 3: Run, expect PASS.**
- [ ] **Step 4: Commit** (`test(codegen-base): JVM template-codegen conformance gate (shared corpus)`).

---

## Task 5: Kotlin reachability + corpus gate

**Files:** Create `TemplateScopeKotlinConformanceTest.kt` in `codegen-kotlin/src/test/kotlin/...`.

**Interface:** Proves Kotlin consumers get the template generator (codegen-kotlin depends on codegen-base): the test calls the SAME `TemplateGenerator.generate` + `ScopeWalk.forScope` from Kotlin over the shared corpus and asserts byte-equality against `expected/`. This makes "Kotlin gains a template generator" concrete and gated.

- [ ] **Step 1: Failing test** — Kotlin mirror of Task 4 (idiomatic Kotlin, same assertions; reuse a small `assertTreesEqual`).
- [ ] **Step 2: Run, expect FAIL→PASS** — `mvn -q -pl codegen-kotlin -am test -Dtest=TemplateScopeKotlinConformanceTest`.
- [ ] **Step 3: Commit** (`test(codegen-kotlin): Kotlin template-codegen reachability + corpus gate`).

---

## Task 6: Final verification

- [ ] **Step 1:** `cd server/java && mvn -q -pl codegen-base,codegen-kotlin -am test` — all green (new tests + no regression in the two modules).
- [ ] **Step 2:** Confirm NO change under `fixtures/template-codegen-conformance/expected/` (the corpus is the TS oracle; Java/Kotlin only READ it). `git status` clean except the new Java/Kotlin sources + tests.
- [ ] **Step 3:** Proceed to the no-mistakes gate in an isolated worktree (NOT under a shared temp dir whose stray `package.json` can break bun workspace resolution; place it under the developer's home, e.g. `<home>/wt-sp1b`). Java compile+conformance is CI-gated, but run the two-module `mvn` build locally first since CI's java-reactor is flaky. `--skip=ci`; admin-merge after local green.

---

## Self-Review (against the spec §3–§5)

- §3.1 scope names → Tasks 3/4/5 use `perEntity`/`perPackage`/`perModel`.
- §3.2 data dict → Task 2 builds the exact key set (Map-based), optional keys omitted; byte-gated by Task 4 against the TS-produced `expected/`.
- §3.3 output-pattern → Task 1 mirrors `output-pattern.ts`.
- §3.4 template resolution → `FilesystemProvider(corpus/templates)` (the existing render Provider chain).
- §3.5 conformance → Tasks 4 (Java) + 5 (Kotlin) run the shared corpus.
- §4 JVM wiring → `TemplateScopeGenerator extends GeneratorBase` (Task 3) is Maven-wirable via the standard `<generator><classname>…</classname><args>…</args>`; the dedicated `<templateGenerator>` element sugar is deferred (the FQN+args path delivers the capability with zero Mojo changes — noted as a follow-on, not a blocker).
- §5 increment SP-1b → Java + Kotlin over the shared render engine, Kotlin gains the generator, corpus-gated. Covered.

Out of scope (unchanged): SP-1c Python, SP-1d C#, SP-2 native registration parity, SP-3 docs. The effective-package resolution (the TS bug the review caught) is explicitly handled in Task 2 via `effectivePackageOf` and asserted (`Product` → `shop`) so the JVM port can't repeat it.
