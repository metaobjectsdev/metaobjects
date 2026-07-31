package com.metaobjects.generator.verify;

import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;

import org.junit.Test;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Unit tests for {@link TemplateVerify} — the shared, Maven-free template/prompt
 * drift helper that powers {@code meta:verify -Dmeta.verify.mode=templates}.
 *
 * <p>Mirrors the cross-port reference algorithm in
 * {@code server/csharp/MetaObjects.Cli/VerifyCommand.cs}: for each {@code template.*}
 * node it derives the {@code @payloadRef} VO field tree and runs the render
 * {@link com.metaobjects.render.Verify} engine against the {@code @textRef} mustache
 * resolved from a filesystem template root.</p>
 */
public class TemplateVerifyTest {

    /**
     * A {@code template.prompt} whose mustache references ONLY fields the payload VO
     * declares ({@code title}, {@code body}) → clean, no drift.
     */
    private static final String CLEAN_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "MessagePayload", "children": [
                { "field.string": { "name": "title", "@required": true } },
                { "field.string": { "name": "body" } }
            ] } },
            { "template.prompt": {
                "name": "Greeting",
                "@payloadRef": "MessagePayload",
                "@textRef": "ai/greeting"
            } }
          ] }
        }
        """;

    /**
     * Same payload, but the mustache references {@code subject} — a field NOT on the
     * payload VO → {@code ERR_VAR_NOT_ON_PAYLOAD} drift naming {@code subject}.
     */
    private static final String DRIFT_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "MessagePayload", "children": [
                { "field.string": { "name": "title", "@required": true } },
                { "field.string": { "name": "body" } }
            ] } },
            { "template.prompt": {
                "name": "Greeting",
                "@payloadRef": "MessagePayload",
                "@textRef": "ai/greeting"
            } }
          ] }
        }
        """;

    @Test
    public void cleanTemplatePasses() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-clean-templates");
        writeTemplate(templateRoot, "ai/greeting", "Hello {{title}} — {{body}}");

        MetaDataLoader loader = loadFixture("clean", CLEAN_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertTrue("expected a clean outcome, got: " + out, out.ok());
        assertTrue("expected no drift errors", out.errors().isEmpty());
        assertTrue("expected every @textRef to resolve", out.unresolvedText().isEmpty());
    }

    @Test
    public void unknownFieldProducesDrift() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-drift-templates");
        // {{subject}} is NOT on MessagePayload.
        writeTemplate(templateRoot, "ai/greeting", "Hello {{title}} — {{subject}}");

        MetaDataLoader loader = loadFixture("drift", DRIFT_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertFalse("expected drift to be reported", out.ok());
        assertEquals(1, out.errors().size());
        TemplateVerify.Drift d = out.errors().get(0);
        assertEquals("acme::ai::Greeting", d.template());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", d.code());
        assertEquals("subject", d.path());
    }

    @Test
    public void unresolvedTextRefIsReported() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-missing-templates");
        // Intentionally do NOT write ai/greeting.mustache.

        MetaDataLoader loader = loadFixture("missing", CLEAN_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertFalse("an unresolved @textRef is not a clean outcome", out.ok());
        assertEquals(1, out.unresolvedText().size());
        assertTrue(out.unresolvedText().get(0).contains("ai/greeting"));
    }

    // === #193 — template.output bodies must be drift-checked against @payloadRef,
    // === parity with template.prompt. A document output's @textRef and an email
    // === output's @subjectRef/@htmlBodyRef/@textBodyRef were previously skipped
    // === (output = payload-resolution-only), so a {{field}} that drifted from the
    // === payload passed verify and only failed later at gen time.

    /** A {@code template.output @kind=email} referencing the payload VO by subject + html body. */
    private static final String EMAIL_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "MessagePayload", "children": [
                { "field.string": { "name": "title", "@required": true } },
                { "field.string": { "name": "body" } }
            ] } },
            { "template.output": {
                "name": "Welcome",
                "@kind": "email",
                "@payloadRef": "MessagePayload",
                "@subjectRef": "ai/subj",
                "@htmlBodyRef": "ai/html"
            } }
          ] }
        }
        """;

    /** A document {@code template.output} (no @kind → document) with a mustache body via @textRef. */
    private static final String DOCUMENT_OUTPUT_FIXTURE = """
        {
          "metadata.root": { "package": "acme::ai", "children": [
            { "object.value": { "name": "MessagePayload", "children": [
                { "field.string": { "name": "title", "@required": true } },
                { "field.string": { "name": "body" } }
            ] } },
            { "template.output": {
                "name": "Doc",
                "@payloadRef": "MessagePayload",
                "@textRef": "ai/doc",
                "@format": "json"
            } }
          ] }
        }
        """;

    @Test
    public void emailOutputCleanPasses() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-email-clean-templates");
        writeTemplate(templateRoot, "ai/subj", "Hello {{title}}");
        writeTemplate(templateRoot, "ai/html", "<p>Hi — {{body}}</p>");

        MetaDataLoader loader = loadFixture("email-clean", EMAIL_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertTrue("a clean email output must pass, got: " + out, out.ok());
        assertTrue("expected no drift errors", out.errors().isEmpty());
    }

    @Test
    public void emailOutputDriftIsCaught() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-email-drift-templates");
        writeTemplate(templateRoot, "ai/subj", "Hello {{title}}");
        // {{subject}} is NOT on MessagePayload — a drift in the HTML body part.
        writeTemplate(templateRoot, "ai/html", "<p>Hi — {{subject}}</p>");

        MetaDataLoader loader = loadFixture("email-drift", EMAIL_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertFalse("email-body drift must be reported (#193)", out.ok());
        assertEquals(1, out.errors().size());
        TemplateVerify.Drift d = out.errors().get(0);
        assertEquals("acme::ai::Welcome", d.template());
        assertEquals(TemplateVerify.KIND_OUTPUT, d.kind());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", d.code());
        assertEquals("subject", d.path());
    }

    @Test
    public void documentOutputBodyDriftIsCaught() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-doc-drift-templates");
        // {{subject}} is NOT on MessagePayload — a drift in the document body.
        writeTemplate(templateRoot, "ai/doc", "spec for {{title}} and {{subject}}");

        MetaDataLoader loader = loadFixture("doc-drift", DOCUMENT_OUTPUT_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertFalse("document-output body drift must be reported (#193)", out.ok());
        assertEquals(1, out.errors().size());
        TemplateVerify.Drift d = out.errors().get(0);
        assertEquals("acme::ai::Doc", d.template());
        assertEquals(TemplateVerify.KIND_OUTPUT, d.kind());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", d.code());
        assertEquals("subject", d.path());
    }

    // === Nested @objectRef FQN resolution across a cross-package short-name
    // === collision (ADR-0041). Two prompt trees each declare their OWN value
    // === object with the SAME short name `Row`, in different packages. The
    // === payload's collection field carries a FULLY-QUALIFIED @objectRef; the
    // === derived element field-tree must be the RIGHT package's Row — a bare-tail
    // === match would bind the wrong Row and spuriously flag the inner {{field}}.

    /** Package host::a — the payload + its OWN Row (has `order`). */
    private static final String HOST_A_FIXTURE = """
        {
          "metadata.root": { "package": "host::a", "children": [
            { "object.value": { "name": "Row", "children": [
                { "field.string": { "name": "order" } }
            ] } },
            { "object.value": { "name": "HostPayload", "children": [
                { "field.string": { "name": "title" } },
                { "field.object": { "name": "rows", "isArray": true, "@objectRef": "host::a::Row" } }
            ] } },
            { "template.prompt": {
                "name": "HostPrompt",
                "@payloadRef": "HostPayload",
                "@textRef": "host/tmpl"
            } }
          ] }
        }
        """;

    /** Package host::b — a DIFFERENT Row (same short name, field `somethingElse`, NOT `order`). */
    private static final String HOST_B_FIXTURE = """
        {
          "metadata.root": { "package": "host::b", "children": [
            { "object.value": { "name": "Row", "children": [
                { "field.string": { "name": "somethingElse" } }
            ] } }
          ] }
        }
        """;

    @Test
    public void nestedFqnObjectRefResolvesRightRowAcrossShortNameCollision() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-fqn-clean-templates");
        // {{order}} is on host::a::Row (the FQN target), NOT on host::b::Row.
        writeTemplate(templateRoot, "host/tmpl", "{{title}}\n{{#rows}}- {{order}}\n{{/rows}}");

        MetaDataLoader loader = loadFixtures("fqn-clean", HOST_A_FIXTURE, HOST_B_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertTrue("FQN @objectRef must resolve host::a::Row so {{order}} is clean; got: " + out,
            out.ok());
    }

    @Test
    public void nestedFqnObjectRefRejectsFieldFromTheCollidingRow() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-fqn-drift-templates");
        // {{somethingElse}} is on the OTHER (host::b) Row — proving we resolved the
        // FQN target (host::a::Row) and not the short-name collision.
        writeTemplate(templateRoot, "host/tmpl", "{{#rows}}- {{somethingElse}}\n{{/rows}}");

        MetaDataLoader loader = loadFixtures("fqn-drift", HOST_A_FIXTURE, HOST_B_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertFalse("a field from the colliding Row must NOT resolve", out.ok());
        assertEquals(1, out.errors().size());
        assertEquals("ERR_VAR_NOT_ON_PAYLOAD", out.errors().get(0).code());
        assertEquals("somethingElse", out.errors().get(0).path());
    }

    // === #228 — the @payloadRef resolver is package-local (ADR-0042). Two packages each
    // === declare their OWN payload VO `Report` (distinct field) AND a template.prompt with a
    // === BARE @payloadRef "Report". The prior package-blind bare-tail scan bound whichever
    // === Report loaded first, deriving the WRONG package's field tree and mis-reporting
    // === {{field}} drift. The fix binds each template's OWN package's Report — in BOTH orders.

    /** Package pv::alpha — its OWN Report (field alphaField) + a bare-@payloadRef prompt. */
    private static final String PAYLOAD_ALPHA_FIXTURE = """
        {
          "metadata.root": { "package": "pv::alpha", "children": [
            { "object.value": { "name": "Report", "children": [
                { "field.string": { "name": "alphaField" } }
            ] } },
            { "template.prompt": {
                "name": "ReportPrompt",
                "@payloadRef": "Report",
                "@textRef": "alpha/tmpl"
            } }
          ] }
        }
        """;

    /** Package pv::beta — a DIFFERENT Report (same short name, field betaField) + its own prompt. */
    private static final String PAYLOAD_BETA_FIXTURE = """
        {
          "metadata.root": { "package": "pv::beta", "children": [
            { "object.value": { "name": "Report", "children": [
                { "field.string": { "name": "betaField" } }
            ] } },
            { "template.prompt": {
                "name": "ReportPrompt",
                "@payloadRef": "Report",
                "@textRef": "beta/tmpl"
            } }
          ] }
        }
        """;

    private void assertBarePayloadRefBindsOwnPackage(String baseName, String first, String second)
            throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-payloadref-" + baseName);
        // Each template references ONLY its own package's field: clean iff each @payloadRef
        // binds its own package's Report (a wrong-package bind would drift on the other field).
        writeTemplate(templateRoot, "alpha/tmpl", "{{alphaField}}");
        writeTemplate(templateRoot, "beta/tmpl", "{{betaField}}");

        MetaDataLoader loader = loadFixtures(baseName, first, second);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertTrue("bare @payloadRef must bind each template's own package's Report; got: " + out,
                out.ok());
    }

    @Test
    public void barePayloadRefBindsOwnPackageAcrossCollision_alphaFirst() throws Exception {
        assertBarePayloadRefBindsOwnPackage("alpha-first", PAYLOAD_ALPHA_FIXTURE, PAYLOAD_BETA_FIXTURE);
    }

    @Test
    public void barePayloadRefBindsOwnPackageAcrossCollision_betaFirst() throws Exception {
        assertBarePayloadRefBindsOwnPackage("beta-first", PAYLOAD_BETA_FIXTURE, PAYLOAD_ALPHA_FIXTURE);
    }

    @Test
    public void barePayloadRefRejectsOtherPackagesField() throws Exception {
        Path templateRoot = Files.createTempDirectory("tv-payloadref-reject");
        // pv::alpha's prompt references betaField (only on pv::beta::Report) — must drift, proving
        // the alpha prompt bound pv::alpha::Report, not the colliding pv::beta::Report.
        writeTemplate(templateRoot, "alpha/tmpl", "{{betaField}}");
        writeTemplate(templateRoot, "beta/tmpl", "{{betaField}}");

        MetaDataLoader loader = loadFixtures("reject", PAYLOAD_ALPHA_FIXTURE, PAYLOAD_BETA_FIXTURE);

        TemplateVerify.Outcome out = TemplateVerify.run(loader, templateRoot);

        assertFalse("a field from the colliding package's Report must NOT resolve", out.ok());
        assertTrue("expected an ERR_VAR_NOT_ON_PAYLOAD for betaField on the alpha prompt; got: " + out,
                out.errors().stream().anyMatch(d ->
                        "pv::alpha::ReportPrompt".equals(d.template())
                                && "ERR_VAR_NOT_ON_PAYLOAD".equals(d.code())
                                && "betaField".equals(d.path())));
    }

    // === helpers ============================================================

    private static void writeTemplate(Path root, String ref, String body) throws IOException {
        Path file = root.resolve(ref + ".mustache");
        Files.createDirectories(file.getParent());
        Files.writeString(file, body);
    }

    private static MetaDataLoader loadFixture(String baseName, String fixtureJson) throws IOException {
        return loadFixtures(baseName, fixtureJson);
    }

    /**
     * Load one or more JSON fixtures into a single loader — each fixture may carry
     * its OWN {@code package}, which is how a cross-package short-name collision
     * (two {@code Row}s under different packages) is set up in one metadata graph.
     */
    private static MetaDataLoader loadFixtures(String baseName, String... fixtureJsons) throws IOException {
        Path tmp = Files.createTempDirectory("tv-fixture-" + baseName);
        List<URI> uris = new java.util.ArrayList<>();
        for (int i = 0; i < fixtureJsons.length; i++) {
            Path fixture = tmp.resolve(baseName + "-" + i + ".json");
            Files.writeString(fixture, fixtureJsons[i]);
            uris.add(URIHelper.toURI("model:file:"
                    + fixture.toAbsolutePath().toString().replace('\\', '/')));
        }
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL,
                "tv-test-" + baseName);
        loader.setSourceURIs(uris);
        loader.init();
        return loader;
    }
}
