package com.metaobjects.render.prompt;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.metaobjects.render.recover.FieldKind;
import com.metaobjects.render.recover.FieldRecovery;
import com.metaobjects.render.recover.FieldSpec;
import com.metaobjects.render.recover.Format;
import com.metaobjects.render.recover.Recover;
import com.metaobjects.render.recover.RecoverOptions;
import com.metaobjects.render.recover.RecoverOutcome;
import com.metaobjects.render.recover.RecoverSchema;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;

/**
 * Cross-port byte-identity gate for the FR-010 output-format prompt fragment.
 *
 * <p>Reproduces every reference {@code expected.<style>.txt} in the shared corpus at
 * {@code fixtures/output-prompt-conformance/} using Java's {@link OutputFormatRenderer},
 * proving the Java renderer is byte-for-byte identical to the TS reference (and the C# port).
 * For {@code roundTrip} cases, also asserts the emitted example reads back cleanly through
 * {@link Recover} (no MALFORMED / LOST_* states).</p>
 *
 * <p>The corpus is the oracle: assertions are ordinal {@link String} equality on raw UTF-8
 * bytes with no newline translation.</p>
 */
@RunWith(Parameterized.class)
public class OutputPromptConformanceTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** Count guard: a port silently skipping cases must fail. Bump when adding cases. */
    private static final int EXPECTED_CASE_COUNT = 10;

    private static final Path CORPUS;
    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/output-prompt-conformance"))) p = p.getParent();
        CORPUS = p == null ? null : p.resolve("fixtures/output-prompt-conformance");
    }

    private record StyleSpec(String key, PromptStyle style) {}

    private static final List<StyleSpec> STYLES = List.of(
            new StyleSpec("guide", PromptStyle.GUIDE),
            new StyleSpec("inline", PromptStyle.INLINE),
            new StyleSpec("exampleOnly", PromptStyle.EXAMPLE_ONLY));

    private final Path dir;
    public OutputPromptConformanceTest(String name, Path dir) { this.dir = dir; }

    @Parameterized.Parameters(name = "{0}")
    public static List<Object[]> cases() throws IOException {
        if (CORPUS == null || !Files.isDirectory(CORPUS)) return List.of();
        try (Stream<Path> s = Files.list(CORPUS)) {
            return s.filter(Files::isDirectory)
                    .filter(d -> Files.exists(d.resolve("spec.json")))
                    .sorted()
                    .map(d -> new Object[]{ d.getFileName().toString(), d })
                    .collect(Collectors.toList());
        }
    }

    @BeforeClass
    public static void countGuard() throws IOException {
        assertEquals("output-prompt-conformance case count", EXPECTED_CASE_COUNT, cases().size());
    }

    @Test
    public void reproducesCorpusBytes() throws IOException {
        JsonNode spec = JSON.readTree(dir.resolve("spec.json").toFile());
        OutputFormatSpec ofs = buildOutputSpec(spec);

        for (StyleSpec style : STYLES) {
            PromptOverrides overrides = new PromptOverrides(style.style(), Map.of(), Map.of());
            String actual = OutputFormatRenderer.render(ofs, overrides);
            String expected = readUtf8(dir.resolve("expected." + style.key() + ".txt"));
            assertEquals(dir + " style[" + style.key() + "]", expected, actual);
            // determinism: identical across runs
            assertEquals(dir + " style[" + style.key() + "] (determinism)",
                    actual, OutputFormatRenderer.render(ofs, overrides));
        }

        if (spec.has("roundTrip") && spec.get("roundTrip").asBoolean()) {
            String exampleFragment = readUtf8(dir.resolve("expected.exampleOnly.txt"));
            RecoverOutcome outcome = Recover.recover(exampleFragment, buildRecoverSchema(spec), RecoverOptions.defaults());
            // Skew guard: a field the renderer emitted must read back cleanly. Assert NO state
            // is MALFORMED or LOST_* (robust to DEFAULTED and to how a nested OBJECT-container
            // path classifies); any such state means the renderer emitted an example the recover
            // parser cannot read.
            for (Map.Entry<String, FieldRecovery> e : outcome.report().states().entrySet()) {
                FieldRecovery state = e.getValue();
                boolean bad = state == FieldRecovery.MALFORMED
                        || state == FieldRecovery.LOST_REQUIRED
                        || state == FieldRecovery.LOST_OPTIONAL;
                assertFalse(dir + " roundTrip state[" + e.getKey() + "]=" + state, bad);
            }
        }
    }

    private static String readUtf8(Path p) throws IOException {
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    // ----- descriptor (spec.json) -> renderer/recover model -----

    private static OutputFormatSpec buildOutputSpec(JsonNode c) {
        Format fmt = toFormat(c.get("format").asText());
        String root = c.get("rootName").asText();
        List<PromptField> fields = new ArrayList<>();
        for (JsonNode f : c.get("fields")) fields.add(buildPromptField(f));
        // style is a placeholder; each render overrides it per style.
        return new OutputFormatSpec(fmt, root, PromptStyle.GUIDE, fields);
    }

    private static PromptField buildPromptField(JsonNode f) {
        String name = f.get("name").asText();
        FieldKind kind = FieldKind.valueOf(f.get("kind").asText());
        boolean required = f.has("required") && f.get("required").asBoolean();
        boolean array = f.has("array") && f.get("array").asBoolean();
        List<String> enumValues = null;
        if (f.has("enumValues") && !f.get("enumValues").isNull()) {
            enumValues = new ArrayList<>();
            for (JsonNode v : f.get("enumValues")) enumValues.add(v.asText());
        }
        Map<String, String> enumDoc = null;
        if (f.has("enumDoc") && !f.get("enumDoc").isNull()) {
            Map<String, String> m = new java.util.LinkedHashMap<>();
            f.get("enumDoc").fields().forEachRemaining(e -> m.put(e.getKey(), e.getValue().asText()));
            enumDoc = m;
        }
        String example = f.has("example") && !f.get("example").isNull() ? f.get("example").asText() : null;
        String instruction = f.has("instruction") && !f.get("instruction").isNull() ? f.get("instruction").asText() : null;
        OutputFormatSpec nested = f.has("nested") && !f.get("nested").isNull() ? buildOutputSpec(f.get("nested")) : null;
        return new PromptField(name, kind, required, array, enumValues, enumDoc, example, instruction, nested);
    }

    private static RecoverSchema buildRecoverSchema(JsonNode c) {
        Format fmt = toFormat(c.get("format").asText());
        String root = c.get("rootName").asText();
        List<FieldSpec> fields = new ArrayList<>();
        for (JsonNode f : c.get("fields")) fields.add(buildFieldSpec(f));
        return new RecoverSchema(fmt, root, fields);
    }

    private static FieldSpec buildFieldSpec(JsonNode f) {
        String name = f.get("name").asText();
        FieldKind kind = FieldKind.valueOf(f.get("kind").asText());
        boolean required = f.has("required") && f.get("required").asBoolean();
        boolean array = f.has("array") && f.get("array").asBoolean();
        if (kind == FieldKind.ENUM) {
            List<String> vals = null;
            if (f.has("enumValues") && !f.get("enumValues").isNull()) {
                vals = new ArrayList<>();
                for (JsonNode v : f.get("enumValues")) vals.add(v.asText());
            }
            return FieldSpec.enumField(name, required, vals, Map.of());
        }
        if (kind == FieldKind.OBJECT) {
            RecoverSchema nested = f.has("nested") && !f.get("nested").isNull() ? buildRecoverSchema(f.get("nested")) : null;
            return FieldSpec.object(name, required, array, nested);
        }
        return FieldSpec.scalar(name, kind, required);
    }

    private static Format toFormat(String f) {
        return "json".equals(f) ? Format.JSON : Format.XML;
    }
}
