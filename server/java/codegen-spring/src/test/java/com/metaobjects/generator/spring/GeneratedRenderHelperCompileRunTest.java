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
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.*;

/**
 * Compile-and-run proof for {@link SpringRenderHelperGenerator}: generate the
 * payload record + the {@code <Name>RenderHelper} class, COMPILE both in-memory,
 * load the helper, reflectively invoke {@code render(payload, provider)}, and
 * assert the rendered output — for BOTH the {@code document} (→ String) and the
 * {@code email} (→ EmailDocument) kinds. Plus the headline: the BUILD-TIME drift
 * gate must FAIL codegen ({@code GeneratorException}) when a referenced mustache
 * carries a {@code {{field}}} the payload VO does not declare.
 *
 * <p>Mirrors {@link GeneratedOutputPromptCompileRunTest} (same javac + URLClassLoader
 * + reflection harness) and the TS port's {@code render-helper-codegen.test.ts}.
 */
public class GeneratedRenderHelperCompileRunTest extends SharedRegistryTestBase {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    // -------------------------------------------------------------------------
    // Fixtures — package acme::ai, payload WelcomeVO { name }
    // -------------------------------------------------------------------------

    private static final String DOCUMENT_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "WelcomeVO", "children": [
                { "field.string": { "name": "name", "@required": true } }
            ] } },
            { "template.output": {
                "name": "WelcomePage",
                "@kind": "document",
                "@payloadRef": "WelcomeVO",
                "@textRef": "pages/welcome",
                "@format": "html"
            } }
          ] }
        }
        """;

    private static final String EMAIL_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "WelcomeVO", "children": [
                { "field.string": { "name": "name", "@required": true } }
            ] } },
            { "template.output": {
                "name": "WelcomeEmail",
                "@kind": "email",
                "@payloadRef": "WelcomeVO",
                "@subjectRef": "email/welcome.subject",
                "@htmlBodyRef": "email/welcome.html",
                "@textBodyRef": "email/welcome.text"
            } }
          ] }
        }
        """;

    // Nested/array payload: Order { customer: Customer{name}, items: Item[]{sku,qty} }.
    // Used by the section-context drift cases below. NO package, so a BARE
    // @objectRef resolves to its FQN identically across ports (bare == FQN only
    // with no package — see GeneratedRenderHelperConformanceTest's order case).
    private static final String ORDER_FIXTURE = """
        {
          "metadata.root": { "children": [
            { "object.value": { "name": "Customer", "children": [
                { "field.string": { "name": "name" } }
            ] } },
            { "object.value": { "name": "Item", "children": [
                { "field.string": { "name": "sku" } },
                { "field.int": { "name": "qty" } }
            ] } },
            { "object.value": { "name": "Order", "children": [
                { "field.object": { "name": "customer", "@objectRef": "Customer" } },
                { "field.object": { "name": "items", "isArray": true, "@objectRef": "Item" } }
            ] } },
            { "template.output": {
                "name": "OrderEmail",
                "@kind": "email",
                "@payloadRef": "Order",
                "@subjectRef": "email/order.subject",
                "@htmlBodyRef": "email/order.html"
            } }
          ] }
        }
        """;

    // Packaged nested payload: package acme::ai, Order { customer: Customer{name} }
    // where the nested @objectRef is the BARE short name "Customer" (NOT an FQN /
    // relative ref). The cross-port render-helper consensus resolves a nested
    // @objectRef by bare short-name — so this MUST resolve the Customer field-tree
    // even though both VOs live under a package. (With the JVM package-folding
    // resolver, bare "Customer" would expand to "acme::ai::Customer" — which DOES
    // exist here — so to actually exercise the divergence the sibling VO's short
    // name must differ from what package-folding would yield; instead we rely on
    // the semantics: the render-helper must match TS's bare-name lookup exactly.)
    private static final String PACKAGED_ORDER_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "Customer", "children": [
                { "field.string": { "name": "name" } }
            ] } },
            { "object.value": { "name": "Order", "children": [
                { "field.object": { "name": "customer", "@objectRef": "Customer" } }
            ] } },
            { "template.output": {
                "name": "OrderDoc",
                "@kind": "document",
                "@payloadRef": "Order",
                "@textRef": "pages/order",
                "@format": "html"
            } }
          ] }
        }
        """;

    // -------------------------------------------------------------------------
    // Test 0 — PACKAGED nested @objectRef resolves by BARE short-name (cross-port
    // codegen consensus). Clean {{customer.name}} passes; drifted {{customer.bogus}}
    // fails with ERR_VAR_NOT_ON_PAYLOAD. With a package-FOLDING nested resolver the
    // bare "Customer" ref would not resolve under the package the same way the other
    // ports do → nested field-tree empty → {{customer.name}} would itself drift.
    // -------------------------------------------------------------------------

    @Test
    public void packagedNestedObjectRefResolvesByBareShortName() throws Exception {
        Path gen = tmp.newFolder("pkg-nested-gen").toPath();
        Path ws  = tmp.newFolder("pkg-nested-ws").toPath();
        Path templates = tmp.newFolder("pkg-nested-templates").toPath();
        // Clean: {{customer.name}} — name IS on the nested Customer VO.
        writeTemplate(templates, "pages/order.mustache", "Order for {{customer.name}}");

        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "pkg-nested", PACKAGED_ORDER_FIXTURE);

        // Drive ONLY the render-helper generator — this task scopes the nested
        // @objectRef bare-name resolution to the render-helper's own field-tree
        // walk. (SpringPayloadGenerator independently package-folds nested refs and
        // is out of scope here; the render-helper's build-time drift gate derives
        // its OWN field-tree and is fully self-contained.)
        // Clean nested-section template must NOT throw — the bare "Customer" ref
        // must resolve so {{customer.name}} is recognized as on-payload.
        generateRenderHelperOnly(loader, gen, templates);
        assertTrue("packaged nested codegen must emit the render helper",
            collectSources(gen).stream()
                .anyMatch(f -> f.getName().equals("OrderDocRenderHelper.java")));
    }

    @Test
    public void packagedNestedObjectRefDriftFailsCodegen() throws Exception {
        Path gen = tmp.newFolder("pkg-nested-drift-gen").toPath();
        Path ws  = tmp.newFolder("pkg-nested-drift-ws").toPath();
        Path templates = tmp.newFolder("pkg-nested-drift-templates").toPath();
        // {{customer.bogus}} — bogus is NOT on the nested Customer VO. Only resolves
        // as a drift IF the nested field-tree was built (bare-name resolution worked).
        writeTemplate(templates, "pages/order.mustache", "Order for {{customer.bogus}}");

        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "pkg-nested-drift", PACKAGED_ORDER_FIXTURE);

        GeneratorException ex = assertThrows(GeneratorException.class,
            () -> generateRenderHelperOnly(loader, gen, templates));

        String msg = ex.getMessage();
        assertTrue("nested-drift message must name ERR_VAR_NOT_ON_PAYLOAD; got: " + msg,
            msg.contains("ERR_VAR_NOT_ON_PAYLOAD"));
        assertTrue("nested-drift message must name the offending field 'bogus'; got: " + msg,
            msg.contains("bogus"));
        assertTrue("nested-drift message must name the template 'OrderDoc'; got: " + msg,
            msg.contains("OrderDoc"));
    }

    // -------------------------------------------------------------------------
    // Test 1 — document → String
    // -------------------------------------------------------------------------

    @Test
    public void documentRenderHelperCompilesAndRenders() throws Exception {
        Path gen = tmp.newFolder("doc-gen").toPath();
        Path ws  = tmp.newFolder("doc-ws").toPath();
        Path templates = tmp.newFolder("doc-templates").toPath();
        writeTemplate(templates, "pages/welcome.mustache", "Hello {{name}}");

        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "doc", DOCUMENT_FIXTURE);

        generate(loader, gen, templates);

        List<File> sources = collectSources(gen);
        assertTrue("WelcomePageRenderHelper.java must be generated; got: " + sources,
            sources.stream().anyMatch(f -> f.getName().equals("WelcomePageRenderHelper.java")));

        Path classes = compile(sources);

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> payloadClass = cl.loadClass("acme.ai.prompts.WelcomePagePayload");
            Object payload = payloadClass.getConstructor(String.class).newInstance("Ada");

            Class<?> helperClass = cl.loadClass("acme.ai.prompts.WelcomePageRenderHelper");
            Class<?> providerClass = Class.forName("com.metaobjects.render.Provider");
            Object provider = newFilesystemProvider(cl, templates);

            Method render = helperClass.getMethod("render", payloadClass, providerClass);
            // document → String
            assertEquals(String.class, render.getReturnType());
            Object result = render.invoke(null, payload, provider);
            assertEquals("Hello Ada", result);
        }
    }

    // -------------------------------------------------------------------------
    // Test 2 — email → EmailDocument
    // -------------------------------------------------------------------------

    @Test
    public void emailRenderHelperCompilesAndRenders() throws Exception {
        Path gen = tmp.newFolder("email-gen").toPath();
        Path ws  = tmp.newFolder("email-ws").toPath();
        Path templates = tmp.newFolder("email-templates").toPath();
        writeTemplate(templates, "email/welcome.subject.mustache", "Welcome {{name}}");
        writeTemplate(templates, "email/welcome.html.mustache", "<p>Hello {{name}}</p>");
        writeTemplate(templates, "email/welcome.text.mustache", "Hello {{name}}");

        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "email", EMAIL_FIXTURE);

        generate(loader, gen, templates);

        List<File> sources = collectSources(gen);
        assertTrue("WelcomeEmailRenderHelper.java must be generated; got: " + sources,
            sources.stream().anyMatch(f -> f.getName().equals("WelcomeEmailRenderHelper.java")));

        Path classes = compile(sources);

        try (URLClassLoader cl = new URLClassLoader(
                new URL[]{ classes.toUri().toURL() }, getClass().getClassLoader())) {

            Class<?> payloadClass = cl.loadClass("acme.ai.prompts.WelcomeEmailPayload");
            Object payload = payloadClass.getConstructor(String.class).newInstance("Ada");

            Class<?> helperClass = cl.loadClass("acme.ai.prompts.WelcomeEmailRenderHelper");
            Class<?> providerClass = Class.forName("com.metaobjects.render.Provider");
            Class<?> emailDocClass = Class.forName("com.metaobjects.render.EmailDocument");
            Object provider = newFilesystemProvider(cl, templates);

            Method render = helperClass.getMethod("render", payloadClass, providerClass);
            // email → EmailDocument
            assertEquals(emailDocClass, render.getReturnType());
            Object email = render.invoke(null, payload, provider);

            assertEquals("Welcome Ada", emailDocClass.getMethod("subject").invoke(email));
            assertEquals("<p>Hello Ada</p>", emailDocClass.getMethod("htmlBody").invoke(email));
            assertEquals("Hello Ada", emailDocClass.getMethod("textBody").invoke(email));
        }
    }

    // -------------------------------------------------------------------------
    // Test 3 — BUILD-TIME drift gate FAILS codegen on {{missing}}
    // -------------------------------------------------------------------------

    @Test
    public void driftGateFailsCodegenWhenMustacheReferencesUnknownField() throws Exception {
        Path gen = tmp.newFolder("drift-gen").toPath();
        Path ws  = tmp.newFolder("drift-ws").toPath();
        Path templates = tmp.newFolder("drift-templates").toPath();
        // {{missing}} is NOT on WelcomeVO — the build-time gate must reject it.
        writeTemplate(templates, "pages/welcome.mustache", "Hi {{missing}}");

        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "drift", DOCUMENT_FIXTURE);

        GeneratorException ex = assertThrows(GeneratorException.class,
            () -> generate(loader, gen, templates));

        String msg = ex.getMessage();
        assertTrue("drift message must name the ERR_VAR_NOT_ON_PAYLOAD code; got: " + msg,
            msg.contains("ERR_VAR_NOT_ON_PAYLOAD"));
        assertTrue("drift message must name the offending field 'missing'; got: " + msg,
            msg.contains("missing"));
        assertTrue("drift message must name the template 'WelcomePage'; got: " + msg,
            msg.contains("WelcomePage"));
        assertTrue("drift message must name the ref 'pages/welcome'; got: " + msg,
            msg.contains("pages/welcome"));
    }

    // -------------------------------------------------------------------------
    // Test 3c — BONUS: SECTION-context drift ({{#items}}{{bogus}}{{/items}}) is
    // caught — proving the drift gate walks nested/section context, not just root.
    // -------------------------------------------------------------------------

    @Test
    public void driftGateCatchesSectionContextDrift() throws Exception {
        Path gen = tmp.newFolder("sec-drift-gen").toPath();
        Path ws  = tmp.newFolder("sec-drift-ws").toPath();
        Path templates = tmp.newFolder("sec-drift-templates").toPath();
        writeTemplate(templates, "email/order.subject.mustache", "Order for {{customer.name}}");
        // {{bogus}} is NOT a field on the Item element type the {{#items}} section pushes.
        writeTemplate(templates, "email/order.html.mustache",
            "<ul>{{#items}}<li>{{bogus}}</li>{{/items}}</ul>");

        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "sec-drift", ORDER_FIXTURE);

        GeneratorException ex = assertThrows(GeneratorException.class,
            () -> generate(loader, gen, templates));

        String msg = ex.getMessage();
        assertTrue("section-drift message must name ERR_VAR_NOT_ON_PAYLOAD; got: " + msg,
            msg.contains("ERR_VAR_NOT_ON_PAYLOAD"));
        assertTrue("section-drift message must name the offending field 'bogus'; got: " + msg,
            msg.contains("bogus"));
        assertTrue("section-drift message must name the ref 'email/order.html'; got: " + msg,
            msg.contains("email/order.html"));
    }

    // -------------------------------------------------------------------------
    // Test 3d — BONUS inverse: a clean nested/array section template does NOT throw.
    // -------------------------------------------------------------------------

    @Test
    public void cleanNestedArraySectionTemplateDoesNotThrow() throws Exception {
        Path gen = tmp.newFolder("sec-clean-gen").toPath();
        Path ws  = tmp.newFolder("sec-clean-ws").toPath();
        Path templates = tmp.newFolder("sec-clean-templates").toPath();
        writeTemplate(templates, "email/order.subject.mustache", "Order for {{customer.name}}");
        writeTemplate(templates, "email/order.html.mustache",
            "<h1>{{customer.name}}</h1><ul>{{#items}}<li>{{sku}} x{{qty}}</li>{{/items}}</ul>");

        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "sec-clean", ORDER_FIXTURE);

        generate(loader, gen, templates);
        assertTrue("clean nested codegen must emit the render helper",
            collectSources(gen).stream()
                .anyMatch(f -> f.getName().equals("OrderEmailRenderHelper.java")));
    }

    // -------------------------------------------------------------------------
    // Test 3b — inverse: a clean template does NOT throw
    // -------------------------------------------------------------------------

    @Test
    public void cleanTemplateDoesNotThrow() throws Exception {
        Path gen = tmp.newFolder("clean-gen").toPath();
        Path ws  = tmp.newFolder("clean-ws").toPath();
        Path templates = tmp.newFolder("clean-templates").toPath();
        writeTemplate(templates, "pages/welcome.mustache", "Hello {{name}}");

        MetaDataLoader loader = SpringTestFixtures.loadFixture(ws, "clean", DOCUMENT_FIXTURE);

        // Must NOT throw.
        generate(loader, gen, templates);
        assertTrue("clean codegen must emit the render helper",
            collectSources(gen).stream()
                .anyMatch(f -> f.getName().equals("WelcomePageRenderHelper.java")));
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private static void generate(MetaDataLoader loader, Path gen, Path templates) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("templateRoot", templates.toString());

        // Payload record first so the render helper can reference the typed payload.
        SpringPayloadGenerator payloadGen = new SpringPayloadGenerator();
        payloadGen.setArgs(args);
        payloadGen.execute(loader);

        SpringRenderHelperGenerator helperGen = new SpringRenderHelperGenerator();
        helperGen.setArgs(args);
        helperGen.execute(loader);
    }

    /**
     * Drive ONLY {@link SpringRenderHelperGenerator} (no payload generator). Used
     * by the packaged-nested {@code @objectRef} cases, which assert the render
     * helper's OWN build-time drift gate (bare short-name nested resolution) in
     * isolation — {@code SpringPayloadGenerator}'s independent package-folding
     * nested-ref resolution is out of scope for this task.
     */
    private static void generateRenderHelperOnly(MetaDataLoader loader, Path gen, Path templates) {
        Map<String, String> args = new HashMap<>();
        args.put("outputDir", gen.toString());
        args.put("templateRoot", templates.toString());

        SpringRenderHelperGenerator helperGen = new SpringRenderHelperGenerator();
        helperGen.setArgs(args);
        helperGen.execute(loader);
    }

    private static void writeTemplate(Path root, String relPath, String body) throws Exception {
        Path out = root.resolve(relPath);
        Files.createDirectories(out.getParent());
        Files.writeString(out, body);
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

    /** Construct a FilesystemProvider(Path) reflectively against the test classpath. */
    private static Object newFilesystemProvider(URLClassLoader cl, Path root) throws Exception {
        Class<?> fsProvider = Class.forName("com.metaobjects.render.FilesystemProvider");
        return fsProvider.getConstructor(Path.class).newInstance(root);
    }
}
