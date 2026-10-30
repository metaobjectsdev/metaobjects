package com.metaobjects.library;

import static org.junit.Assert.assertEquals;

import java.util.List;
import java.util.Map;
import org.junit.Test;

/** The manifest reader is a JSON parser, not a pattern: braces and quotes inside strings are data. */
public class LibrarySourcesManifestTest {

    private static final String MANIFEST = "{\n"
        + "  \"description\": \"has } and ] and \\\"layers\\\" inside\",\n"
        + "  \"generators\": [ { \"anchor\": \"a::B\", \"name\": \"g\", \"note\": \"x}y\" } ],\n"
        + "  \"layers\": {\n"
        + "    \"\": { \"description\": \"core } here\", \"refs\": [\"x/model\", \"x/req\"] },\n"
        + "    \"db\": { \"refs\": [\"x/db\"] }\n"
        + "  }\n"
        + "}";

    @Test
    public void layersSurviveBracesInsideStrings() {
        Map<String, List<String>> layers = LibrarySources.parseLayers(MANIFEST);
        assertEquals(List.of("x/model", "x/req"), layers.get(""));
        assertEquals(List.of("x/db"), layers.get("db"));
    }

    @Test
    public void generatorAnchorReadsKeysInAnyOrder() {
        assertEquals(List.of("a::B"), LibrarySources.generatorAnchors(MANIFEST, "g"));
        assertEquals(List.of(), LibrarySources.generatorAnchors(MANIFEST, "other"));
    }
}
