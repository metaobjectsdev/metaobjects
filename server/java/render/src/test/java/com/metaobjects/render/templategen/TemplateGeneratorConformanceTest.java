package com.metaobjects.render.templategen;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
 *
 * <p>The "root" passed to the walk callback here is the entity-name list from
 * {@code meta.json} — keeps the render module independent of the metadata
 * module. Real adopters typically pass a {@code MetaRoot}; the factory's
 * generic root type accommodates both.
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
        Set<String> referencedEntities = new HashSet<>();
        for (JsonNode w : walkJson) {
            walkEntries.add(new TemplateWalkResult(
                jsonToPayload(w.get("data")),
                w.get("outputPath").asText()));
            if (w.has("entity") && !w.get("entity").isNull()) {
                referencedEntities.add(w.get("entity").asText());
            }
        }

        // "Root" for the walk callback: the set of entity names from meta.json.
        // Validates referenced-entity sanity without dragging in MetaRoot.
        Set<String> entityNames = new HashSet<>();
        for (JsonNode e : meta.get("entities")) {
            entityNames.add(e.get("name").asText());
        }
        for (String ref : referencedEntities) {
            assertTrue("walk.json references unknown entity: " + ref, entityNames.contains(ref));
        }

        Provider provider = new InMemoryProvider(Map.of("conformance/template", templateBody));
        List<EmittedFile> files = TemplateGenerator.generate(
            name,
            "conformance/template",
            (Set<String> root) -> walkEntries,
            provider,
            meta.get("format").asText(),
            entityNames);

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
