package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import com.metaobjects.object.value.ValueObject;
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
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * Compile-run proof for the {@code valueObject} flavor: the flavor-selecting
 * generator + {@code ValueObjectCodeWriter} emit a CONCRETE Java class that
 * {@code extends com.metaobjects.object.value.ValueObject}, whose typed accessors
 * read/write a per-field CACHED value holder ({@code DataObjectBase.Value}) bound
 * ONCE at construction — NOT a {@code get("name")}/{@code set("name",v)} map lookup
 * on every accessor call (the perf pattern).
 *
 * <p>Because the base is the map-backed extensible {@link ValueObject}, the cached
 * holder is the live cell: a value set via the typed setter is visible through the
 * inherited {@code get(name)}, a value put via the {@code Map} surface is visible
 * through the typed getter, and undeclared keys still round-trip through the map.</p>
 *
 * <p>Mirrors the in-memory javac compile-run harness used by the pojoAware test.</p>
 */
public class JavaValueObjectCompileRunTest {

    private static final String PKG = "acme::payload";
    private static final String ANSWER_FQN  = PKG + "::Answer";
    private static final String ADDRESS_FQN = PKG + "::Address";
    private static final String ITEM_FQN    = PKG + "::LineItem";

    /**
     * Payload with scalar fields (string + int), a single nested object field
     * ({@code address} → Address), and an array-of-object field ({@code items} →
     * List&lt;LineItem&gt;). The nested objects are themselves top-level value objects.
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
        + "      { \"field.string\": { \"name\": \"title\" } },"
        + "      { \"field.int\":    { \"name\": \"count\" } },"
        + "      { \"field.object\": { \"name\": \"address\", \"@objectRef\": \"" + ADDRESS_FQN + "\" } },"
        + "      { \"field.object\": { \"name\": \"items\", \"isArray\": true, \"@objectRef\": \"" + ITEM_FQN + "\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataLoader loadMeta() {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "valueObject-cr");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "valueObject-cr/meta.json")));
        return loader;
    }

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void valueObjectEmitsConcreteClassWithCachedHolderAccessors() throws Exception {
        MetaDataLoader loader = loadMeta();
        MetaObject answerMo = loader.getMetaObjectByName(ANSWER_FQN);
        assertNotNull("Answer MetaObject must load", answerMo);

        // -----------------------------------------------------------------------
        // 1. Generate the valueObject flavor into a temp dir
        // -----------------------------------------------------------------------
        Path gen = tmp.newFolder("gen").toPath();

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("type", "class");
        args.put("flavor", "valueObject");

        JavaObjectCodeGenerator generator = new JavaObjectCodeGenerator();
        generator.setArgs(args);
        generator.execute(loader);

        // -----------------------------------------------------------------------
        // 2. Collect + compile all generated .java in-memory
        // -----------------------------------------------------------------------
        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java"))
                       .map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java files under " + gen, sources.isEmpty());

        // Capture the Answer source for source-level assertions (bound-once).
        File answerSrc = sources.stream()
                .filter(f -> f.getName().equals("Answer.java"))
                .findFirst()
                .orElseThrow(() -> new AssertionError("Answer.java not generated"));
        String answerSource = Files.readString(answerSrc.toPath());

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes").toPath();
        String cp = System.getProperty("java.class.path");
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, null);
        List<String> opts = List.of("-classpath", cp, "-d", classes.toString());

        boolean ok = javac.getTask(null, fm, diags, opts, null,
                fm.getJavaFileObjectsFromFiles(sources)).call();

        if (!ok) {
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
        // 3. Source-level: bound-once + holder-backed accessor bodies
        // -----------------------------------------------------------------------
        // valueHolder("title") / valueHolder("count") appear EXACTLY ONCE each.
        for (String field : new String[]{ "title", "count", "address", "items" }) {
            assertEquals("valueHolder(\"" + field + "\") must be emitted exactly once",
                    1, countMatches(answerSource, "valueHolder(\"" + field + "\")"));
        }
        // Accessor bodies use the cached holder, NOT per-call get(" / set(".
        assertTrue("getter body must read the cached holder via getValue()",
                answerSource.contains(".getValue()"));
        assertTrue("setter body must write the cached holder via setValue(",
                answerSource.contains(".setValue("));
        assertFalse("accessor bodies must NOT do per-call get(\"...\") map lookups",
                answerSource.contains("get(\""));
        assertFalse("accessor bodies must NOT do per-call set(\"...\") map writes",
                answerSource.contains("set(\""));

        // -----------------------------------------------------------------------
        // 4. Reflectively verify the emitted concrete class
        // -----------------------------------------------------------------------
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> answerCls  = cl.loadClass("acme.payload.Answer");
            Class<?> addressCls = cl.loadClass("acme.payload.Address");
            cl.loadClass("acme.payload.LineItem"); // must exist + compile

            // extends ValueObject
            assertTrue("Answer must extend ValueObject",
                    ValueObject.class.isAssignableFrom(answerCls));

            // (MetaObject) ctor forwards to super(mo) → MetaObjectAware back-ref
            Object inst = answerCls.getConstructor(MetaObject.class).newInstance(answerMo);
            assertSame("back-ref must be the supplied MetaObject",
                    answerMo, ((MetaObjectAware) inst).getMetaData());

            Method setTitle = answerCls.getMethod("setTitle", String.class);
            Method getTitle = answerCls.getMethod("getTitle");

            // scalar setter/getter round-trip
            setTitle.invoke(inst, "hello");
            assertEquals("scalar round-trip", "hello", getTitle.invoke(inst));

            // map-base consistency (1): typed setter visible via inherited get(name)
            Map<?, ?> asMap = (Map<?, ?>) inst;
            assertEquals("typed setter must be visible via Map.get",
                    "hello", asMap.get("title"));

            // map-base consistency (2): Map.put visible via the typed getter
            @SuppressWarnings("unchecked")
            Map<String, Object> mapW = (Map<String, Object>) inst;
            mapW.put("title", "world");
            assertEquals("Map.put must be visible via the typed getter — holder is the live cell",
                    "world", getTitle.invoke(inst));

            // extensibility: with extensions enabled, an UNDECLARED key round-trips
            // through the map base — the ValueObject map base is intact.
            ((ValueObject) inst).allowExtensions(true);
            mapW.put("extra", 42);
            assertEquals("undeclared key must round-trip — ValueObject map base intact",
                    42, asMap.get("extra"));

            // nested single object: getter return type is the nested class
            Method getAddress = answerCls.getMethod("getAddress");
            assertEquals("address getter return type is the nested class",
                    addressCls, getAddress.getReturnType());

            // array-of-objects: getter return type is java.util.List
            Method getItems = answerCls.getMethod("getItems");
            assertEquals("items getter return type is List",
                    java.util.List.class, getItems.getReturnType());
        }
    }

    private static int countMatches(String haystack, String needle) {
        int count = 0;
        Matcher m = Pattern.compile(Pattern.quote(needle)).matcher(haystack);
        while (m.find()) count++;
        return count;
    }
}
