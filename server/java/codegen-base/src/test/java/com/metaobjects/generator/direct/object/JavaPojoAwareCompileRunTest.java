package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import com.metaobjects.object.pojo.PojoObject;
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
 * Compile-run proof for the {@code pojoAware} flavor: the flavor-selecting
 * generator + {@code PojoAwareCodeWriter} emit a CONCRETE Java class that
 * {@code extends com.metaobjects.object.pojo.PojoObject} (instead of the legacy
 * interface), with typed private fields, a {@code (MetaObject)} constructor that
 * forwards to {@code super(mo)}, and getter/setter bodies. Nested single-object and
 * array-of-object fields surface as the nested class type and {@code java.util.List}
 * respectively, and the nested sub-object class is itself generated + compiles.
 *
 * <p>Mirrors the in-memory javac compile-run harness used by the legacy reference's
 * codegen tests (ToolProvider + DiagnosticCollector + URLClassLoader).</p>
 */
public class JavaPojoAwareCompileRunTest {

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
                MetaDataLoader.SUBTYPE_MANUAL, "pojoAware-cr");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "pojoAware-cr/meta.json")));
        return loader;
    }

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void pojoAwareEmitsConcreteClassExtendingPojoObject() throws Exception {
        MetaDataLoader loader = loadMeta();
        MetaObject answerMo = loader.getMetaObjectByName(ANSWER_FQN);
        assertNotNull("Answer MetaObject must load", answerMo);

        // -----------------------------------------------------------------------
        // 1. Generate the pojoAware flavor into a temp dir
        // -----------------------------------------------------------------------
        Path gen = tmp.newFolder("gen").toPath();

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("type", "class");
        args.put("flavor", "pojoAware");

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
        // 3. Reflectively verify the emitted concrete class
        // -----------------------------------------------------------------------
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> answerCls  = cl.loadClass("acme.payload.Answer");
            Class<?> addressCls = cl.loadClass("acme.payload.Address");
            cl.loadClass("acme.payload.LineItem"); // must exist + compile

            // extends PojoObject
            assertTrue("Answer must extend PojoObject",
                    PojoObject.class.isAssignableFrom(answerCls));

            // (MetaObject) ctor forwards to super(mo) → MetaObjectAware back-ref
            Object inst = answerCls.getConstructor(MetaObject.class).newInstance(answerMo);
            assertSame("back-ref must be the supplied MetaObject",
                    answerMo, ((MetaObjectAware) inst).getMetaData());

            // scalar setter/getter round-trip
            Method setTitle = answerCls.getMethod("setTitle", String.class);
            Method getTitle = answerCls.getMethod("getTitle");
            setTitle.invoke(inst, "hello");
            assertEquals("scalar round-trip", "hello", getTitle.invoke(inst));

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
}
