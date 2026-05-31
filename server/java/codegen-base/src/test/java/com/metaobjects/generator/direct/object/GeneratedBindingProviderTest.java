package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.object.MetaObjectAware;
import com.metaobjects.object.value.ValueObject;
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
 * Task 5 proof: the flavor generator ALSO emits a self-registering
 * {@link ObjectClassBindingProvider} (a generated {@code .java} class whose
 * {@code bindings()} maps each generated object's metadata FQN — the package-folded
 * resolution key {@code pkg::Name} — to its generated {@code Class}), so that
 * {@link MetaObject#newInstance()} for a generated object's FQN yields the GENERATED
 * flavored class instead of a bare {@link ValueObject}.
 *
 * <p>The generated provider also emits a {@code META-INF/services/<FQN-of-provider>}
 * registration so it is discoverable via {@code ServiceLoader}.</p>
 */
public class GeneratedBindingProviderTest {

    private static final String PKG = "acme::payload";
    private static final String ANSWER_FQN  = PKG + "::Answer";
    private static final String ADDRESS_FQN = PKG + "::Address";

    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"" + PKG + "\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"Address\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"city\" } }"
        + "    ]}},"
        + "    { \"object.value\": { \"name\": \"Answer\", \"children\": ["
        + "      { \"field.string\": { \"name\": \"title\" } },"
        + "      { \"field.int\":    { \"name\": \"count\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private MetaDataLoader loadMeta() {
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL, "binding-provider");
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "binding-provider/meta.json")));
        return loader;
    }

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void emitsProviderThatBindsGeneratedFqnToGeneratedClass() throws Exception {
        MetaDataLoader loader = loadMeta();
        MetaObject answerMo = loader.getMetaObjectByName(ANSWER_FQN);
        assertNotNull("Answer MetaObject must load", answerMo);

        // ------------------------------------------------------------------
        // 1. Generate the pojoAware flavor + its binding provider into a temp dir
        // ------------------------------------------------------------------
        Path gen = tmp.newFolder("gen").toPath();

        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("type", "class");
        args.put("flavor", "pojoAware");

        JavaObjectCodeGenerator generator = new JavaObjectCodeGenerator();
        generator.setArgs(args);
        generator.execute(loader);

        // ------------------------------------------------------------------
        // 2. The generator must have emitted a META-INF/services registration
        // ------------------------------------------------------------------
        Path servicesFile = gen.resolve("META-INF/services/" + ObjectClassBindingProvider.class.getName());
        assertTrue("generator must emit META-INF/services registration at " + servicesFile,
                Files.exists(servicesFile));
        String providerFqn = Files.readString(servicesFile).trim();
        assertFalse("services file must name the generated provider", providerFqn.isEmpty());

        // ------------------------------------------------------------------
        // 3. Collect + compile all generated .java in-memory
        // ------------------------------------------------------------------
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

        // ------------------------------------------------------------------
        // 4. Load the generated provider, register it in a clean registry,
        //    then newInstance() must yield the GENERATED class (not ValueObject)
        // ------------------------------------------------------------------
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> answerCls = cl.loadClass("acme.payload.Answer");

            // The services-named provider must be loadable + instantiable
            Class<?> providerCls = cl.loadClass(providerFqn);
            assertTrue("generated provider must implement ObjectClassBindingProvider",
                    ObjectClassBindingProvider.class.isAssignableFrom(providerCls));
            ObjectClassBindingProvider provider =
                    (ObjectClassBindingProvider) providerCls.getDeclaredConstructor().newInstance();

            // The provider must key on the package-folded resolution key (pkg::Name)
            assertEquals("provider must bind the Answer FQN to the generated class",
                    answerCls, provider.bindings().get(ANSWER_FQN));

            // Wire a fresh, scoped registry holding ONLY these generated bindings
            ObjectClassRegistry scoped = new ObjectClassRegistry();
            scoped.register(provider);
            ObjectClassRegistry.setGlobal(scoped);

            // newInstance() on a FRESH loader/MetaObject must resolve to the generated class
            MetaDataLoader freshLoader = loadMeta();
            MetaObject freshAnswer = freshLoader.getMetaObjectByName(ANSWER_FQN);

            Object inst = freshAnswer.newInstance();
            assertTrue("newInstance() must yield the GENERATED class, was "
                    + inst.getClass().getName(), answerCls.isInstance(inst));
            assertFalse("must NOT fall back to a bare ValueObject",
                    inst instanceof ValueObject);

            // back-ref must be set to the supplying MetaObject
            assertSame("back-reference must be the Answer MetaObject",
                    freshAnswer, ((MetaObjectAware) inst).getMetaData());
        }
    }
}
