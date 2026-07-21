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
    // Gap 1 — email html SAFETY: @format=html part escapes markup/XSS; the
    // @format=text parts (subject, textBody) stay raw. Renders the EXISTING
    // WelcomeEmail with a special-char name (no fixture change). Expected strings
    // are derived from the actual engine output (xml escaper: < > & " ') and pinned.
    // -------------------------------------------------------------------------

    @Test
    public void emailHtmlPartEscapesButTextPartsRaw() throws Exception {
        assertNotNull("corpus must be reachable", CORPUS);

        Path templates = CORPUS.resolve("templates");
        MetaDataLoader loader = loadCorpus(CORPUS.resolve("meta.json"), "email-xss");

        Path gen = tmp.newFolder("email-xss-gen").toPath();
        generate(loader, gen, templates);

        Path classes = compile(collectSources(gen));
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> payloadClass = cl.loadClass("acme.ai.prompts.WelcomeEmailPayload");
            Object payload = payloadClass.getConstructor(String.class).newInstance("<b>A & Co</b>");

            Class<?> helperClass = cl.loadClass("acme.ai.prompts.WelcomeEmailRenderHelper");
            Class<?> providerClass = Class.forName("com.metaobjects.render.Provider");
            Class<?> emailDocClass = Class.forName("com.metaobjects.render.EmailDocument");
            Object provider = newFilesystemProvider(templates);

            Method render = helperClass.getMethod("render", payloadClass, providerClass);
            Object email = render.invoke(null, payload, provider);

            String htmlBody = (String) emailDocClass.getMethod("htmlBody").invoke(email);
            String subject  = (String) emailDocClass.getMethod("subject").invoke(email);
            String textBody = (String) emailDocClass.getMethod("textBody").invoke(email);

            // html part: < > & entity-escaped → no raw <b> tag reaches a mail client.
            assertEquals("<p>Hi &lt;b&gt;A &amp; Co&lt;/b&gt;</p>", htmlBody);
            assertFalse("html body must NOT contain a raw <b> tag; got: " + htmlBody,
                htmlBody.contains("<b>A"));
            // text parts (@format=text): raw, NOT escaped.
            assertEquals("Welcome <b>A & Co</b>", subject);
            assertEquals("Hi <b>A & Co</b>", textBody);
        }
    }

    // -------------------------------------------------------------------------
    // Gaps 2 + 3 — nested customer + array-of-items with a {{#items}} section loop
    // and a {{> shared/footer}} partial in the html body. Proves the field-tree
    // builder + build-time drift gate handle the nested/array shape (clean → no
    // throw) and that section loops + partials render for email.
    // -------------------------------------------------------------------------

    @Test
    public void emailOrderRendersNestedArrayLoopAndPartial() throws Exception {
        assertNotNull("corpus must be reachable", CORPUS);

        Path templates = CORPUS.resolve("templates");
        // The nested/array VOs live in nested/meta.json (a NO-PACKAGE sub-corpus) so
        // a BARE @objectRef resolves identically in both ports' render-helper
        // field-tree walks (TS resolves objectRef by short name; the JVM expands a
        // packaged ref to an FQN — bare == FQN only with no package). Both share
        // templates/. No package → generated classes land in the bare `prompts` pkg.
        MetaDataLoader loader = loadCorpus(CORPUS.resolve("nested").resolve("meta.json"), "order");

        Path gen = tmp.newFolder("order-gen").toPath();
        // The clean nested template must pass the build-time drift gate (no throw).
        generate(loader, gen, templates);

        Path classes = compile(collectSources(gen));
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            // SpringPayloadGenerator names nested payloads after the VO short name:
            // CustomerPayload + ItemPayload; the root payload after the template:
            // OrderEmailPayload(CustomerPayload customer, List<ItemPayload> items).
            Class<?> customerClass = cl.loadClass("prompts.CustomerPayload");
            Object customer = customerClass.getConstructor(String.class).newInstance("Ada");

            // field.int → boxed Integer in the generated payload record.
            Class<?> itemClass = cl.loadClass("prompts.ItemPayload");
            Object itemA = itemClass.getConstructor(String.class, Integer.class)
                .newInstance("A1", Integer.valueOf(2));
            Object itemB = itemClass.getConstructor(String.class, Integer.class)
                .newInstance("B2", Integer.valueOf(1));

            Class<?> payloadClass = cl.loadClass("prompts.OrderEmailPayload");
            Object payload = payloadClass
                .getConstructor(customerClass, java.util.List.class)
                .newInstance(customer, java.util.List.of(itemA, itemB));

            Class<?> helperClass = cl.loadClass("prompts.OrderEmailRenderHelper");
            Class<?> providerClass = Class.forName("com.metaobjects.render.Provider");
            Class<?> emailDocClass = Class.forName("com.metaobjects.render.EmailDocument");
            Object provider = newFilesystemProvider(templates);

            Method render = helperClass.getMethod("render", payloadClass, providerClass);
            Object email = render.invoke(null, payload, provider);

            assertEquals("Order for Ada", emailDocClass.getMethod("subject").invoke(email));
            assertEquals("<h1>Ada</h1><ul><li>A1 x2</li><li>B2 x1</li></ul><hr/>Sent by Acme",
                emailDocClass.getMethod("htmlBody").invoke(email));
            assertEquals("Order for Ada: A1 x2; B2 x1;",
                emailDocClass.getMethod("textBody").invoke(email));
            // Gap 3 — the partial resolved into the html body.
            assertTrue("html body must contain the resolved footer partial",
                ((String) emailDocClass.getMethod("htmlBody").invoke(email))
                    .contains("<hr/>Sent by Acme"));
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

    // -------------------------------------------------------------------------
    // xpkg-collision/ → ADR-0041 FQN-exact nested @objectRef resolution across a
    // cross-package short-name collision, end-to-end for the Java/Spring port
    // (#220 — the parity gap the other four ports already cover). Two packages
    // each declare object.value Note (alpha: alphaText, beta: betaText); payload
    // Digest references BOTH by FULLY-QUALIFIED @objectRef; DigestDoc renders
    // "Alpha={{fromAlpha.alphaText}} Beta={{fromBeta.betaText}}". Post-ADR-0044 the
    // two Notes emit as DISTINCT package-qualified records
    // (AcmeAlphaNotePayload / AcmeBetaNotePayload), so the generated code compiles
    // and renders — this gate exercises the FQN-exact resolver AND the collision
    // naming together (a bare-tail resolver would bind both refs to one Note and
    // render the wrong text; the pre-ADR-0044 clobber would not compile).
    // -------------------------------------------------------------------------
    @Test
    public void xpkgCollisionRenderHelperMatchesCorpusOracle() throws Exception {
        assertNotNull("corpus must be reachable", CORPUS);
        Path xpkg = CORPUS.resolve("xpkg-collision");
        Path templates = CORPUS.resolve("templates");
        MetaDataLoader loader = loadMultiFile("xpkg",
            xpkg.resolve("meta.alpha.json"),
            xpkg.resolve("meta.beta.json"),
            xpkg.resolve("meta.app.json"));

        Path gen = tmp.newFolder("xpkg-gen").toPath();
        generate(loader, gen, templates);

        Path classes = compile(collectSources(gen));
        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            // The two colliding Notes emit as DISTINCT package-qualified records.
            Class<?> alphaClass = cl.loadClass("acme.app.prompts.AcmeAlphaNotePayload");
            Class<?> betaClass = cl.loadClass("acme.app.prompts.AcmeBetaNotePayload");
            Object alpha = alphaClass.getConstructor(String.class).newInstance("AA");
            Object beta = betaClass.getConstructor(String.class).newInstance("BB");

            Class<?> payloadClass = cl.loadClass("acme.app.prompts.DigestDocPayload");
            Object payload = payloadClass.getConstructor(alphaClass, betaClass).newInstance(alpha, beta);

            Class<?> helperClass = cl.loadClass("acme.app.prompts.DigestDocRenderHelper");
            Class<?> providerClass = Class.forName("com.metaobjects.render.Provider");
            Object provider = newFilesystemProvider(templates);

            Method render = helperClass.getMethod("render", payloadClass, providerClass);
            assertEquals(String.class, render.getReturnType());
            // FQN-exact resolution binds each ref to its own package's Note.
            assertEquals("Alpha=AA Beta=BB", render.invoke(null, payload, provider));
        }
    }

    /** Load several metadata files into one merged loader (multi-package fixtures). */
    private MetaDataLoader loadMultiFile(String baseName, Path... files) throws Exception {
        java.util.List<java.net.URI> uris = new java.util.ArrayList<>();
        for (Path f : files) {
            uris.add(com.metaobjects.loader.uri.URIHelper.toURI(
                "model:file:" + f.toAbsolutePath().toString().replace('\\', '/')));
        }
        MetaDataLoader loader = new MetaDataLoader(
            com.metaobjects.loader.LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL, "rh-conf-" + baseName);
        loader.setSourceURIs(uris);
        loader.init();
        return loader;
    }

    /** Construct a FilesystemProvider(Path) against the test classpath (render module). */
    private static Object newFilesystemProvider(Path root) throws Exception {
        Class<?> fsProvider = Class.forName("com.metaobjects.render.FilesystemProvider");
        return fsProvider.getConstructor(Path.class).newInstance(root);
    }
}
