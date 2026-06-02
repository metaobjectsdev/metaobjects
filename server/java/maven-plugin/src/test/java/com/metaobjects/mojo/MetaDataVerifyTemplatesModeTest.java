package com.metaobjects.mojo;

import org.apache.maven.plugin.MojoFailureException;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Tests {@code meta:verify -Dmeta.verify.mode=templates} — the NEW template/prompt
 * drift mode (ADR-0021 D2 fan-out) — plus the {@code mode} dispatch itself
 * (unknown / {@code db} → clear failure; default stays {@code codegen}).
 *
 * <p>The Mojo's {@code project}/{@code execution} fields are left null so
 * {@code createProjectClassLoader()} falls back to the test classloader (which can
 * see the metadata + render + codegen-base modules) — no MavenProject scaffolding,
 * matching {@link MetaDataVerifyMojoTest}.</p>
 */
public class MetaDataVerifyTemplatesModeTest {

    @Test
    public void templatesModePassesForCleanTemplate() throws Exception {
        Path templateRoot = writeTemplate("ai/greeting", "Hello {{title}} — {{body}}");

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configureTemplates(verify, templateRoot);
        // Every {{field}} is on MessagePayload → clean → no exception.
        verify.execute();
    }

    @Test
    public void templatesModeFailsForUnknownField() throws Exception {
        // {{subject}} is NOT on MessagePayload.
        Path templateRoot = writeTemplate("ai/greeting", "Hello {{title}} — {{subject}}");

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configureTemplates(verify, templateRoot);
        try {
            verify.execute();
            fail("expected MojoFailureException for an unknown {{field}}");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("template drift"));
            assertTrue(e.getMessage().contains("ERR_VAR_NOT_ON_PAYLOAD"));
            assertTrue(e.getMessage().contains("subject"));
            assertTrue(e.getMessage().contains("Greeting"));
        }
    }

    @Test
    public void templatesModeFailsForUnresolvedTextRef() throws Exception {
        // Do not write ai/greeting.mustache → @textRef cannot resolve.
        Path templateRoot = Files.createTempDirectory("verify-templates-missing");

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configureTemplates(verify, templateRoot);
        try {
            verify.execute();
            fail("expected MojoFailureException for an unresolved @textRef");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("template drift"));
            assertTrue(e.getMessage().contains("ai/greeting"));
        }
    }

    @Test
    public void unknownModeFailsClearly() throws Exception {
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configureTemplates(verify, Files.createTempDirectory("verify-unknown-mode"));
        verify.setMode("bogus");
        try {
            verify.execute();
            fail("expected MojoFailureException for an unknown mode");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("bogus"));
            assertTrue(e.getMessage().contains("codegen"));
            assertTrue(e.getMessage().contains("templates"));
        }
    }

    @Test
    public void dbModeFailsAsUnsupported() throws Exception {
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configureTemplates(verify, Files.createTempDirectory("verify-db-mode"));
        verify.setMode("db");
        try {
            verify.execute();
            fail("expected MojoFailureException for the db mode");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("db"));
            assertTrue(e.getMessage().toLowerCase().contains("migrate"));
        }
    }

    // === helpers ============================================================

    private static Path writeTemplate(String ref, String body) throws IOException {
        Path root = Files.createTempDirectory("verify-templates");
        Path file = root.resolve(ref + ".mustache");
        Files.createDirectories(file.getParent());
        Files.writeString(file, body);
        return root;
    }

    private void configureTemplates(MetaDataVerifyMojo mojo, Path templateRoot) {
        LoaderParam loader = LoaderParam.builder("verify-templates-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir("./src/test/resources")
                .withSource("mojo/verify-templates-metadata.json")
                .build();
        mojo.setLoader(loader);
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
        mojo.setMode("templates");
        mojo.setTemplateRoot(templateRoot.toString());
    }
}
