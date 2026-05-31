package com.metaobjects.generator.spring;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import com.metaobjects.registry.ObjectClassBindingProvider;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
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
 * Task 6 compile-run proof — the generated {@code <Name>Extractor} closes flavored extraction.
 *
 * <p>For each concrete flavor ({@code pojoAware} + {@code valueObject}) this test:</p>
 * <ol>
 *   <li>builds an in-memory loader with a payload object carrying scalars, a single nested
 *       {@code field.object}, and an array {@code field.object} ({@code isArray:true});</li>
 *   <li>generates the flavored class + its sub-object classes + the self-registering
 *       {@link ObjectClassBindingProvider} + the {@code <Name>Extractor};</li>
 *   <li>compiles everything in-memory ({@code om} is on the test classpath, so the generated
 *       {@code Extractor}'s reference to {@code com.metaobjects.object.extract.MetaObjectExtractor}
 *       resolves);</li>
 *   <li>registers the generated binding provider so {@link MetaObject#newInstance()} yields the
 *       generated flavored type;</li>
 *   <li>invokes {@code <Name>Extractor.extract(loader, dirtyJson)} and asserts the returned
 *       object IS the generated flavored type, the nested object is populated (NOT null), the
 *       array-of-objects is populated (size 2, element fields set), and the
 *       {@link MetaObjectAware} back-ref is set;</li>
 *   <li>invokes {@code <Name>Extractor.extractLenient(loader, cleanJson)} and asserts the report has
 *       no lost-required.</li>
 * </ol>
 *
 * <p>The Extractor is emitted in {@code codegen-base} (referencing {@code MetaObjectExtractor} by
 * FQN string so {@code codegen-base} main keeps NO {@code om} compile dep). This test lives in
 * {@code codegen-spring} because that module already depends on {@code codegen-base} (compile)
 * AND {@code om} (test) — the existing home for the compile-run-extract harness, no pom change
 * and no reactor reordering of the foundational {@code codegen-base} module.</p>
 */
public class GeneratedExtractorCompileRunTest {

    private static final String PKG = "acme::payload";
    private static final String ANSWER_FQN  = PKG + "::Answer";
    private static final String ADDRESS_FQN = PKG + "::Address";
    private static final String ITEM_FQN    = PKG + "::LineItem";

    /**
     * Payload: scalar string {@code title} (required) + scalar int {@code count}, a single
     * nested object {@code address} (Address: city, zip), and an array-of-objects {@code items}
     * (List&lt;LineItem&gt;: sku, qty).
     */
    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"" + PKG + "\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"Address\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"city\" } },"
        + "      { \"field.string\": { \"name\": \"zip\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"LineItem\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"sku\" } },"
        + "      { \"field.int\":    { \"name\": \"qty\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"Answer\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"title\", \"@required\": true } },"
        + "      { \"field.int\":    { \"name\": \"count\" } },"
        + "      { \"field.object\": { \"name\": \"address\", \"@objectRef\": \"" + ADDRESS_FQN + "\" } },"
        + "      { \"field.object\": { \"name\": \"items\", \"isArray\": true, \"@objectRef\": \"" + ITEM_FQN + "\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    // Slightly-dirty JSON: LLM preamble, fenced block, trailing comma after the array, chatter.
    private static final String DIRTY = "Sure, here's the result:\n```json\n"
            + "{  \"title\" : \"Order #7\" ,\n"
            + "   \"count\": 3,\n"
            + "   \"address\": { \"city\": \"Austin\", \"zip\": \"78701\" },\n"
            + "   \"items\": [ { \"sku\": \"A1\", \"qty\": 2 }, { \"sku\": \"B2\", \"qty\": 5 } ],\n"
            + "}\n```\nHope that helps!";

    private static final String CLEAN =
            "{\"title\":\"Order #7\",\"count\":3,"
            + "\"address\":{\"city\":\"Austin\",\"zip\":\"78701\"},"
            + "\"items\":[{\"sku\":\"A1\",\"qty\":2},{\"sku\":\"B2\",\"qty\":5}]}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void pojoAwareExtractorPopulatesNestedAndArray() throws Exception {
        runFlavor(JavaObjectCodeGenerator.FLAVOR_POJO_AWARE, "pojoAware-ex");
    }

    @Test
    public void valueObjectExtractorPopulatesNestedAndArray() throws Exception {
        runFlavor(JavaObjectCodeGenerator.FLAVOR_VALUE_OBJECT, "valueObject-ex");
    }

    // -----------------------------------------------------------------------------------------
    // shared driver
    // -----------------------------------------------------------------------------------------

    private void runFlavor(String flavor, String loaderName) throws Exception {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, loaderName);
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, loaderName + "/meta.json")));

        MetaObject answerMo = loader.getMetaObjectByName(ANSWER_FQN);
        assertNotNull("Answer MetaObject must load", answerMo);

        // 1. Generate flavored classes + provider + Extractor.
        Path gen = tmp.newFolder("gen-" + flavor).toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("type", "class");
        args.put("flavor", flavor);

        JavaObjectCodeGenerator generator = new JavaObjectCodeGenerator();
        generator.setArgs(args);
        generator.execute(loader);

        // The Extractor must have been emitted alongside the flavored class.
        File extractorSrc = gen.resolve("acme/payload/AnswerExtractor.java").toFile();
        assertTrue("AnswerExtractor.java must be emitted for flavor=" + flavor + " at " + extractorSrc,
                extractorSrc.isFile());

        // 2. Compile everything in-memory.
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-" + flavor).toPath();
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();
        if (!ok) {
            StringBuilder sb = new StringBuilder("generated sources failed to compile (flavor=" + flavor + "):\n");
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

        // 3. Load + register the generated binding provider, then drive the Extractor.
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> answerCls  = cl.loadClass("acme.payload.Answer");
            Class<?> addressCls = cl.loadClass("acme.payload.Address");
            Class<?> itemCls    = cl.loadClass("acme.payload.LineItem");

            // Register the generated provider so MetaObject.newInstance() yields the flavored type.
            Class<?> providerCls = cl.loadClass(
                    "com.metaobjects.generated.GeneratedObjectClassBindingProvider");
            ObjectClassBindingProvider provider =
                    (ObjectClassBindingProvider) providerCls.getDeclaredConstructor().newInstance();
            ObjectClassRegistry scoped = new ObjectClassRegistry();
            scoped.register(provider);
            ObjectClassRegistry.setGlobal(scoped);

            // --- extract(loader, dirty) ---
            Class<?> extractorCls = cl.loadClass("acme.payload.AnswerExtractor");
            Method extract = extractorCls.getMethod("extract", MetaDataLoader.class, String.class);

            Object payload = extract.invoke(null, loader, DIRTY);
            assertNotNull("extract must return a non-null object (flavor=" + flavor + ")", payload);
            assertSame("extracted object must be the generated flavored type (flavor=" + flavor + ")",
                    answerCls, payload.getClass());

            // back-ref
            assertTrue("extracted payload must be MetaObjectAware", payload instanceof MetaObjectAware);
            assertSame("back-ref must be the Answer MetaObject",
                    answerMo, ((MetaObjectAware) payload).getMetaData());

            // top-level scalars
            assertEquals("title", "Order #7", payload.getClass().getMethod("getTitle").invoke(payload));
            assertEquals("count", Integer.valueOf(3),
                    payload.getClass().getMethod("getCount").invoke(payload));

            // single nested object populated (NOT null)
            Object address = payload.getClass().getMethod("getAddress").invoke(payload);
            assertNotNull("address nested object must be populated (NOT null) — flavor=" + flavor, address);
            assertSame("address must be the generated sub-type", addressCls, address.getClass());
            assertEquals("address.city", "Austin",
                    address.getClass().getMethod("getCity").invoke(address));
            assertEquals("address.zip", "78701",
                    address.getClass().getMethod("getZip").invoke(address));

            // array-of-objects populated
            Object items = payload.getClass().getMethod("getItems").invoke(payload);
            assertNotNull("items array-of-objects must be populated (NOT null) — flavor=" + flavor, items);
            assertTrue("items must be a List", items instanceof List);
            List<?> itemList = (List<?>) items;
            assertEquals("items size", 2, itemList.size());

            Object item0 = itemList.get(0);
            assertSame("items[0] must be the generated sub-type", itemCls, item0.getClass());
            assertEquals("items[0].sku", "A1", item0.getClass().getMethod("getSku").invoke(item0));
            assertEquals("items[0].qty", Integer.valueOf(2), item0.getClass().getMethod("getQty").invoke(item0));

            Object item1 = itemList.get(1);
            assertEquals("items[1].sku", "B2", item1.getClass().getMethod("getSku").invoke(item1));
            assertEquals("items[1].qty", Integer.valueOf(5), item1.getClass().getMethod("getQty").invoke(item1));

            // --- extractLenient(loader, clean) — report has no lost-required ---
            Method extractLenient = extractorCls.getMethod("extractLenient", MetaDataLoader.class, String.class);
            Object result = extractLenient.invoke(null, loader, CLEAN);
            assertNotNull("extractLenient result must be non-null", result);
            Object report = result.getClass().getMethod("report").invoke(result);
            boolean hasLostRequired =
                    (boolean) report.getClass().getMethod("hasLostRequired").invoke(report);
            assertFalse("clean input must lose no required field (flavor=" + flavor + ")", hasLostRequired);

            // the extract result's data is the same flavored type
            Object extracted = result.getClass().getMethod("data").invoke(result);
            assertSame("extractLenient().data() must be the generated flavored type",
                    answerCls, extracted.getClass());

            // --- extract(loader, lostRequired) — the strict orThrow() gate fires ---
            // The payload marks `title` @required. Feed input that loses it (well-formed JSON with
            // NO title); the generated extract(...) must throw the strict lost-required exception
            // (com.metaobjects.render.extract.ExtractException, a RuntimeException), surfaced via
            // reflection as an InvocationTargetException whose cause is that type.
            String lostRequired = "{\"count\":3,"
                    + "\"address\":{\"city\":\"Austin\",\"zip\":\"78701\"},"
                    + "\"items\":[{\"sku\":\"A1\",\"qty\":2}]}";
            Class<?> extractExceptionCls = cl.loadClass("com.metaobjects.render.extract.ExtractException");
            try {
                extract.invoke(null, loader, lostRequired);
                fail("extract(...) must throw when a required field is lost (flavor=" + flavor + ")");
            } catch (java.lang.reflect.InvocationTargetException ite) {
                Throwable cause = ite.getCause();
                assertNotNull("InvocationTargetException must carry a cause (flavor=" + flavor + ")", cause);
                assertSame("extract(...) lost-required cause must be ExtractException (flavor=" + flavor
                                + "); got " + cause.getClass().getName(),
                        extractExceptionCls, cause.getClass());
                assertTrue("ExtractException must be a RuntimeException",
                        cause instanceof RuntimeException);
                // and it must name the lost required path
                @SuppressWarnings("unchecked")
                List<String> lost = (List<String>) cause.getClass().getMethod("lostRequired").invoke(cause);
                assertTrue("lostRequired() must name `title` (flavor=" + flavor + "); got " + lost,
                        lost.contains("title"));
            }
        }
    }
}
