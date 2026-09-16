package com.metaobjects.generator.direct.object;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.util.JavaCompileTestSupport;
import com.metaobjects.loader.InMemoryStringSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.ObjectClassRegistry;
import org.junit.After;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * The POJO emitters prefix every accessor ({@code get<Cap>} / {@code is<Cap>} /
 * {@code set<Cap>}), which is why a field named {@code notify} needs no escape here — its
 * accessor is {@code getNotify()}. The prefix defeats all eight of the names JLS 8.10.3
 * forbids a record component, but it MANUFACTURES one of its own: a field named
 * {@code class} capitalises to {@code getClass()}, which is {@code final} on
 * {@code java.lang.Object} and cannot be overridden or re-declared.
 *
 * <p>The generated type does not compile, on either the class flavor (cannot override a
 * final method) or the interface flavor (JLS 9.2 — override-equivalent to a public
 * {@code Object} method with a different return type). {@code mvn metaobjects:generate}
 * exits 0 either way; the adopter's build is the first thing that disagrees.
 *
 * <p>Not reachable from the codegen-compile gate: the shared fitness corpus declares no
 * field named {@code class}, and a corpus cannot carry every illegal name in every target
 * language. So this carries its own fixture.
 */
public class JavaAccessorNameCollisionTest {

    private static final String PKG = "acme::school";

    /**
     * {@code class} is the collision. {@code notify} sits beside it as the control: the
     * eight record-component names are already safe under a {@code get} prefix, and an
     * over-broad guard that escaped them here would churn every generated POJO.
     */
    private static final String META = "{ \"metadata.root\": {"
        + "  \"package\": \"" + PKG + "\","
        + "  \"children\": ["
        + "    { \"object.value\": { \"name\": \"Enrollment\", \"children\": ["
        + "      { \"field.string\":  { \"name\": \"class\" } },"
        + "      { \"field.boolean\": { \"name\": \"notify\" } },"
        + "      { \"field.string\":  { \"name\": \"student\" } }"
        + "    ]}}"
        + "  ]"
        + "}}";

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @After
    public void resetRegistry() {
        ObjectClassRegistry.resetGlobal();
    }

    @Test
    public void aFieldNamedClassCompilesOnEveryFlavor() throws Exception {
        for (String[] shape : new String[][] {
                { "class", "valueObject" }, { "class", "pojoAware" }, { "interface", "" } }) {
            String source = generate(shape[0], shape[1]);
            assertTrue("the accessor must not be getClass()\n" + source,
                !source.contains(" getClass()"));
            // The control: the record escape must NOT leak into the POJO emitters.
            assertTrue("a get-prefixed accessor needs no record escape\n" + source,
                source.contains("isNotify()") || source.contains("getNotify()"));
            assertFalse("and must not be escaped as if it were a record component",
                source.contains("notify_"));
        }
    }

    /** Generate one flavor and return the Enrollment source, having compiled everything. */
    private String generate(String type, String flavor) throws Exception {
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "collide-" + type + flavor);
        loader.init();
        loader.load(List.of(new InMemoryStringSource(META, "collide/meta.json")));

        Path gen = tmp.newFolder("gen-" + type + flavor).toPath();
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("type", type);
        if (!flavor.isEmpty()) args.put("flavor", flavor);
        JavaObjectCodeGenerator generator = new JavaObjectCodeGenerator();
        generator.setArgs(args);
        generator.execute(loader);

        List<File> sources;
        try (Stream<Path> s = Files.walk(gen)) {
            sources = s.filter(p -> p.toString().endsWith(".java")).map(Path::toFile)
                       .collect(Collectors.toList());
        }
        assertFalse("expected generated .java under " + gen, sources.isEmpty());

        JavaCompileTestSupport.compileGenerated(
            gen, tmp.newFolder("classes-" + type + flavor).toPath());

        return Files.readString(sources.stream()
            .filter(f -> f.getName().equals("Enrollment.java")).findFirst()
            .orElseThrow(() -> new AssertionError("Enrollment.java not generated")).toPath());
    }
}
