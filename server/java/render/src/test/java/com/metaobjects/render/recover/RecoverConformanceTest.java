package com.metaobjects.render.recover;

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
public class RecoverConformanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Path CORPUS;
    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/recover-conformance"))) p = p.getParent();
        CORPUS = p == null ? null : p.resolve("fixtures/recover-conformance");
    }

    private final Path dir;
    public RecoverConformanceTest(String name, Path dir) { this.dir = dir; }

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
        RecoverSchema schema = parseSchema(JSON.readTree(dir.resolve("schema.json").toFile()));
        String input = Files.readString(dir.resolve("input.txt"));
        JsonNode expected = JSON.readTree(dir.resolve("expected.json").toFile());

        RecoverOutcome out = Recover.recover(input, schema, RecoverOptions.defaults());

        assertEquals(dir + " empty flag", expected.get("empty").asBoolean(), out.report().isEmpty());

        JsonNode states = expected.get("states");
        states.fieldNames().forEachRemaining(path ->
            assertEquals(dir + " state[" + path + "]",
                    states.get(path).asText(), String.valueOf(out.report().states().get(path))));

        JsonNode data = expected.get("data");
        data.fieldNames().forEachRemaining(field ->
            assertCanonical(dir + " data[" + field + "]", data.get(field), out.data().get(field)));

        // Exhaustive key-set checks: no missing, no extra entries in either map.
        Set<String> expectedStateKeys = new LinkedHashSet<>();
        states.fieldNames().forEachRemaining(expectedStateKeys::add);
        assertEquals(dir + " state key set", expectedStateKeys, out.report().states().keySet());

        Set<String> expectedDataKeys = new LinkedHashSet<>();
        data.fieldNames().forEachRemaining(expectedDataKeys::add);
        assertEquals(dir + " data key set", expectedDataKeys, out.data().keySet());
    }

    /**
     * Canonical comparison: numbers within 1e-9 tolerance; scalars string-equal.
     *
     * <p>FR-011: object/array expected values in the corpus are deliberate PLACEHOLDERS
     * ({@code {}} / {@code [{},{}]}) — the cross-port runner stringifies both sides loosely,
     * so a nested-object / array-of-objects field's real assertion lives in the per-field
     * states (e.g. {@code meta.score} / {@code items[i].label}), not its top-level data value.
     * Mirror that here by asserting only structural correspondence (map ↔ object, list ↔ array).</p>
     */
    private static void assertCanonical(String msg, JsonNode expected, Object actual) {
        if (expected.isNumber() && actual instanceof Number n) {
            assertEquals(msg, expected.asDouble(), n.doubleValue(), 1e-9);
        } else if (expected.isObject()) {
            assertTrue(msg + ": expected an object but got "
                    + (actual == null ? "null" : actual.getClass().getSimpleName()),
                    actual instanceof Map);
        } else if (expected.isArray()) {
            assertTrue(msg + ": expected an array but got "
                    + (actual == null ? "null" : actual.getClass().getSimpleName()),
                    actual instanceof List);
        } else {
            assertEquals(msg, expected.asText(), String.valueOf(actual));
        }
    }

    private static RecoverSchema parseSchema(JsonNode n) {
        Format fmt = Format.valueOf(n.get("format").asText());
        String root = n.get("rootName").asText();
        List<FieldSpec> fields = new ArrayList<>();
        for (JsonNode f : n.get("fields")) fields.add(parseField(f));
        return new RecoverSchema(fmt, root, fields);
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
            return FieldSpec.enumField(name, req, vals, aliases, coerceDefault, normalize, defaultValue);
        }
        if (kind == FieldKind.OBJECT) {
            boolean array = f.has("array") && f.get("array").asBoolean();
            RecoverSchema nested = null;
            if (f.has("fields")) {
                List<FieldSpec> childSpecs = new ArrayList<>();
                for (JsonNode nf : f.get("fields")) childSpecs.add(parseField(nf));
                nested = new RecoverSchema(Format.JSON, name, childSpecs);
            }
            return FieldSpec.object(name, req, array, nested);
        }
        if (f.has("min") || f.has("max")) {
            Double min = f.has("min") ? f.get("min").asDouble() : null;
            Double max = f.has("max") ? f.get("max").asDouble() : null;
            return FieldSpec.range(name, kind, req, min, max);
        }
        return FieldSpec.scalar(name, kind, req);
    }

    /** FR-011: parse the {@code @normalize} mode string; absent → the global default "strip". */
    private static String parseNormalize(String s) {
        if (s == null) return Normalize.DEFAULT;
        if (Normalize.NONE.equals(s) || Normalize.COLLAPSE.equals(s) || Normalize.STRIP.equals(s)) return s;
        throw new IllegalArgumentException("Unknown normalize mode: " + s);
    }
}
