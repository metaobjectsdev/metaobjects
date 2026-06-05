package com.metaobjects.render.extract;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

@RunWith(Parameterized.class)
public class ExtractConformanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CORPUS;
    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/extract-conformance"))) p = p.getParent();
        CORPUS = p == null ? null : p.resolve("fixtures/extract-conformance");
    }

    private final Path dir;
    public ExtractConformanceTest(String name, Path dir) { this.dir = dir; }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> cases() throws IOException {
        if (CORPUS == null || !Files.isDirectory(CORPUS)) return List.of();
        try (Stream<Path> s = Files.list(CORPUS)) {
            return s.filter(Files::isDirectory).sorted()
                    .map(d -> new Object[]{ d.getFileName().toString(), d })
                    .collect(Collectors.toList());
        }
    }

    @Test
    public void classificationAndCanonicalValueMatch() throws IOException {
        JsonNode schemaNode = JSON.readTree(dir.resolve("schema.json").toFile());
        ExtractSchema schema = parseSchema(schemaNode);
        String input = Files.readString(dir.resolve("input.txt"));
        JsonNode expected = JSON.readTree(dir.resolve("expected.json").toFile());

        // Optional per-fixture parse option: "rootless": true → XML response has no wrapper root
        // (a flat top-level element sequence). Other ports without this option will fail this
        // fixture — an intentional cross-port "fix me" gate.
        ExtractOptions opts = ExtractOptions.defaults();
        if (schemaNode.has("rootless") && schemaNode.get("rootless").asBoolean()) {
            opts = opts.withRootless(true);
        }
        ExtractionOutcome out = Extract.extract(input, schema, opts);

        assertEquals(dir + " empty flag", expected.get("empty").asBoolean(), out.report().isEmpty());

        JsonNode states = expected.get("states");
        states.fieldNames().forEachRemaining(path ->
            assertEquals(dir + " state[" + path + "]",
                    states.get(path).asText(), String.valueOf(out.report().states().get(path))));

        // Data is compared as a flat DOTTED-LEAF map (mirroring states): nested objects and
        // arrays are flattened to leaf paths (meta.score, items[0].label, tags[0], …) and every
        // leaf VALUE is asserted — including scalar-array elements and nested-object leaves.
        Map<String, Object> actualLeaves = new java.util.LinkedHashMap<>();
        flattenLeaves("", out.data(), actualLeaves);

        JsonNode data = expected.get("data");
        data.fieldNames().forEachRemaining(path ->
            assertCanonical(dir + " data[" + path + "]", data.get(path), actualLeaves.get(path)));

        // Exhaustive key-set checks: no missing, no extra entries in either map.
        Set<String> expectedStateKeys = new LinkedHashSet<>();
        states.fieldNames().forEachRemaining(expectedStateKeys::add);
        assertEquals(dir + " state key set", expectedStateKeys, out.report().states().keySet());

        Set<String> expectedDataKeys = new LinkedHashSet<>();
        data.fieldNames().forEachRemaining(expectedDataKeys::add);
        assertEquals(dir + " data key set", expectedDataKeys, actualLeaves.keySet());
    }

    /**
     * Flatten an assembled-data value into dotted leaf paths: maps recurse by key
     * ({@code prefix.key}), lists recurse by index ({@code prefix[i]}), and every terminal
     * scalar is recorded. Mirrors how the engine enumerates per-field states, so the data
     * leaf-set lines up 1:1 with the states leaf-set (minus dropped/malformed leaves).
     */
    private static void flattenLeaves(String prefix, Object value, Map<String, Object> out) {
        if (value instanceof Map<?, ?> m) {
            for (Map.Entry<?, ?> e : m.entrySet()) {
                String key = prefix.isEmpty() ? String.valueOf(e.getKey()) : prefix + "." + e.getKey();
                flattenLeaves(key, e.getValue(), out);
            }
        } else if (value instanceof List<?> list) {
            for (int i = 0; i < list.size(); i++) {
                flattenLeaves(prefix + "[" + i + "]", list.get(i), out);
            }
        } else {
            out.put(prefix, value);
        }
    }

    /** Canonical leaf comparison: numbers within 1e-9 tolerance; everything else string-equal. */
    private static void assertCanonical(String msg, JsonNode expected, Object actual) {
        if (expected.isNumber() && actual instanceof Number n) {
            assertEquals(msg, expected.asDouble(), n.doubleValue(), 1e-9);
        } else {
            assertEquals(msg, expected.asText(), String.valueOf(actual));
        }
    }

    private static ExtractSchema parseSchema(JsonNode n) {
        Format fmt = Format.valueOf(n.get("format").asText());
        String root = n.get("rootName").asText();
        List<FieldSpec> fields = new ArrayList<>();
        for (JsonNode f : n.get("fields")) fields.add(parseField(f));
        return new ExtractSchema(fmt, root, fields);
    }

    private static FieldSpec parseField(JsonNode f) {
        String name = f.get("name").asText();
        FieldKind kind = FieldKind.valueOf(f.get("kind").asText());
        boolean req = f.has("required") && f.get("required").asBoolean();
        if (kind == FieldKind.ENUM) {
            List<String> vals = new ArrayList<>();
            if (f.has("enumValues")) f.get("enumValues").forEach(v -> vals.add(v.asText()));
            Map<String, String> aliases = new java.util.LinkedHashMap<>();
            if (f.has("enumAlias"))
                f.get("enumAlias").fields().forEachRemaining(e -> aliases.put(e.getKey(), e.getValue().asText()));
            // FR-011: optional coerceDefault / normalize / default keys.
            String coerceDefault = f.has("coerceDefault") ? f.get("coerceDefault").asText() : null;
            String normalize = parseNormalize(f.has("normalize") ? f.get("normalize").asText() : null);
            String defaultValue = f.has("default") ? f.get("default").asText() : null;
            // Phase B (array-of-enum): kind:"ENUM" + array:true → List<enum>, each element
            // coerced through the enum pipeline and classified by indexed path.
            boolean array = f.has("array") && f.get("array").asBoolean();
            return array
                    ? FieldSpec.enumArray(name, req, vals, aliases, coerceDefault, normalize, defaultValue)
                    : FieldSpec.enumField(name, req, vals, aliases, coerceDefault, normalize, defaultValue);
        }
        if (kind == FieldKind.OBJECT) {
            boolean array = f.has("array") && f.get("array").asBoolean();
            ExtractSchema nested = null;
            if (f.has("fields")) {
                List<FieldSpec> childSpecs = new ArrayList<>();
                for (JsonNode nf : f.get("fields")) childSpecs.add(parseField(nf));
                nested = new ExtractSchema(Format.JSON, name, childSpecs);
            }
            return FieldSpec.object(name, req, array, nested);
        }
        if (f.has("min") || f.has("max")) {
            Double min = f.has("min") ? f.get("min").asDouble() : null;
            Double max = f.has("max") ? f.get("max").asDouble() : null;
            return FieldSpec.range(name, kind, req, min, max);
        }
        // @xmlText: a scalar field that receives its element's text content (the #text sentinel).
        if (f.has("textContent") && f.get("textContent").asBoolean()) {
            return FieldSpec.textContentField(name, kind, req);
        }
        // Phase B: a scalar field may carry a generalized @default absent-fill string.
        String defaultValue = f.has("default") ? f.get("default").asText() : null;
        return FieldSpec.scalar(name, kind, req, defaultValue);
    }

    /** FR-011: parse the {@code @normalize} mode string; absent → the global default "strip". */
    private static String parseNormalize(String s) {
        if (s == null) return Normalize.DEFAULT;
        if (Normalize.NONE.equals(s) || Normalize.COLLAPSE.equals(s) || Normalize.STRIP.equals(s)) return s;
        throw new IllegalArgumentException("Unknown normalize mode: " + s);
    }
}
