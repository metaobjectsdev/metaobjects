package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import javax.tools.DiagnosticCollector;
import javax.tools.JavaCompiler;
import javax.tools.JavaFileObject;
import javax.tools.ToolProvider;
import java.io.File;
import java.lang.reflect.Method;
import java.math.BigDecimal;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * The VALUE half of the scalar-coercion contract: the generated parser must not merely compile
 * against a kind-typed response record, it must put correctly-typed, correctly-VALUED objects in
 * it — and must degrade a malformed component to null instead of throwing.
 *
 * <p>{@link GeneratedScalarExtractLockStepTest} proves every subtype COMPILES. Compiling is not
 * the contract: a coercion that returned null for every input, or that lost decimal precision
 * through a double, would pass that test and still be wrong. So this one asserts values.
 */
public class GeneratedScalarExtractRoundTripTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static final String FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "InnerPayload", "children": [
                { "field.decimal": { "name": "nested" } }
            ] } },
            { "object.value": { "name": "WidePayload", "children": [
                { "field.string":    { "name": "ref", "@required": true } },
                { "field.decimal":   { "name": "money" } },
                { "field.float":     { "name": "ratio" } },
                { "field.currency":  { "name": "priceCents" } },
                { "field.date":      { "name": "due" } },
                { "field.timestamp": { "name": "at" } },
                { "field.uuid":      { "name": "id" } },
                { "field.object":    { "name": "inner", "@objectRef": "acme::ai::InnerPayload" } },
                { "field.decimal":   { "name": "rates", "isArray": true } },
                { "field.int":       { "name": "counts", "isArray": true } },
                { "field.decimal":   { "name": "bad" } },
                { "field.date":      { "name": "badDate" } }
            ] } },
            { "template.prompt": {
                "name": "Wide",
                "@payloadRef": "WidePayload",
                "@responseRef": "WidePayload",
                "@textRef": "ai/wide",
                "@format": "text",
                "@responseFormat": "json"
            } }
          ] }
        }
        """;

    @Test
    public void coercedScalarsCarryTheirValuesAndMalformedOnesBecomeNull() throws Exception {
        Path gen = tmp.newFolder("gen").toPath();
        Path ws  = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "wide-rt", FIXTURE);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        SpringPayloadGenerator pg = new SpringPayloadGenerator(); pg.setArgs(args); pg.execute(loader);
        SpringOutputParserGenerator og = new SpringOutputParserGenerator(); og.setArgs(args); og.execute(loader);

        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile)
                       .collect(Collectors.toList());
        }

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK required", javac);
        Path classes = tmp.newFolder("classes").toPath();
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        boolean ok = javac.getTask(null, fm, diags, List.of(
                "-classpath", System.getProperty("java.class.path"),
                "-d", classes.toString()), null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) sb.append("  ").append(d.getMessage(null)).append('\n');
            fail(sb.toString());
        }

        try (URLClassLoader cl = new URLClassLoader(new URL[]{ classes.toUri().toURL() },
                getClass().getClassLoader())) {
            Class<?> parser = cl.loadClass("acme.ai.prompts.WideParser");
            Method extract = parser.getMethod("extractLenient", MetaDataLoader.class, String.class);

            String dirty = "```json\n{"
                    + "\"ref\":\"W-1\","
                    + "\"money\":12.345,"
                    + "\"ratio\":0.25,"
                    + "\"priceCents\":1999,"
                    + "\"due\":\"2026-03-04\","
                    + "\"at\":\"2026-03-04T05:06:07Z\","
                    + "\"id\":\"3f2504e0-4f89-11d3-9a0c-0305e82c3301\","
                    + "\"inner\":{\"nested\":9.75},"
                    + "\"rates\":[1.25,2.5],"
                    + "\"counts\":[3,4],"
                    + "\"bad\":\"not-a-number\","
                    + "\"badDate\":\"31/12/2026\""
                    + "}\n```";

            Object result = extract.invoke(null, loader, dirty);
            Object p = result.getClass().getMethod("data").invoke(result);

            // --- decimal keeps full precision (a double round-trip would not) ---
            Object money = get(p, "money");
            assertTrue("money is BigDecimal", money instanceof BigDecimal);
            assertEquals("money precision", new BigDecimal("12.345"), money);

            // --- the other coerced natives ---
            assertEquals("ratio", Float.valueOf(0.25f), get(p, "ratio"));
            assertEquals("currency stays integer minor units (Long)", Long.valueOf(1999), get(p, "priceCents"));
            assertEquals("date", LocalDate.of(2026, 3, 4), get(p, "due"));
            assertEquals("timestamp", Instant.parse("2026-03-04T05:06:07Z"), get(p, "at"));
            assertEquals("uuid", UUID.fromString("3f2504e0-4f89-11d3-9a0c-0305e82c3301"), get(p, "id"));

            // --- a decimal reached through a nested object ---
            Object inner = get(p, "inner");
            assertNotNull("nested object populated", inner);
            assertEquals("inner.nested", new BigDecimal("9.75"), get(inner, "nested"));

            // --- arrays are element-typed, not stringified ---
            List<?> counts = (List<?>) get(p, "counts");
            assertEquals("int array is element-typed, not List<String>", List.of(3, 4), counts);

            // A decimal ARRAY is deliberately NOT a metamodel shape: DataTypes has no
            // DECIMAL_ARRAY ("arrays-of-decimal aren't in the metamodel" — the same position
            // C# records as SP-A "decimal is single-only"), so DataTypes.arrayTypeFor maps
            // field.decimal @isArray to DECIMAL and the assembled value cannot be populated.
            // What matters is the FAILURE MODE: the component is lost, and the rest of the
            // payload still parses. Before the never-throws fix in MetaObjectExtractor.assemble
            // this threw out of the whole extract. It still COMPILES (see
            // GeneratedScalarExtractLockStepTest) — a declared shape must never emit broken code
            // even when the runtime cannot fill it.
            assertNull("decimal array is unsupported by the object model — lost, not fatal",
                    get(p, "rates"));

            // --- NEVER-THROWS: a malformed component does not cost the whole extract ---
            assertNull("malformed date degrades to null", get(p, "badDate"));
            assertEquals("a bad field must not cost the good ones", "W-1", get(p, "ref"));

            // KNOWN HAZARD, asserted as-is so it is visible rather than silently relied on:
            // DataConverter.toBigDecimal returns BigDecimal.ZERO for an unparseable string
            // instead of null, so "not-a-number" reaches the record as 0 — a plausible-looking
            // money value standing in for "we could not read this". Null would be the honest
            // answer. NOT changed here: toBigDecimal is a core converter the OMDB persistence
            // path also uses, so flipping its contract is a decision with its own blast radius,
            // not a drive-by. When it is fixed, this assertion flips to assertNull.
            assertEquals("unparseable decimal currently becomes ZERO, not null",
                    BigDecimal.ZERO, get(p, "bad"));
        }
    }

    private static Object get(Object rec, String component) throws Exception {
        return rec.getClass().getMethod(component).invoke(rec);
    }
}
