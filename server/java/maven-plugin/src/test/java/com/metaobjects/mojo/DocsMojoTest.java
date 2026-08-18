package com.metaobjects.mojo;

import org.apache.maven.plugin.testing.MojoRule;
import org.codehaus.plexus.PlexusTestCase;
import org.junit.Rule;
import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertFalse;
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

    @Test
    public void regeneratingUpdatesThePages_itDoesNotFreezeAfterTheFirstRun() throws Exception {
        // A DO-NOT-EDIT artifact that stops updating is the worst kind of stale: the
        // command still reports success. This fires because the marker write-guard was
        // briefly applied here, and API pages are rendered from user-editable Mustache
        // templates that emit no marker — so run 1 wrote, run 2 refused, and the docs
        // silently froze while the build stayed green.
        //
        // The existing tests could not see it: each runs the mojo exactly ONCE. Only a
        // second run distinguishes "writes" from "keeps writing".
        File pom = new File(PlexusTestCase.getBasedir(), "src/test/resources/mojo/pom-docs.xml");
        Path apiBase = new File(PlexusTestCase.getBasedir(),
                "target/docs-mojo-test/docs/api/java").toPath();
        Path basketPage = apiBase.resolve("simple/fruitbasket/Basket.md");

        ((DocsMojo) rule.lookupMojo("docs", pom)).execute();
        assertTrue("first run should emit the page", Files.exists(basketPage));

        // Stand in for "the model changed": clobber the page, then regenerate. A second
        // run that refuses leaves the sentinel in place.
        Files.writeString(basketPage, "STALE SENTINEL\n");
        ((DocsMojo) rule.lookupMojo("docs", pom)).execute();

        String after = Files.readString(basketPage);
        assertFalse("second run must rewrite the page, not refuse it — a frozen "
                + "DO-NOT-EDIT artifact reports success while going stale",
                after.contains("STALE SENTINEL"));
        assertTrue("regenerated page should carry its normal content",
                after.contains("**Model / metadata:**"));
    }

    @Test
    public void emitsTheKotlinApiSurface() throws Exception {
        File pom = new File(PlexusTestCase.getBasedir(), "src/test/resources/mojo/pom-docs-kotlin.xml");

        DocsMojo mojo = (DocsMojo) rule.lookupMojo("docs", pom);
        assertNotNull(mojo);
        mojo.execute();

        // <language>kotlin</language> with no explicit <apiSubDir> → api/kotlin.
        Path apiBase = new File(PlexusTestCase.getBasedir(),
                "target/docs-mojo-test-kotlin/docs/api/kotlin").toPath();

        Path basketPage = apiBase.resolve("simple/fruitbasket/Basket.md");
        assertTrue("expected entity api page at " + basketPage, Files.exists(basketPage));
        assertTrue("expected index README.md", Files.exists(apiBase.resolve("README.md")));
        assertTrue("expected condensed AGENT-API.md", Files.exists(apiBase.resolve("AGENT-API.md")));

        String page = Files.readString(basketPage);
        assertTrue("unit page emits the model/metadata cross-link",
                page.contains("**Model / metadata:**"));
        assertTrue("unit page emits a kotlin code fence", page.contains("```kotlin"));
    }
}
