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
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * Plan 2.1 gold-standard proof — the nested codegen gap is CLOSED.
 *
 * <p>Generates the payload records (a payload with a single nested object field +
 * an array-of-objects field, plus the two nested payload records) and the parser,
 * COMPILES them in-memory, loads the parser, and invokes the runtime-delegating
 * {@code extractLenient(MetaDataLoader, String)} on DIRTY nested JSON. Asserts the nested
 * object AND the array-of-objects components are fully populated (NOT null) in the
 * typed payload — which the self-contained {@code extractLenient(String)} cannot do.
 *
 * <p>This is the codegen-wrapping-runtime pattern: the generated parser resolves its
 * payload {@code MetaObject} by FQN from the supplied loader and delegates to
 * {@link com.metaobjects.object.extract.MetaObjectExtractor}, then maps the assembled
 * {@code ValueObject} graph into the typed-record graph via generated mappers.
 */
public class GeneratedNestedExtractLenientCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void delegatingExtractLenientPopulatesNestedObjectAndArrayOfObjects() throws Exception {
        // -----------------------------------------------------------------------
        // 1. Generate payload records + parser into a temp directory
        // -----------------------------------------------------------------------
        Path gen = tmp.newFolder("gen").toPath();
        Path ws  = tmp.newFolder("ws").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
                ws, "extract-nested-cr", SpringTestFixtures.EXTRACT_NESTED_FIXTURE);

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());

        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator();
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        SpringOutputParserGenerator parserGen = new SpringOutputParserGenerator();
        parserGen.setArgs(args);
        parserGen.execute(loader);

        // -----------------------------------------------------------------------
        // 2. Collect generated .java files
        // -----------------------------------------------------------------------
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        // -----------------------------------------------------------------------
        // 3. Compile in-memory
        // -----------------------------------------------------------------------
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull(
            "JDK (not JRE) required for this test — ToolProvider.getSystemJavaCompiler() returned null",
            javac);

        Path classes = tmp.newFolder("classes").toPath();
        String cp = System.getProperty("java.class.path");

        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean compileOk = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();

        if (!compileOk) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
                if (d.getSource() != null) {
                    sb.append("    at ").append(d.getSource().getName())
                      .append(':').append(d.getLineNumber()).append('\n');
                }
            }
            for (File src : sources) {
                sb.append("\n=== ").append(src.getName()).append(" ===\n");
                sb.append(Files.readString(src.toPath())).append('\n');
            }
            fail(sb.toString());
        }

        // -----------------------------------------------------------------------
        // 4. Load the parser, invoke extractLenient(MetaDataLoader, String) on dirty nested JSON
        // -----------------------------------------------------------------------
        //
        // Fixture: NestedAnswer / NestedAnswerPayload with
        //   title   (String, required)
        //   address (AddressPayload: city, zip)        — single nested object
        //   items   (List<LineItemPayload>: sku, qty)  — array-of-objects
        //
        // Dirty input: LLM preamble + fenced JSON + trailing chatter; the nested
        // object and array-of-objects must be populated by the runtime delegation.
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() },
                getClass().getClassLoader())) {

            Class<?> parserClass = cl.loadClass("acme.ai.prompts.NestedAnswerParser");
            Method extractLenientMethod = parserClass.getMethod("extractLenient", MetaDataLoader.class, String.class);

            String dirty = "Here you go:\n```json\n"
                    + "{\"title\":\"Order #7\","
                    + "\"address\":{\"city\":\"Austin\",\"zip\":\"78701\"},"
                    + "\"items\":[{\"sku\":\"A1\",\"qty\":2},{\"sku\":\"B2\",\"qty\":5}]}"
                    + "\n```\nThanks!";

            Object result = extractLenientMethod.invoke(null, loader, dirty);
            Object payload = result.getClass().getMethod("data").invoke(result);
            Object report  = result.getClass().getMethod("report").invoke(result);

            // --- top-level scalar ---
            Object title = payload.getClass().getMethod("title").invoke(payload);
            assertEquals("title component", "Order #7", title);

            // --- single nested object: address must NOT be null and must be populated ---
            Object address = payload.getClass().getMethod("address").invoke(payload);
            assertNotNull("address nested object must be populated (NOT null) — the closed gap", address);
            Object city = address.getClass().getMethod("city").invoke(address);
            Object zip  = address.getClass().getMethod("zip").invoke(address);
            assertEquals("address.city", "Austin", city);
            assertEquals("address.zip", "78701", zip);

            // --- array-of-objects: items must be a populated List<LineItemPayload> ---
            Object items = payload.getClass().getMethod("items").invoke(payload);
            assertNotNull("items array-of-objects must be populated (NOT null) — the closed gap", items);
            assertTrue("items must be a List", items instanceof List);
            List<?> itemList = (List<?>) items;
            assertEquals("items size", 2, itemList.size());

            Object item0 = itemList.get(0);
            Object sku0 = item0.getClass().getMethod("sku").invoke(item0);
            Object qty0 = item0.getClass().getMethod("qty").invoke(item0);
            assertEquals("items[0].sku", "A1", sku0);
            assertEquals("items[0].qty", Integer.valueOf(2), qty0);

            Object item1 = itemList.get(1);
            Object sku1 = item1.getClass().getMethod("sku").invoke(item1);
            assertEquals("items[1].sku", "B2", sku1);

            // --- report: no required field lost (title extracted) ---
            boolean hasLostRequired = (boolean) report.getClass().getMethod("hasLostRequired").invoke(report);
            assertFalse("hasLostRequired must be false — title extracted", hasLostRequired);
        }
    }
}
