package com.metaobjects.render;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * Verify-conformance corpus runner — the cross-language template-drift
 * guarantee. Each fixture dir under {@code fixtures/verify-conformance/} holds:
 *
 * <ul>
 *   <li>{@code payload.json}        the payload FIELD-TREE
 *       ({@code PayloadField[]} — declared shape, not render data)</li>
 *   <li>{@code template.mustache}   the template text whose vars are drift-checked</li>
 *   <li>{@code partials/*.mustache} optional partial bodies, referenced as
 *       {@code partials/<name>}</li>
 *   <li>{@code options.json}        optional
 *       {@code { "requiredSlots"?, "requiredTags"?, "provider"?: "with" | "without" }}</li>
 *   <li>{@code expected-drift.json} array of {@code { "code", "path" }} findings
 *       (compared as a sorted multiset)</li>
 * </ul>
 *
 * <p>The same (payload-tree + template + options) MUST yield the same drift set
 * in TS, C#, and Java. 1:1 port of
 * {@code server/csharp/MetaObjects.Render.Tests/VerifyConformanceTests.cs} and
 * {@code server/typescript/packages/render/test/verify-conformance.test.ts}.
 */
@RunWith(Parameterized.class)
public class VerifyConformanceTest {

    private static final Path CORPUS_ROOT;
    private static final ObjectMapper JSON = new ObjectMapper();

    /**
     * Stable verify codes a fixture may legitimately expect (typo guard).
     * Cross-port: documented in {@code fixtures/conformance/ERROR-CODES.json}.
     */
    private static final Set<String> VERIFY_CODES = Set.of(
        Verify.ERR_VAR_NOT_ON_PAYLOAD,
        Verify.ERR_PARTIAL_UNRESOLVED,
        Verify.ERR_REQUIRED_SLOT_UNUSED,
        Verify.ERR_OUTPUT_TAG_MISSING
    );

    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/verify-conformance"))) {
            p = p.getParent();
        }
        CORPUS_ROOT = p == null ? null : p.resolve("fixtures/verify-conformance");
    }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> fixtures() throws IOException {
        if (CORPUS_ROOT == null || !Files.isDirectory(CORPUS_ROOT)) return List.of();
        try (Stream<Path> s = Files.list(CORPUS_ROOT)) {
            return s.filter(Files::isDirectory)
                    .sorted()
                    .map(p -> new Object[]{p.getFileName().toString(), p})
                    .collect(Collectors.toList());
        }
    }

    private final String name;
    private final Path fixtureDir;

    public VerifyConformanceTest(String name, Path fixtureDir) {
        this.name = name;
        this.fixtureDir = fixtureDir;
    }

    @Test
    public void verifyMatchesExpected() throws IOException {
        Path templatePath = fixtureDir.resolve("template.mustache");
        Path payloadPath = fixtureDir.resolve("payload.json");
        Path expectedPath = fixtureDir.resolve("expected-drift.json");
        Path optionsPath = fixtureDir.resolve("options.json");
        Path partialsDir = fixtureDir.resolve("partials");

        assertTrue("missing template: " + templatePath, Files.isRegularFile(templatePath));
        assertTrue("missing payload: " + payloadPath, Files.isRegularFile(payloadPath));
        assertTrue("missing expected-drift: " + expectedPath, Files.isRegularFile(expectedPath));

        String template = Files.readString(templatePath, StandardCharsets.UTF_8);
        List<PayloadField> fields = parseFields(JSON.readTree(payloadPath.toFile()));

        // options.json (optional): requiredSlots + requiredTags + provider toggle.
        List<String> requiredSlots = null;
        List<String> requiredTags = null;
        String providerMode = null;
        if (Files.isRegularFile(optionsPath)) {
            JsonNode opts = JSON.readTree(optionsPath.toFile());
            if (opts.has("requiredSlots") && opts.get("requiredSlots").isArray()) {
                requiredSlots = stringArray(opts.get("requiredSlots"));
            }
            if (opts.has("requiredTags") && opts.get("requiredTags").isArray()) {
                requiredTags = stringArray(opts.get("requiredTags"));
            }
            if (opts.has("provider") && opts.get("provider").isTextual()) {
                providerMode = opts.get("provider").asText();
            }
        }

        // Provider: "with" → build from partials/ (empty map if none); "without" → none.
        // Default: "with" iff a partials/ dir exists. The unresolved-partial case
        // sets provider:"with" with no partials/ dir (an empty provider resolves nothing).
        String mode = providerMode != null
            ? providerMode
            : (Files.isDirectory(partialsDir) ? "with" : "without");
        Provider provider = "with".equals(mode) ? providerFromPartials(partialsDir) : null;

        List<VerifyError> expected = parseExpected(JSON.readTree(expectedPath.toFile()));
        // Lint: every expected code is a known verify code (typo guard).
        for (VerifyError e : expected) {
            assertTrue("unknown verify code in expected-drift.json: " + e.code(),
                VERIFY_CODES.contains(e.code()));
        }

        VerifyOptions options = new VerifyOptions(provider, requiredSlots, requiredTags);
        List<VerifyError> actual = Verify.check(template, fields, options);

        assertEquals(name + ": drift mismatch", sorted(expected), sorted(actual));
        // Determinism: identical across runs.
        assertEquals(name + ": non-deterministic",
            actual, Verify.check(template, fields, options));
    }

    // ----- helpers -----

    private static List<PayloadField> parseFields(JsonNode array) {
        List<PayloadField> out = new ArrayList<>();
        for (JsonNode el : array) out.add(parseField(el));
        return out;
    }

    private static PayloadField parseField(JsonNode el) {
        String name = el.get("name").asText();
        if (el.has("fields") && el.get("fields").isArray()) {
            return new PayloadField(name, parseFields(el.get("fields")));
        }
        return PayloadField.scalar(name);
    }

    private static List<String> stringArray(JsonNode array) {
        List<String> out = new ArrayList<>();
        for (JsonNode el : array) out.add(el.asText());
        return out;
    }

    private static Provider providerFromPartials(Path partialsDir) throws IOException {
        Map<String, String> map = new LinkedHashMap<>();
        if (Files.isDirectory(partialsDir)) {
            try (Stream<Path> s = Files.list(partialsDir)) {
                for (Path f : (Iterable<Path>) s.filter(Files::isRegularFile)
                        .filter(p -> p.getFileName().toString().endsWith(".mustache"))::iterator) {
                    String name = f.getFileName().toString().replaceFirst("\\.mustache$", "");
                    map.put("partials/" + name, Files.readString(f, StandardCharsets.UTF_8));
                }
            }
        }
        return new InMemoryProvider(map);
    }

    private static List<VerifyError> parseExpected(JsonNode array) {
        List<VerifyError> out = new ArrayList<>();
        for (JsonNode el : array) {
            out.add(new VerifyError(el.get("code").asText(), el.get("path").asText()));
        }
        return out;
    }

    /** (code, path) ordinal sort for multiset equality. */
    private static List<VerifyError> sorted(List<VerifyError> errs) {
        List<VerifyError> copy = new ArrayList<>(errs);
        copy.sort(Comparator.comparing(VerifyError::code).thenComparing(VerifyError::path));
        return copy;
    }
}
