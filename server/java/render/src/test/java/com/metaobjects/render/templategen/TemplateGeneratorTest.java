package com.metaobjects.render.templategen;

import com.metaobjects.render.InMemoryProvider;
import com.metaobjects.render.Provider;
import org.junit.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for the Java TemplateGenerator factory.
 * Mirrors C# TemplateGeneratorTests, Python test_template_generator.py,
 * TS template-generator.test.ts.
 *
 * <p>These tests use plain Map-based "root" payloads instead of
 * com.metaobjects.MetaRoot because (a) the factory is generic over root
 * type, and (b) the render module doesn't depend on the metadata module.
 * The cross-port conformance harness in TemplateGeneratorConformanceTest
 * uses the same approach.
 */
public class TemplateGeneratorTest {

    private static Provider provider(Map<String, String> map) {
        return new InMemoryProvider(map);
    }

    @Test
    public void perEntityWalkEmitsOneFilePerEntity() {
        // The "root" here is a simple list of entities — mirrors what a real
        // MetaRoot.getChildrenOfType("object") would yield, without dragging
        // in the metadata module.
        List<String> entityNames = List.of("Post");

        List<EmittedFile> files = TemplateGenerator.generate(
            "hello",
            "custom/hello",
            (List<String> names) -> names.stream()
                .map(n -> new TemplateWalkResult(Map.of("name", n), n + ".txt"))
                .toList(),
            provider(Map.of("custom/hello", "Hello {{name}}!\n")),
            entityNames);

        assertEquals(1, files.size());
        assertEquals("Post.txt", files.get(0).path());
        assertEquals("Hello Post!\n", files.get(0).content());
    }

    @Test
    public void aggregatorWalkEmitsSingleFileFromAllEntities() {
        List<String> entityNames = List.of("Post", "Comment");

        List<EmittedFile> files = TemplateGenerator.generate(
            "index",
            "custom/index",
            (List<String> names) -> {
                List<Map<String, String>> entities = names.stream()
                    .map(n -> Map.of("name", n))
                    .toList();
                return List.of(new TemplateWalkResult(
                    Map.of("entities", entities), "index.txt"));
            },
            provider(Map.of("custom/index",
                "Entities:\n{{#entities}}- {{name}}\n{{/entities}}")),
            entityNames);

        assertEquals(1, files.size());
        assertEquals("index.txt", files.get(0).path());
        assertEquals("Entities:\n- Post\n- Comment\n", files.get(0).content());
    }

    @Test
    public void formatTextDoesNotEscapeHtml() {
        List<EmittedFile> files = TemplateGenerator.generate(
            "raw-text",
            "custom/raw",
            (Object root) -> List.of(new TemplateWalkResult(
                Map.of("snippet", "<p>hi</p>"), "out.txt")),
            provider(Map.of("custom/raw", "{{snippet}}\n")),
            "text",
            new Object());
        assertEquals("<p>hi</p>\n", files.get(0).content());
    }

    @Test
    public void formatHtmlEscapesHtmlInPayload() {
        List<EmittedFile> files = TemplateGenerator.generate(
            "raw-html",
            "custom/raw",
            (Object root) -> List.of(new TemplateWalkResult(
                Map.of("snippet", "<p>hi</p>"), "out.html")),
            provider(Map.of("custom/raw", "{{snippet}}\n")),
            "html",
            new Object());
        String content = files.get(0).content();
        assertNotEquals("<p>hi</p>\n", content);
        assertTrue("expected HTML escape in: " + content,
            content.contains("&lt;") || content.contains("&#60;"));
    }
}
