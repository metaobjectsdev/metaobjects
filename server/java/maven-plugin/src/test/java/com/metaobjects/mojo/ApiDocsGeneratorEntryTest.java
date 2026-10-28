package com.metaobjects.mojo;

import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.apidocs.JavaApiDocsGenerator;
import com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsGenerator;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.testing.MojoRule;
import org.codehaus.plexus.PlexusTestCase;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The api reference is a {@code <generator>} entry like any other (ADR-0034 Amendment 9):
 * {@code metaobjects:generate} writes it for each language the list names, from the options
 * in that entry's {@code <args>}, and {@code metaobjects:verify} checks its pages with the
 * rest of the list.
 */
public class ApiDocsGeneratorEntryTest {

    private static final String JAVA_DOCS = JavaApiDocsGenerator.class.getName();
    private static final String KOTLIN_DOCS = KotlinApiDocsGenerator.class.getName();

    @Rule
    public MojoRule rule = new MojoRule();

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static File pom() {
        return new File(PlexusTestCase.getBasedir(), "src/test/resources/mojo/pom-api-docs.xml");
    }

    private static Path docs() {
        return new File(PlexusTestCase.getBasedir(), "target/api-docs-test/docs").toPath();
    }

    @Test
    public void theGenerateGoalWritesTheApiReferenceOfEachLanguageTheListNames() throws Exception {
        ((MetaDataGeneratorMojo) rule.lookupMojo("generate", pom())).execute();

        // The Java entry sets every option: <apiSubDir>, <layout>package (the Basket entity of
        // package simple::fruitbasket lands under its package folder), <projectName> and
        // <modelBaseUrl>.
        Path java = docs().resolve("reference/java");
        Path basket = java.resolve("simple/fruitbasket/Basket.md");
        assertTrue("expected entity api page at " + basket, Files.exists(basket));
        assertTrue("expected index README.md", Files.exists(java.resolve("README.md")));
        String page = Files.readString(basket);
        assertTrue(page, page.contains("```java"));
        assertTrue("the model link is written against <modelBaseUrl>: " + page,
                page.contains("**Model / metadata:**") && page.contains("https://docs.example.test/model/"));
        String agent = Files.readString(java.resolve("AGENT-API.md"));
        assertTrue("the agent page carries <projectName>: " + agent, agent.contains("fruit-shop"));

        // The Kotlin entry takes every default: api/kotlin, flat layout.
        Path kotlin = docs().resolve("api/kotlin");
        assertTrue(Files.exists(kotlin.resolve("README.md")));
        assertTrue(Files.exists(kotlin.resolve("AGENT-API.md")));
        String kotlinPage = Files.readString(kotlin.resolve("Basket.md"));
        assertTrue(kotlinPage, kotlinPage.contains("```kotlin"));
        assertFalse("no <modelBaseUrl>: the model link would be dead, so it is omitted: " + kotlinPage,
                kotlinPage.contains("**Model / metadata:**"));
    }

    @Test
    public void regeneratingUpdatesThePages_itDoesNotFreezeAfterTheFirstRun() throws Exception {
        // A DO-NOT-EDIT artifact that stops updating is the worst kind of stale: the
        // command still reports success. This fires because the marker write-guard was
        // briefly applied here, and API pages are rendered from user-editable Mustache
        // templates that emit no marker — so run 1 wrote, run 2 refused, and the docs
        // silently froze while the build stayed green. Only a second run distinguishes
        // "writes" from "keeps writing".
        Path basket = docs().resolve("reference/java/simple/fruitbasket/Basket.md");

        ((MetaDataGeneratorMojo) rule.lookupMojo("generate", pom())).execute();
        assertTrue("first run should emit the page", Files.exists(basket));

        // Stand in for "the model changed": clobber the page, then regenerate. A second
        // run that refuses leaves the sentinel in place.
        Files.writeString(basket, "STALE SENTINEL\n");
        ((MetaDataGeneratorMojo) rule.lookupMojo("generate", pom())).execute();

        String after = Files.readString(basket);
        assertFalse("second run must rewrite the page, not refuse it — a frozen "
                + "DO-NOT-EDIT artifact reports success while going stale",
                after.contains("STALE SENTINEL"));
        assertTrue("regenerated page should carry its normal content",
                after.contains("**Model / metadata:**"));
    }

    // ------------------------------------------------------------------------------------
    // verify covers the pages, as it covers every other entry's output
    // ------------------------------------------------------------------------------------

    private void configure(AbstractMetaDataMojo mojo, GeneratorParam... generators) {
        mojo.setLoader(LoaderParam.builder("api-docs-entry-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir("./src/test/resources")
                .withSource("mojo/verify-test-metadata.json")
                .build());
        mojo.setGenerators(new ArrayList<>(List.of(generators)));
        mojo.setGlobals(Collections.emptyMap());
    }

    private static GeneratorParam entry(String classname, Path outputDir, String... args) {
        GeneratorParam.Builder b = GeneratorParam.builder(classname).withArg("outputDir", outputDir.toString());
        for (int i = 0; i < args.length; i += 2) b.withArg(args[i], args[i + 1]);
        return b.build();
    }

    @Test
    public void theVerifyGoalChecksThePagesOfBothLanguagesInOneDirectory() throws Exception {
        Path committed = tmp.newFolder("docs").toPath();
        MetaDataGeneratorMojo generate = new MetaDataGeneratorMojo();
        configure(generate, entry(JAVA_DOCS, committed), entry(KOTLIN_DOCS, committed));
        generate.execute();

        MetaDataVerifyMojo inSync = new MetaDataVerifyMojo();
        configure(inSync, entry(JAVA_DOCS, committed), entry(KOTLIN_DOCS, committed));
        inSync.execute();

        Path page = committed.resolve("api/kotlin/Widget.md");
        Files.writeString(page, Files.readString(page) + "\nedited by hand\n", StandardCharsets.UTF_8);
        MetaDataVerifyMojo drifted = new MetaDataVerifyMojo();
        configure(drifted, entry(JAVA_DOCS, committed), entry(KOTLIN_DOCS, committed));
        try {
            drifted.execute();
            fail("expected the edited page to read as drift");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("[content-differs] " + page));
            assertFalse("only the edited page drifted: " + e.getMessage(), e.getMessage().contains("api/java"));
        }
    }

    @Test
    public void aLayoutThatNamesNoLayoutIsRefusedOnBothPorts() throws Exception {
        for (String classname : List.of(JAVA_DOCS, KOTLIN_DOCS)) {
            MetaDataGeneratorMojo generate = new MetaDataGeneratorMojo();
            Path out = tmp.newFolder().toPath();
            configure(generate, entry(classname, out, "layout", "packaged"));
            try {
                generate.execute();
                fail(classname + ": expected <layout>packaged</layout> to be refused");
            } catch (GeneratorException e) {
                assertTrue(e.getMessage(), e.getMessage().contains(
                        "api-docs: <layout> must be flat or package (got \"packaged\")"));
            }
        }
    }
}
