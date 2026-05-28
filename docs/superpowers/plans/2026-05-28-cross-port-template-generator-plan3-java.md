# Cross-Port templateGenerator — Plan 3: Java Port

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `TemplateGenerator` in the Java port + a conformance adapter that runs the Plan-0 corpus byte-equivalently.

**Architecture:** Java is materially different from TS/Python/C#: its existing `com.metaobjects.generator.Generator` interface has `void execute(MetaDataLoader)` (side-effect, no return), with no `EmittedFile` or `GenContext` types in the cross-port shape. We introduce a small new lightweight contract under `com.metaobjects.generator.mustache.templategen` — three new types (`EmittedFile` record, `TemplateWalkResult` record, `TemplateGenerator` static factory) — that mirrors the Python/C# factory shape. The new factory does **not** implement the legacy `Generator` interface; it returns `List<EmittedFile>` directly. Maven plugin integration is deferred (adopters can wrap the factory in their own legacy-Generator-conformant glue if they want `mvn meta:generate` integration).

**Tech Stack:** Java 17 / JUnit 4.13.2 / Maven / com.metaobjects.render (existing).

**Scope boundary:** Java factory + Java conformance adapter only. No changes to the legacy `Generator` interface, no Maven plugin XML schema additions.

---

## File Structure

**New (all under `server/java/codegen-mustache/`):**
- `src/main/java/com/metaobjects/generator/mustache/templategen/EmittedFile.java` — record `(String path, String content)`
- `src/main/java/com/metaobjects/generator/mustache/templategen/TemplateWalkResult.java` — record `(Object data, String outputPath)`
- `src/main/java/com/metaobjects/generator/mustache/templategen/TemplateGenerator.java` — static factory + functional `WalkFunction` interface
- `src/test/java/com/metaobjects/generator/mustache/templategen/TemplateGeneratorTest.java` — unit tests
- `src/test/java/com/metaobjects/generator/mustache/templategen/TemplateGeneratorConformanceTest.java` — JUnit-4 parameterized conformance harness

---

## Task 1: New types (EmittedFile + TemplateWalkResult + TemplateGenerator)

**Files:**
- Create: `server/java/codegen-mustache/src/main/java/com/metaobjects/generator/mustache/templategen/EmittedFile.java`
- Create: `server/java/codegen-mustache/src/main/java/com/metaobjects/generator/mustache/templategen/TemplateWalkResult.java`
- Create: `server/java/codegen-mustache/src/main/java/com/metaobjects/generator/mustache/templategen/TemplateGenerator.java`

- [ ] **Step 1: EmittedFile.java**

```java
package com.metaobjects.generator.mustache.templategen;

/**
 * One emitted file produced by {@link TemplateGenerator}.
 * Cross-port mirror of TS {@code EmittedFile}, Python {@code EmittedFile},
 * C# {@code record EmittedFile(string Path, string Content)}.
 *
 * <p>This is NOT the legacy {@code com.metaobjects.generator.Generator} contract
 * (which writes via {@code execute()} side-effects); this record exists because
 * the cross-port template-generator factory returns its files declaratively.
 */
public record EmittedFile(String path, String content) {}
```

- [ ] **Step 2: TemplateWalkResult.java**

```java
package com.metaobjects.generator.mustache.templategen;

/**
 * One walk entry: a payload + the output path the rendered template should
 * be emitted to (relative to whatever output root the caller chooses).
 */
public record TemplateWalkResult(Object data, String outputPath) {}
```

- [ ] **Step 3: TemplateGenerator.java**

```java
package com.metaobjects.generator.mustache.templategen;

import com.metaobjects.MetaRoot;
import com.metaobjects.render.InMemoryProvider;
import com.metaobjects.render.Provider;
import com.metaobjects.render.RenderRequest;
import com.metaobjects.render.Renderer;

import java.util.ArrayList;
import java.util.List;
import java.util.function.Function;

/**
 * Java port of the rc.12 cross-port {@code templateGenerator()} factory.
 *
 * <p>Walks the loaded {@link MetaRoot} via a caller-supplied callback,
 * renders the shared Mustache template via {@link Renderer#render}, and
 * returns {@code List<EmittedFile>} — one entry per walk result.
 *
 * <p>Design: {@code spec/design-docs/2026-05-28-cross-port-template-generator.md}.
 * Cross-port byte-equivalence verified via the shared fixture corpus at
 * {@code fixtures/render-conformance/template-generator/}.
 *
 * <p>Note: this factory does NOT implement the legacy
 * {@link com.metaobjects.generator.Generator} interface — that interface
 * has {@code void execute(MetaDataLoader)} which doesn't fit the
 * declarative "return files" cross-port shape. Adopters who want Maven
 * plugin integration can wrap this factory in their own
 * legacy-Generator-conformant glue.
 */
public final class TemplateGenerator {

    private TemplateGenerator() {}

    /** Walk callback shape: takes a MetaRoot, returns walk entries. */
    @FunctionalInterface
    public interface WalkFunction extends Function<MetaRoot, List<TemplateWalkResult>> {}

    /** Convenience static factory mirroring TS/Python/C# signatures. */
    public static List<EmittedFile> generate(
            String name,
            String template,
            WalkFunction walk,
            Provider provider,
            String format,
            MetaRoot root) {
        Renderer renderer = new Renderer();
        List<EmittedFile> out = new ArrayList<>();
        for (TemplateWalkResult entry : walk.apply(root)) {
            RenderRequest req = new RenderRequest(
                /* template */ null,
                /* ref */ template,
                /* payload */ entry.data(),
                /* provider */ provider,
                /* format */ format,
                /* verify */ null,
                /* maxChars */ null);
            String content = renderer.render(req);
            out.add(new EmittedFile(entry.outputPath(), content));
        }
        return out;
    }

    /** Overload defaulting format to "text". */
    public static List<EmittedFile> generate(
            String name,
            String template,
            WalkFunction walk,
            Provider provider,
            MetaRoot root) {
        return generate(name, template, walk, provider, "text", root);
    }
}
```

- [ ] **Step 4: Build to confirm clean compile**

Run: `cd <repo-root> && mvn -pl server/java/codegen-mustache -am compile 2>&1 | tail -5`

Expected: BUILD SUCCESS. No compile errors. (Skip the test step here — we add tests in Task 2 and build them then.)

- [ ] **Step 5: Commit**

```bash
cd <repo-root>
git add server/java/codegen-mustache/src/main/java/com/metaobjects/generator/mustache/templategen/
git commit -m "feat(java-codegen): TemplateGenerator factory + EmittedFile + TemplateWalkResult

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Unit tests (per-entity + aggregator + format)

**Files:**
- Create: `server/java/codegen-mustache/src/test/java/com/metaobjects/generator/mustache/templategen/TemplateGeneratorTest.java`

- [ ] **Step 1: Write unit tests**

```java
package com.metaobjects.generator.mustache.templategen;

import com.metaobjects.MetaRoot;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.StringField;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.EntityMetaObject;
import com.metaobjects.render.InMemoryProvider;
import com.metaobjects.render.Provider;
import org.junit.Test;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

public class TemplateGeneratorTest {

    private static MetaRoot buildRoot() {
        MetaRoot root = new MetaRoot("test");
        EntityMetaObject post = new EntityMetaObject("Post");
        post.addMetaField(new LongField("id"));
        post.addMetaField(new StringField("title"));
        root.addChild(post);
        return root;
    }

    private static Provider provider(Map<String, String> map) {
        return new InMemoryProvider(map);
    }

    @Test
    public void perEntityWalkEmitsOneFilePerEntity() {
        Provider p = provider(Map.of("custom/hello", "Hello {{name}}!\n"));
        MetaRoot root = buildRoot();
        List<EmittedFile> files = TemplateGenerator.generate(
            "hello",
            "custom/hello",
            r -> r.getChildrenOfType("object").stream()
                  .map(e -> new TemplateWalkResult(
                      Map.of("name", e.getName()),
                      e.getName() + ".txt"))
                  .toList(),
            p,
            root);
        assertEquals(1, files.size());
        assertEquals("Post.txt", files.get(0).path());
        assertEquals("Hello Post!\n", files.get(0).content());
    }

    @Test
    public void aggregatorWalkEmitsSingleFileFromAllEntities() {
        Provider p = provider(Map.of(
            "custom/index",
            "Entities:\n{{#entities}}- {{name}}\n{{/entities}}"));
        MetaRoot root = new MetaRoot("test");
        root.addChild(new EntityMetaObject("Post"));
        root.addChild(new EntityMetaObject("Comment"));

        List<EmittedFile> files = TemplateGenerator.generate(
            "index",
            "custom/index",
            r -> {
                List<Map<String, String>> entities = r.getChildrenOfType("object").stream()
                    .map(e -> Map.of("name", e.getName()))
                    .toList();
                return List.of(new TemplateWalkResult(
                    Map.of("entities", entities), "index.txt"));
            },
            p,
            root);
        assertEquals(1, files.size());
        assertEquals("index.txt", files.get(0).path());
        assertEquals("Entities:\n- Post\n- Comment\n", files.get(0).content());
    }

    @Test
    public void formatTextDoesNotEscapeHtml() {
        Provider p = provider(Map.of("custom/raw", "{{snippet}}\n"));
        MetaRoot root = buildRoot();
        List<EmittedFile> files = TemplateGenerator.generate(
            "raw-text",
            "custom/raw",
            r -> List.of(new TemplateWalkResult(Map.of("snippet", "<p>hi</p>"), "out.txt")),
            p,
            "text",
            root);
        assertEquals("<p>hi</p>\n", files.get(0).content());
    }

    @Test
    public void formatHtmlEscapesHtmlInPayload() {
        Provider p = provider(Map.of("custom/raw", "{{snippet}}\n"));
        MetaRoot root = buildRoot();
        List<EmittedFile> files = TemplateGenerator.generate(
            "raw-html",
            "custom/raw",
            r -> List.of(new TemplateWalkResult(Map.of("snippet", "<p>hi</p>"), "out.html")),
            p,
            "html",
            root);
        assertNotEquals("<p>hi</p>\n", files.get(0).content());
        String content = files.get(0).content();
        assertTrue("expected HTML escape in: " + content,
            content.contains("&lt;") || content.contains("&#60;"));
    }
}
```

- [ ] **Step 2: Verify imports — confirm field class names, MetaObject API**

Run: `cd <repo-root> && find server/java -name "EntityMetaObject.java" -o -name "StringField.java" -o -name "LongField.java" 2>&1 | head -5`

Expected: real paths. If `EntityMetaObject` doesn't exist (it might be just `MetaObject` with subtype constant), adjust to use the actual class names. Same for fields — confirm `StringField` / `LongField` exist.

If field constructors differ from `new StringField("name")` (e.g., they need TypeId), open `server/java/metadata/src/main/java/com/metaobjects/field/StringField.java` and match the actual signature.

- [ ] **Step 3: Run tests**

Run: `cd <repo-root> && mvn -pl server/java/codegen-mustache -am test -Dtest=TemplateGeneratorTest 2>&1 | tail -10`

Expected: Tests run: 4, Failures: 0, Errors: 0, Skipped: 0.

If a test fails: most likely a Mustache rendering nuance (whitespace, newline, or escape strategy). Check the actual vs expected; if it's a real spec corner case differing from TS/Python/C#, this is a cross-port discrepancy — investigate at the render layer, don't paper over it in the test.

- [ ] **Step 4: Commit**

```bash
cd <repo-root>
git add server/java/codegen-mustache/src/test/java/com/metaobjects/generator/mustache/templategen/TemplateGeneratorTest.java
git commit -m "test(java-codegen): TemplateGenerator unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Conformance adapter — JUnit 4 parameterized

**Files:**
- Create: `server/java/codegen-mustache/src/test/java/com/metaobjects/generator/mustache/templategen/TemplateGeneratorConformanceTest.java`

- [ ] **Step 1: Write the adapter**

```java
package com.metaobjects.generator.mustache.templategen;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.MetaRoot;
import com.metaobjects.field.BooleanField;
import com.metaobjects.field.DateField;
import com.metaobjects.field.DoubleField;
import com.metaobjects.field.IntegerField;
import com.metaobjects.field.LongField;
import com.metaobjects.field.MetaField;
import com.metaobjects.field.StringField;
import com.metaobjects.object.EntityMetaObject;
import com.metaobjects.render.InMemoryProvider;
import com.metaobjects.render.Provider;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Cross-port byte-equivalence harness for the Java {@link TemplateGenerator}.
 *
 * <p>Mirrors the TS reference adapter:
 * {@code server/typescript/packages/codegen-ts/test/conformance/template-generator-conformance.test.ts}
 *
 * <p>Fixture format: {@code fixtures/render-conformance/template-generator/README.md}
 */
@RunWith(Parameterized.class)
public class TemplateGeneratorConformanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path FIXTURES_DIR;

    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/render-conformance/template-generator"))) {
            p = p.getParent();
        }
        FIXTURES_DIR = p == null ? null : p.resolve("fixtures/render-conformance/template-generator");
    }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> fixtures() throws IOException {
        if (FIXTURES_DIR == null || !Files.isDirectory(FIXTURES_DIR)) return List.of();
        try (Stream<Path> s = Files.list(FIXTURES_DIR)) {
            return s.filter(Files::isDirectory)
                    .filter(p -> p.getFileName().toString().startsWith("fixture-"))
                    .sorted()
                    .map(p -> new Object[]{p.getFileName().toString(), p})
                    .collect(Collectors.toList());
        }
    }

    private final String name;
    private final Path fixtureDir;

    public TemplateGeneratorConformanceTest(String name, Path fixtureDir) {
        this.name = name;
        this.fixtureDir = fixtureDir;
    }

    private static MetaField makeField(String typeStr, String fieldName) {
        switch (typeStr) {
            case "string": return new StringField(fieldName);
            case "long": return new LongField(fieldName);
            case "int": return new IntegerField(fieldName);
            case "double": return new DoubleField(fieldName);
            case "boolean": return new BooleanField(fieldName);
            case "date": return new DateField(fieldName);
            default: throw new IllegalArgumentException("Unknown field type: " + typeStr);
        }
    }

    private static MetaRoot buildRoot(JsonNode meta) {
        MetaRoot root = new MetaRoot("conformance");
        for (JsonNode e : meta.get("entities")) {
            EntityMetaObject obj = new EntityMetaObject(e.get("name").asText());
            for (JsonNode f : e.get("fields")) {
                obj.addMetaField(makeField(f.get("type").asText(), f.get("name").asText()));
            }
            root.addChild(obj);
        }
        return root;
    }

    private static Object jsonToPayload(JsonNode n) {
        if (n.isObject()) {
            Map<String, Object> m = new LinkedHashMap<>();
            n.fields().forEachRemaining(e -> m.put(e.getKey(), jsonToPayload(e.getValue())));
            return m;
        }
        if (n.isArray()) {
            List<Object> l = new ArrayList<>();
            for (JsonNode c : n) l.add(jsonToPayload(c));
            return l;
        }
        if (n.isTextual()) return n.asText();
        if (n.isIntegralNumber()) return n.asLong();
        if (n.isFloatingPointNumber()) return n.asDouble();
        if (n.isBoolean()) return n.asBoolean();
        if (n.isNull()) return null;
        throw new IllegalArgumentException("Unhandled JsonNode kind: " + n.getNodeType());
    }

    @Test
    public void conformance() throws IOException {
        JsonNode meta = JSON.readTree(fixtureDir.resolve("meta.json").toFile());
        String templateBody = Files.readString(fixtureDir.resolve("template.mustache"));
        JsonNode walkJson = JSON.readTree(fixtureDir.resolve("walk.json").toFile());

        List<TemplateWalkResult> walkEntries = new ArrayList<>();
        List<String> entityRefs = new ArrayList<>();
        for (JsonNode w : walkJson) {
            walkEntries.add(new TemplateWalkResult(
                jsonToPayload(w.get("data")),
                w.get("outputPath").asText()));
            entityRefs.add(w.has("entity") && !w.get("entity").isNull() ? w.get("entity").asText() : null);
        }

        MetaRoot root = buildRoot(meta);
        Set<String> byName = root.getChildrenOfType("object").stream()
            .map(m -> m.getName()).collect(Collectors.toSet());
        for (String ref : entityRefs) {
            if (ref != null && !byName.contains(ref)) {
                throw new AssertionError("walk.json references unknown entity: " + ref);
            }
        }

        Provider provider = new InMemoryProvider(Map.of("conformance/template", templateBody));
        List<EmittedFile> files = TemplateGenerator.generate(
            name,
            "conformance/template",
            r -> walkEntries,
            provider,
            meta.get("format").asText(),
            root);

        List<String> emittedPaths = files.stream().map(EmittedFile::path).sorted().toList();
        List<String> expectedPaths = walkEntries.stream().map(TemplateWalkResult::outputPath).sorted().toList();
        assertEquals(expectedPaths, emittedPaths);

        Path expectedDir = fixtureDir.resolve("expected");
        for (TemplateWalkResult w : walkEntries) {
            Path expectedFile = expectedDir.resolve(w.outputPath());
            assertTrue("missing expected/" + w.outputPath(), Files.exists(expectedFile));
            String expected = Files.readString(expectedFile);
            String actual = files.stream()
                .filter(f -> f.path().equals(w.outputPath()))
                .findFirst().orElseThrow().content();
            assertEquals(
                "byte-equivalence failure in " + name + ": " + w.outputPath(),
                expected, actual);
        }
    }
}
```

- [ ] **Step 2: Confirm Jackson is on the classpath**

Run: `cd <repo-root> && grep -E "jackson-databind" server/java/codegen-mustache/pom.xml 2>&1 | head -3`

Expected: a `<dependency>` for jackson-databind exists. If not, add it (test scope) to the codegen-mustache pom — or switch to `org.json` if that's already present.

- [ ] **Step 3: Run conformance**

Run: `cd <repo-root> && mvn -pl server/java/codegen-mustache -am test -Dtest=TemplateGeneratorConformanceTest 2>&1 | tail -10`

Expected: Tests run: 3, Failures: 0, Errors: 0, Skipped: 0 (one test per fixture).

If byte-equivalence fails: check the diff in the assertion message; expect either whitespace nuances or escape strategy differences. Java uses `com.github.spullara.mustache.java` per the codegen-mustache module — its standalone-tag and lambda handling may differ subtly from Stubble (C#) / Bun-native (TS) / chevron (Python). For real spec gaps, fix render-layer; don't blanket-accept.

- [ ] **Step 4: Commit**

```bash
cd <repo-root>
git add server/java/codegen-mustache/src/test/java/com/metaobjects/generator/mustache/templategen/TemplateGeneratorConformanceTest.java
git commit -m "test(java-conformance): TemplateGenerator cross-port byte-equivalence harness

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Regression check — codegen-mustache module test suite

- [ ] **Step 1: Run the full module suite**

Run: `cd <repo-root> && mvn -pl server/java/codegen-mustache -am test 2>&1 | tail -10`

Expected: all pre-existing tests pass + new 4 unit + 3 conformance tests. No regressions.

- [ ] **Step 2: No commit** (read-only verification)

---

## Self-Review

**1. Spec coverage:**
- Per-port factory contract → Task 1 (new types because legacy Generator interface is incompatible — documented in factory javadoc)
- Conformance via shared declarative fixtures → Task 3 (JUnit 4 `@Parameterized` over Plan-0 corpus)
- Three walk patterns → exercised transitively by the parametrized conformance test
- Render integration → factory uses `new Renderer().render(req)` (no new render code, no Renderer changes)
- Generator-interface integration → explicitly DECLINED — Java's existing `Generator` interface has the wrong contract. Documented in factory javadoc. Maven plugin integration deferred to a follow-up.

**2. Placeholder scan:** Searched for "TBD", "TODO", "fill in", "implement later". None present.

**3. Type consistency:**
- `EmittedFile(String path, String content)` — same shape as TS/Python/C#.
- `TemplateWalkResult(Object data, String outputPath)` — same shape (Object is the broadest Java payload type).
- `TemplateGenerator.generate(name, template, walk, provider, format, root)` — note `MetaRoot root` is a positional arg here (vs ctx-derived in other ports) because Java's legacy Generator contract has no ctx equivalent and we're avoiding inventing one for this scope.
- `WalkFunction` is `Function<MetaRoot, List<TemplateWalkResult>>` — idiomatic Java functional interface.
- Field-class names (`StringField`, `LongField`, `EntityMetaObject`) — verified in Task 2 step 2.

Cross-port-API divergence (Java passes `MetaRoot` directly instead of a `GenContext`-style wrapper) is a deliberate scope decision: introducing a `GenContext` to Java would expand scope into legacy-interface modification. Documented as a non-goal in the Plan + design doc.

No drift.
