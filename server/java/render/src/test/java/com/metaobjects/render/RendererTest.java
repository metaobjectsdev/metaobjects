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
    public void namesTheReferenceResolvesDoNotRaiseAsMissing() {
        // The engine follows the reference (TypeScript on mustache.js): a dotted name is tried
        // whole against each context, and a list's length is a property.
        var shadowed = new RenderRequest(
            "{{#items}}[{{a.b}}]{{/items}}", null,
            Map.of("a", Map.of("b", 1), "items", List.of(Map.of("a", Map.of("c", 2)))),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("[1]", new Renderer().render(shadowed));

        var length = new RenderRequest(
            "count: {{items.length}}", null, Map.of("items", List.of(1, 2, 3)),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("count: 3", new Renderer().render(length));
    }

    @Test
    public void aZeroOrNaNNumberIsFalsyForASection() {
        var zero = new RenderRequest(
            "{{#n}}yes{{/n}}{{^n}}zero{{/n}} printed: {{n}}", null,
            Map.of("n", 0),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("zero printed: 0", new Renderer().render(zero));

        // No JSON payload can carry NaN, so the shared corpus cannot pin it.
        var nan = new RenderRequest(
            "{{#n}}yes{{/n}}{{^n}}zero{{/n}}", null,
            Map.of("n", Double.NaN),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("zero", new Renderer().render(nan));
    }

    /** A value object's generated record, as a template's payload (ADR-0056). */
    public record Tag(String label) {}
    public record Profile(String bio, Integer count, List<Tag> tags, Tag sponsor) {}

    @Test
    public void derivedHasSectionsResolveOnARecordPayload() {
        // A record declares no has<Field>() methods, so the engine derives them exactly as it
        // does for a map — the same data renders the same whatever its shape.
        String tpl = "{{#hasBio}}[{{bio}}]{{/hasBio}}{{^hasBio}}[no bio]{{/hasBio}}"
            + "{{#hasTags}}{{#tags}}<{{label}}>{{/tags}}{{/hasTags}}{{^hasTags}}<none>{{/hasTags}}"
            + "{{#hasSponsor}}{{sponsor.label}}{{/hasSponsor}}{{count}}";
        var full = new RenderRequest(tpl, null,
            new Profile("hi", 3, List.of(new Tag("a"), new Tag("b")), new Tag("s")),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("[hi]<a><b>s3", new Renderer().render(full));

        var empty = new RenderRequest(tpl, null,
            new Profile("  ", 0, List.of(), null),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("[no bio]<none>0", new Renderer().render(empty));

        // The map form of the same data renders identically.
        java.util.Map<String, Object> asMap = new java.util.LinkedHashMap<>();
        asMap.put("bio", "hi");
        asMap.put("count", 3);
        asMap.put("tags", List.of(Map.of("label", "a"), Map.of("label", "b")));
        asMap.put("sponsor", Map.of("label", "s"));
        var mapReq = new RenderRequest(tpl, null, asMap,
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals(new Renderer().render(full), new Renderer().render(mapReq));
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
    public void maxCharsWithinBudgetReturnsNormally() {
        // 10-char output, budget of 10 — exactly at the budget is allowed.
        var req = new RenderRequest(
            "{{x}}", null, Map.of("x", "abcdefghij"),
            new InMemoryProvider(Map.of()), "text", null, 10);
        assertEquals("abcdefghij", new Renderer().render(req));
    }

    @Test
    public void maxCharsOverBudgetThrows() {
        // 10-char output, budget of 5 — over budget → THROW (fail-closed, never
        // truncates). Message shape matches TS/C#/Python.
        var req = new RenderRequest(
            "{{x}}", null, Map.of("x", "abcdefghij"),
            new InMemoryProvider(Map.of()), "text", null, 5);
        try {
            new Renderer().render(req);
            org.junit.Assert.fail("expected RenderException for over-budget output");
        } catch (RenderException e) {
            assertEquals("render exceeded maxChars budget: 10 > 5", e.getMessage());
        }
    }

    @Test
    public void maxCharsNullNoGuard() {
        // No budget set → long output renders without throwing.
        var req = new RenderRequest(
            "{{x}}", null, Map.of("x", "abcdefghij"),
            new InMemoryProvider(Map.of()), "text", null, null);
        assertEquals("abcdefghij", new Renderer().render(req));
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
