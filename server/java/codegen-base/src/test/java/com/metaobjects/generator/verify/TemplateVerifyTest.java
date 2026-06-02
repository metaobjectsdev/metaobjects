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

    // === helpers ============================================================

    private static void writeTemplate(Path root, String ref, String body) throws IOException {
        Path file = root.resolve(ref + ".mustache");
        Files.createDirectories(file.getParent());
        Files.writeString(file, body);
    }

    private static MetaDataLoader loadFixture(String baseName, String fixtureJson) throws IOException {
        Path tmp = Files.createTempDirectory("tv-fixture-" + baseName);
        Path fixture = tmp.resolve(baseName + ".json");
        Files.writeString(fixture, fixtureJson);
        URI uri = URIHelper.toURI("model:file:"
                + fixture.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
                LoaderOptions.create(false, false, true),
                MetaDataLoader.SUBTYPE_MANUAL,
                "tv-test-" + baseName);
        loader.setSourceURIs(List.of(uri));
        loader.init();
        return loader;
    }
}
