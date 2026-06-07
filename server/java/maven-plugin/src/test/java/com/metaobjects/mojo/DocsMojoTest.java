package com.metaobjects.mojo;

import org.apache.maven.plugin.testing.MojoRule;
import org.codehaus.plexus.PlexusTestCase;
import org.junit.Rule;
import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

/**
 * Tests the {@code metaobjects:docs} goal — that it loads metadata from the
 * {@code <loader>} config, builds the {@code JavaApiModel}, renders it via
 * {@code JavaApiDocsRenderer}, and writes the Java api surface into the configured
 * {@code <apiSubDir>} with a model cross-link on each unit page (the SP-1
 * {@code apiSurfaces} {@code api/java} surface).
 */
public class DocsMojoTest {

    @Rule
    public MojoRule rule = new MojoRule();

    @Test
    public void emitsTheJavaApiSurface() throws Exception {
        File pom = new File(PlexusTestCase.getBasedir(), "src/test/resources/mojo/pom-docs.xml");

        DocsMojo mojo = (DocsMojo) rule.lookupMojo("docs", pom);
        assertNotNull(mojo);
        mojo.execute();

        // <outputDirectory> (target/docs-mojo-test/docs) / <apiSubDir> (api/java).
        Path apiBase = new File(PlexusTestCase.getBasedir(),
                "target/docs-mojo-test/docs/api/java").toPath();

        // The concrete Basket entity (package simple::fruitbasket → simple/fruitbasket)
        // produces an api page under its package folder for the package layout.
        Path basketPage = apiBase.resolve("simple/fruitbasket/Basket.md");
        assertTrue("expected entity api page at " + basketPage, Files.exists(basketPage));
        assertTrue("expected index README.md", Files.exists(apiBase.resolve("README.md")));
        assertTrue("expected condensed AGENT-API.md", Files.exists(apiBase.resolve("AGENT-API.md")));

        String page = Files.readString(basketPage);
        assertTrue("unit page emits the model/metadata cross-link",
                page.contains("**Model / metadata:**"));
        assertTrue("unit page emits a java code fence", page.contains("```java"));
    }
}
