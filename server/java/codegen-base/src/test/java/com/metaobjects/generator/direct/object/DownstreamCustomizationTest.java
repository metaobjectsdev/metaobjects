package com.metaobjects.generator.direct.object;

import com.metaobjects.field.MetaField;
import com.metaobjects.generator.direct.GenerationContext;
import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.direct.object.javacode.PojoAwareCodeWriter;
import com.metaobjects.generator.util.GeneratorUtil;
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
import java.io.PrintWriter;
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
 * Downstream-extensibility proof for the flavored Java object writers.
 *
 * <p>The flavored-object codegen is a "downstream-extensible by design" hard
 * requirement: a downstream consumer must be able to subclass the new writers and
 * the flavor-selecting generator and customize emission WITHOUT forking the
 * framework. The two extension seams under test:</p>
 *
 * <ul>
 *   <li>{@code protected getGetterMethodName(MetaField)} on the writer chain
 *       (declared on {@code BaseObjectCodeWriter}, defined on the legacy
 *       {@code JavaCodeWriter}, inherited by {@code PojoAwareCodeWriter}) — a
 *       downstream subclass overrides it to change the emitted accessor name.</li>
 *   <li>{@code protected createWriter(...)} on {@code JavaObjectCodeGenerator} —
 *       the writer-factory extension point a downstream generator overrides to
 *       plug in its customized writer.</li>
 * </ul>
 *
 * <p>The nested {@code Custom*} classes below SIMULATE a downstream consumer's
 * code living outside the framework. The test generates with the custom generator,
 * compiles the output in-memory (mirroring {@link JavaPojoAwareCompileRunTest}'s
 * javac harness), and asserts the customization took effect: getters are named
 * {@code fetch<Name>()} rather than {@code get<Name>()}, while the class is still a
 * working concrete {@code PojoObject} subclass (extends + {@code (MetaObject)} ctor +
 * back-ref + setter round-trip).</p>
 */
public class DownstreamCustomizationTest {

    private static final String PKG = "acme::custom";
    private static final String ANSWER_FQN = PKG + "::Answer";

    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"" + PKG + "\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"Answer\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"title\" } },"
        + "      { \"field.int\":    { \"name\": \"count\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    // ----------------------------------------------------------------------------
    // DOWNSTREAM CONSUMER CODE (simulated) — lives outside the framework jar.
    // ----------------------------------------------------------------------------

    /**
     * A downstream consumer's writer. Overrides the {@code protected}
     * {@code getGetterMethodName} seam (inherited from the frozen legacy
     * {@code JavaCodeWriter}) to emit {@code fetch<Name>()} instead of
     * {@code get<Name>()}. No framework file is touched.
     */
    static final class CustomPojoAwareCodeWriter extends PojoAwareCodeWriter {
        CustomPojoAwareCodeWriter(MetaDataLoader loader, PrintWriter pw, GenerationContext context) {
            super(loader, pw, context);
        }

        @Override
        protected String getGetterMethodName(MetaField field) {
            // Downstream rename: "title" -> "fetchTitle" (not "getTitle").
            return "fetch" + GeneratorUtil.toCamelCase(field.getName(), true);
        }
    }

    /**
     * A downstream consumer's generator. Overrides the {@code protected}
     * {@code createWriter} factory seam to substitute the customized writer for the
     * {@code pojoAware} flavor; everything else (flavor selection, provider/Extractor
     * emission, the multi-file loop) is inherited unchanged.
     */
    static final class CustomJavaObjectCodeGenerator extends JavaObjectCodeGenerator {
        @Override
        protected BaseObjectCodeWriter createWriter(MetaDataLoader loader, MetaObject md,
                                                    PrintWriter pw, GenerationContext context) {
            if (FLAVOR_POJO_AWARE.equals(getFlavor())) {
                return new CustomPojoAwareCodeWriter(loader, pw, context)
                        .forType(TYPE_CLASS)
                        .withPkgPrefix(getPkgPrefix())
                        .withPkgSuffix(getPkgSuffix())
                        .withNamePrefix(getNamePrefix())
                        .withNameSuffix(getNameSuffix())
                        .addArrayMethods(addArrayMethods())
                        .addKeyMethods(addKeyMethods())
                        .withIndentor("    ");
            }
            return super.createWriter(loader, md, pw, context);
        }
    }

    // ----------------------------------------------------------------------------

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataLoader loadMeta() {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "downstream-custom");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "downstream-custom/meta.json")));
        return loader;
    }

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void downstreamSubclassCustomizesAccessorEmissionViaProtectedSeams() throws Exception {
        MetaDataLoader loader = loadMeta();
        MetaObject answerMo = loader.getMetaObjectByName(ANSWER_FQN);
        assertNotNull("Answer MetaObject must load", answerMo);

        // -----------------------------------------------------------------------
        // 1. Generate with the DOWNSTREAM generator (overridden createWriter)
        // -----------------------------------------------------------------------
        Path gen = tmp.newFolder("gen").toPath();

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("type", "class");
        args.put("flavor", "pojoAware");

        CustomJavaObjectCodeGenerator generator = new CustomJavaObjectCodeGenerator();
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
        // 3. Reflectively verify the DOWNSTREAM CUSTOMIZATION took effect
        // -----------------------------------------------------------------------
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> answerCls = cl.loadClass("acme.custom.Answer");

            // Customization: accessor was renamed get* -> fetch* by the overridden seam.
            Method fetchTitle = answerCls.getMethod("fetchTitle");
            assertEquals("customized getter returns String", String.class, fetchTitle.getReturnType());
            assertThrows("legacy get* getter must NOT be emitted after the downstream override",
                    NoSuchMethodException.class, () -> answerCls.getMethod("getTitle"));

            // The class still WORKS: concrete PojoObject subclass, (MetaObject) ctor,
            // back-ref, and a setter round-trip readable via the customized getter.
            assertTrue("Answer must still extend PojoObject",
                    PojoObject.class.isAssignableFrom(answerCls));

            Object inst = answerCls.getConstructor(MetaObject.class).newInstance(answerMo);
            assertSame("back-ref must be the supplied MetaObject",
                    answerMo, ((MetaObjectAware) inst).getMetaData());

            Method setTitle = answerCls.getMethod("setTitle", String.class);
            setTitle.invoke(inst, "hello");
            assertEquals("round-trip via the customized fetch* getter",
                    "hello", fetchTitle.invoke(inst));
        }
    }
}
