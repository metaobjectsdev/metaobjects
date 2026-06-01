package com.metaobjects.generator.spring;

import com.metaobjects.generator.GeneratorException;
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
import java.nio.file.Paths;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * Cross-port conformance for the {@code template.output} render-helper generator,
 * loading the SHARED corpus at
 * {@code fixtures/template-output-render-conformance/} — the same {@code meta.json}
 * + {@code templates/} the TS port loads ({@code render-helper-conformance.test.ts}),
 * and the oracle the phase-2 ports (C#/Python/Kotlin) must match.
 *
 * <p>Generate → in-memory javac → reflectively invoke {@code render(payload, provider)}
 * against the on-disk templates via {@link com.metaobjects.render.FilesystemProvider},
 * asserting the outputs pinned in the corpus README byte-for-byte:
 * <ul>
 *   <li>document {@code WelcomePage} → {@code "Hello Ada"}</li>
 *   <li>email {@code WelcomeEmail} → subject {@code "Welcome Ada"},
 *       htmlBody {@code "<p>Hi Ada</p>"}, textBody {@code "Hi Ada"}</li>
 *   <li>the {@code drift/} case → {@link GeneratorException} carrying
 *       {@code ERR_VAR_NOT_ON_PAYLOAD} + the offending field/ref/template.</li>
 * </ul>
 *
 * <p>Repo root is located by walking up from {@code user.dir} until the
 * {@code fixtures/template-output-render-conformance} directory is found — the same
 * strategy used by {@link TemplateOutputFixtureConformanceTest}.
 */
public class GeneratedRenderHelperConformanceTest extends SharedRegistryTestBase {

    // -------------------------------------------------------------------------
    // Locate the shared corpus once at class-load time.
    // -------------------------------------------------------------------------

    private static final Path CORPUS;
    static {
        Path p = Paths.get(System.getProperty("user.dir")).toAbsolutePath();
        while (p != null && !Files.exists(p.resolve("fixtures/template-output-render-conformance"))) {
            p = p.getParent();
        }
        CORPUS = (p != null) ? p.resolve("fixtures/template-output-render-conformance") : null;
    }

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    // -------------------------------------------------------------------------
    // document → "Hello Ada"
    // -------------------------------------------------------------------------

    @Test
    public void documentMatchesCorpusOracle() throws Exception {
        assertNotNull("fixtures/template-output-render-conformance must be reachable; check user.dir = "
                + System.getProperty("user.dir"), CORPUS);

        Path templates = CORPUS.resolve("templates");
        MetaDataLoader loader = loadCorpus(CORPUS.resolve("meta.json"), "doc");

        Path gen = tmp.newFolder("doc-gen").toPath();
        generate(loader, gen, templates);

        Path classes = compile(collectSources(gen));
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> payloadClass = cl.loadClass("acme.ai.prompts.WelcomePagePayload");
            Object payload = payloadClass.getConstructor(String.class).newInstance("Ada");

            Class<?> helperClass = cl.loadClass("acme.ai.prompts.WelcomePageRenderHelper");
            Class<?> providerClass = Class.forName("com.metaobjects.render.Provider");
            Object provider = newFilesystemProvider(templates);

            Method render = helperClass.getMethod("render", payloadClass, providerClass);
            assertEquals(String.class, render.getReturnType());
            assertEquals("Hello Ada", render.invoke(null, payload, provider));
        }
    }

    // -------------------------------------------------------------------------
    // email → EmailDocument
    // -------------------------------------------------------------------------

    @Test
    public void emailMatchesCorpusOracle() throws Exception {
        assertNotNull("corpus must be reachable", CORPUS);

        Path templates = CORPUS.resolve("templates");
        MetaDataLoader loader = loadCorpus(CORPUS.resolve("meta.json"), "email");

        Path gen = tmp.newFolder("email-gen").toPath();
        generate(loader, gen, templates);

        Path classes = compile(collectSources(gen));
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> payloadClass = cl.loadClass("acme.ai.prompts.WelcomeEmailPayload");
            Object payload = payloadClass.getConstructor(String.class).newInstance("Ada");

            Class<?> helperClass = cl.loadClass("acme.ai.prompts.WelcomeEmailRenderHelper");
            Class<?> providerClass = Class.forName("com.metaobjects.render.Provider");
            Class<?> emailDocClass = Class.forName("com.metaobjects.render.EmailDocument");
            Object provider = newFilesystemProvider(templates);

            Method render = helperClass.getMethod("render", payloadClass, providerClass);
            assertEquals(emailDocClass, render.getReturnType());
            Object email = render.invoke(null, payload, provider);

            assertEquals("Welcome Ada", emailDocClass.getMethod("subject").invoke(email));
            assertEquals("<p>Hi Ada</p>", emailDocClass.getMethod("htmlBody").invoke(email));
            assertEquals("Hi Ada", emailDocClass.getMethod("textBody").invoke(email));
        }
    }

    // -------------------------------------------------------------------------
    // drift → GeneratorException(ERR_VAR_NOT_ON_PAYLOAD)
    // -------------------------------------------------------------------------

    @Test
    public void driftCaseFailsCodegen() throws Exception {
        assertNotNull("corpus must be reachable", CORPUS);

        Path driftRoot = CORPUS.resolve("drift");
        Path templates = driftRoot.resolve("templates");
        MetaDataLoader loader = loadCorpus(driftRoot.resolve("meta.json"), "drift");

        Path gen = tmp.newFolder("drift-gen").toPath();
        GeneratorException ex = assertThrows(GeneratorException.class,
            () -> generate(loader, gen, templates));

        String msg = ex.getMessage();
        assertTrue("drift message must name ERR_VAR_NOT_ON_PAYLOAD; got: " + msg,
            msg.contains("ERR_VAR_NOT_ON_PAYLOAD"));
        assertTrue("drift message must name the offending field 'missing'; got: " + msg,
            msg.contains("missing"));
        assertTrue("drift message must name the template 'WelcomePage'; got: " + msg,
            msg.contains("WelcomePage"));
        assertTrue("drift message must name the ref 'pages/bad'; got: " + msg,
            msg.contains("pages/bad"));
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private MetaDataLoader loadCorpus(Path metaJson, String baseName) throws Exception {
        assertTrue("corpus meta.json must exist: " + metaJson, Files.exists(metaJson));
        Path ws = tmp.newFolder("ws-" + baseName).toPath();
        return SpringTestFixtures.loadFixture(ws, baseName, Files.readString(metaJson));
    }

    private static void generate(MetaDataLoader loader, Path gen, Path templates) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("templateRoot", templates.toString());

        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator();
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        SpringRenderHelperGenerator helperGen = new SpringRenderHelperGenerator();
        helperGen.setArgs(args);
        helperGen.execute(loader);
    }

    private static List<File> collectSources(Path gen) throws Exception {
        try (Stream<Path> s = Files.walk(gen)) {
            return s.filter(p -> p.toString().endsWith(".java"))
                    .map(Path::toFile)
                    .collect(Collectors.toList());
        }
    }

    private Path compile(List<File> sources) throws Exception {
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        assertNotNull("JDK (not JRE) required — getSystemJavaCompiler() returned null", javac);

        Path classes = tmp.newFolder("classes-" + System.nanoTime()).toPath();
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
            }
            for (File src : sources) {
                sb.append("\n=== ").append(src.getName()).append(" ===\n");
                sb.append(Files.readString(src.toPath())).append('\n');
            }
            fail(sb.toString());
        }
        return classes;
    }

    /** Construct a FilesystemProvider(Path) against the test classpath (render module). */
    private static Object newFilesystemProvider(Path root) throws Exception {
        Class<?> fsProvider = Class.forName("com.metaobjects.render.FilesystemProvider");
        return fsProvider.getConstructor(Path.class).newInstance(root);
    }
}
