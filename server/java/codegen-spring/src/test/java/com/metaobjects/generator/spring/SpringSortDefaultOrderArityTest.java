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
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Arity gate for the generated {@code SORT_DEFAULT_ORDER} map
 * ({@code @sortableDefaultOrder}, emitted by {@link SpringControllerGenerator}).
 *
 * <p><b>The defect this exists for.</b> The constant was first emitted as
 * {@code Map.of(k1, v1, ...)}. {@code Map.of} is a family of FIXED-ARITY overloads
 * topping out at TEN pairs, with no varargs form — alternating key/value types make one
 * impossible. So an entity whose <b>eleventh</b> field declares
 * {@code @sortableDefaultOrder} emitted a controller that did not compile:
 * {@code no suitable method found for of(String,String,...)}. Nothing in the model is
 * wrong in that case; eleven declared sort directions is ordinary metadata.
 *
 * <p><b>Why the sibling constant looks like a precedent and is not.</b> The
 * {@code SORT_ALLOWLIST} emitted a few lines above uses {@code Set.of(...)} at unbounded
 * arity and is perfectly safe — because {@code Set.of} <i>does</i> carry a
 * {@code Set.of(E...)} varargs overload. That asymmetry is the whole trap: the two lines
 * read as the same idiom and only one of them scales.
 *
 * <p><b>Why this test compiles rather than greps.</b> A text assertion is exactly the gate
 * class that cannot see this — {@code Map.of(...)} with eleven pairs is an entirely
 * ordinary-looking string, and the Kotlin sibling's empty-{@code mapOf()} inference break
 * shipped past text goldens for the same reason. The generated controller itself cannot be
 * compiled in this module (its Spring Web MVC / jakarta.servlet imports are not on the test
 * classpath — see {@code SpringAutoSetStampingTest}), so the declaration is lifted out and
 * compiled standalone with the in-process JDK compiler. That is a real compile of the real
 * emitted characters, which is what the defect requires.
 *
 * <p>The map is then loaded and read back, so a generator that "fixed" the ceiling by
 * silently truncating to ten entries fails here too.
 */
public class SpringSortDefaultOrderArityTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    /** Number of fields declaring {@code @sortableDefaultOrder} — one PAST {@code Map.of}'s ceiling. */
    private static final int DECLARED = 11;

    /**
     * Eleven scalar fields, every one carrying an explicit {@code @sortableDefaultOrder}.
     * Directions alternate so a read-back cannot pass by accident on a constant answer.
     */
    private static final String ELEVEN_DECLARED_FIXTURE = """
        {
          "metadata.root": { "package": "acme::wide", "children": [
            { "object.entity": { "name": "Wide", "children": [
                { "source.rdb":       { "@table": "wides" } },
                { "field.long":       { "name": "id" } },
                { "field.string":     { "name": "f01", "@sortableDefaultOrder": "desc" } },
                { "field.string":     { "name": "f02", "@sortableDefaultOrder": "asc"  } },
                { "field.string":     { "name": "f03", "@sortableDefaultOrder": "desc" } },
                { "field.string":     { "name": "f04", "@sortableDefaultOrder": "asc"  } },
                { "field.string":     { "name": "f05", "@sortableDefaultOrder": "desc" } },
                { "field.string":     { "name": "f06", "@sortableDefaultOrder": "asc"  } },
                { "field.string":     { "name": "f07", "@sortableDefaultOrder": "desc" } },
                { "field.string":     { "name": "f08", "@sortableDefaultOrder": "asc"  } },
                { "field.string":     { "name": "f09", "@sortableDefaultOrder": "desc" } },
                { "field.string":     { "name": "f10", "@sortableDefaultOrder": "asc"  } },
                { "field.string":     { "name": "f11", "@sortableDefaultOrder": "desc" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    /** A concrete entity inheriting both of its sortable fields from an abstract base. */
    private static final String INHERITED_FIXTURE = """
        {
          "metadata.root": { "package": "acme::base", "children": [
            { "object.entity": { "name": "BaseEntity", "abstract": true, "children": [
                { "field.long":      { "name": "id" } },
                { "field.timestamp": { "name": "createdAt", "@sortableDefaultOrder": "desc" } }
            ] } },
            { "object.entity": { "name": "Post", "extends": "BaseEntity", "children": [
                { "source.rdb":       { "@table": "posts" } },
                { "field.string":     { "name": "title" } },
                { "identity.primary": { "name": "pk", "@fields": ["id"], "@generation": "increment" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void elevenDeclaredOrdersEmitACompilableMapAndKeepEveryEntry() throws Exception {
        Path srcDir = tmp.newFolder("wide-src").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("wide-fx").toPath(), "wide", ELEVEN_DECLARED_FIXTURE);

        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        String ctrl = Files.readString(srcDir.resolve("acme/wide/WideController.java"));

        String decl = sortDefaultOrderDeclaration(ctrl);

        // Compile the declaration standalone. Before the fix this is the `Map.of(...)`
        // 11-pair form and javac reports "no suitable method found for of(...)".
        Map<String, String> emitted = compileAndRead(decl);

        assertEquals("every declared @sortableDefaultOrder must survive into the emitted map "
                + "(a truncation to Map.of's 10-pair ceiling would show up here); saw: " + emitted,
            DECLARED, emitted.size());
        for (int i = 1; i <= DECLARED; i++) {
            String name = String.format("f%02d", i);
            String expected = (i % 2 == 1) ? "desc" : "asc";
            assertEquals("declared order for " + name + " in " + emitted, expected, emitted.get(name));
        }
    }

    /**
     * An entity that INHERITS its sortable fields via {@code extends} must still emit a
     * controller.
     *
     * <p>The sort allowlist is built from {@code getMetaFields()}, which includes inherited
     * fields; the declared-order map is then built by looking each of those names back up.
     * If that lookup does not tolerate an inherited name, the pairing is broken for the
     * single most common shape in the codebase — the {@code BaseEntity} pattern CLAUDE.md
     * documents, where entities {@code extends} a shared abstract for {@code id} /
     * {@code createdAt}.
     */
    @Test
    public void inheritedSortFieldsStillEmitAController() throws Exception {
        Path srcDir = tmp.newFolder("inherit-src").toPath();
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder("inherit-fx").toPath(), "inherit", INHERITED_FIXTURE);

        runGenerator(new SpringControllerGenerator(), loader, srcDir);
        String ctrl = Files.readString(srcDir.resolve("acme/base/PostController.java"));

        assertTrue("inherited id must be in the sort allowlist; saw:\n" + ctrl,
            ctrl.contains("\"id\""));
        Map<String, String> emitted = compileAndRead(sortDefaultOrderDeclaration(ctrl));
        assertEquals("the inherited createdAt declares desc", "desc", emitted.get("createdAt"));
    }

    /** The single emitted {@code SORT_DEFAULT_ORDER} declaration line, verbatim. */
    private static String sortDefaultOrderDeclaration(String controllerSrc) {
        for (String line : controllerSrc.split("\n")) {
            if (line.trim().startsWith("private static final Map<String, String> SORT_DEFAULT_ORDER")) {
                return line.trim();
            }
        }
        throw new AssertionError(
            "no SORT_DEFAULT_ORDER declaration in generated controller:\n" + controllerSrc);
    }

    /**
     * Wrap {@code declaration} in a minimal class, compile it with the in-process JDK
     * compiler, then load it and return the map it declares.
     */
    private Map<String, String> compileAndRead(String declaration) throws Exception {
        Path srcDir = tmp.newFolder("probe-src").toPath();
        Path classesDir = tmp.newFolder("probe-classes").toPath();
        Path javaFile = srcDir.resolve("SortDefaultOrderProbe.java");
        Files.writeString(javaFile, """
            import java.util.Map;
            public class SortDefaultOrderProbe {
                %s
                public static Map<String, String> get() { return SORT_DEFAULT_ORDER; }
            }
            """.formatted(declaration), StandardCharsets.UTF_8);

        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);
        DiagnosticCollector<JavaFileObject> diags = new DiagnosticCollector<>();
        var fm = javac.getStandardFileManager(diags, null, StandardCharsets.UTF_8);
        List<String> opts = List.of("-d", classesDir.toString());
        boolean ok = javac.getTask(null, fm, diags, opts, null,
            fm.getJavaFileObjectsFromFiles(List.of(new File(javaFile.toString())))).call();

        if (!ok) {
            StringBuilder sb = new StringBuilder(
                "the emitted SORT_DEFAULT_ORDER declaration does not compile at "
                + DECLARED + " declared orders:\n");
            for (var d : diags.getDiagnostics()) {
                sb.append("  ").append(d.getKind()).append(": ").append(d.getMessage(null)).append('\n');
            }
            sb.append("\ndeclaration was:\n").append(declaration).append('\n');
            fail(sb.toString());
        }

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classesDir.toUri().toURL() }, getClass().getClassLoader())) {
            Class<?> probe = cl.loadClass("SortDefaultOrderProbe");
            @SuppressWarnings("unchecked")
            Map<String, String> m = (Map<String, String>) probe.getMethod("get").invoke(null);
            assertTrue("probe returned no map", m != null);
            return m;
        }
    }

    private static void runGenerator(
            com.metaobjects.generator.direct.MultiFileDirectGeneratorBase<?> generator,
            MetaDataLoader loader, Path outDir) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", outDir.toString());
        generator.setArgs(args);
        generator.execute(loader);
    }
}
