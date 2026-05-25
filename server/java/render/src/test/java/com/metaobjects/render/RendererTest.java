package com.metaobjects.render;

import org.junit.Test;

import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

public class RendererTest {

    @Test
    public void simpleVariableSubstitution() {
        var req = new RenderRequest(
            "Hello {{name}}!", null, Map.of("name", "Ada"),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("Hello Ada!", new Renderer().render(req));
    }

    @Test
    public void sectionIteration() {
        var req = new RenderRequest(
            "{{#items}}- {{.}}\n{{/items}}", null,
            Map.of("items", List.of("a", "b", "c")),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("- a\n- b\n- c\n", new Renderer().render(req));
    }

    @Test
    public void partialResolvedViaProvider() {
        var req = new RenderRequest(
            "<doc>\n{{> shared/header }}\nbody\n</doc>", null,
            Map.of(),
            new InMemoryProvider(Map.of("shared/header", "HEADER")),
            "text", null, null);
        // Partial pre-expansion happens BEFORE Mustache parse;
        // exact whitespace per pre-expanded text + Mustache rendering.
        assertTrue(new Renderer().render(req).contains("HEADER"));
    }

    @Test
    public void nestedPartials() {
        var req = new RenderRequest(
            "{{> a/outer }}", null,
            Map.of(),
            new InMemoryProvider(Map.of(
                "a/outer", "OUTER:{{> a/inner }}",
                "a/inner", "INNER"
            )),
            "text", null, null);
        assertEquals("OUTER:INNER", new Renderer().render(req));
    }

    @Test(expected = RenderException.class)
    public void cyclicPartialDetected() {
        var req = new RenderRequest(
            "{{> a/x }}", null, Map.of(),
            new InMemoryProvider(Map.of(
                "a/x", "X{{> a/y }}",
                "a/y", "Y{{> a/x }}"
            )),
            "text", null, null);
        new Renderer().render(req);
    }

    @Test(expected = RenderException.class)
    public void unresolvedPartialDetected() {
        var req = new RenderRequest(
            "{{> missing/x }}", null, Map.of(),
            new InMemoryProvider(Map.of()),
            "text", null, null);
        new Renderer().render(req);
    }

    @Test
    public void htmlEscapingHappensInOurLayer() {
        var req = new RenderRequest(
            "{{value}}", null, Map.of("value", "<b>&</b>"),
            new InMemoryProvider(Map.of()), "html", null, null);
        // Triple-mustache bypass NOT used here; output is escaped by Escapers.
        assertEquals("&lt;b&gt;&amp;&lt;/b&gt;", new Renderer().render(req));
    }

    @Test
    public void maxCharsTruncates() {
        var req = new RenderRequest(
            "{{x}}", null, Map.of("x", "abcdefghij"),
            new InMemoryProvider(Map.of()), "text", null, 5);
        assertEquals("abcde", new Renderer().render(req));
    }

    @Test
    public void refResolvedViaProvider() {
        var req = new RenderRequest(
            null, "g/s", Map.of("n", "x"),
            new InMemoryProvider(Map.of("g/s", "n={{n}}")),
            "text", null, null);
        assertEquals("n=x", new Renderer().render(req));
    }

    @Test(expected = RenderException.class)
    public void neitherTemplateNorRefSetRejected() {
        var req = new RenderRequest(
            null, null, Map.of(),
            new InMemoryProvider(Map.of()),
            "text", null, null);
        new Renderer().render(req);
    }

    @Test(expected = RenderException.class)
    public void bothTemplateAndRefSetRejected() {
        var req = new RenderRequest(
            "inline", "g/s", Map.of(),
            new InMemoryProvider(Map.of("g/s", "via-ref")),
            "text", null, null);
        new Renderer().render(req);
    }
}
