package com.metaobjects.mojo;

import com.metaobjects.generator.kotlin.KotlinEntityGenerator;
import com.metaobjects.mojo.test.OwnedDocsGenerator;
import org.apache.maven.plugin.testing.MojoRule;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * A {@link com.metaobjects.generator.DocsGenerator} writes documentation, not code: the docs goal
 * runs the one the project lists for a surface in place of the packaged one, and the generate and
 * verify goals leave it alone.
 */
public class DocsGeneratorGoalsTest {

    private static final String OWNED = OwnedDocsGenerator.class.getName();
    private static final String ENTITY = KotlinEntityGenerator.class.getName();

    @Rule
    public MojoRule rule = new MojoRule();

    private Path work;

    @Before
    public void scratch() throws Exception {
        work = Files.createTempDirectory("docs-goals");
    }

    private void configure(AbstractMetaDataMojo mojo, GeneratorParam... generators) {
        LoaderParam loader = LoaderParam.builder("docs-goals-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir("./src/test/resources")
                .withSource("mojo/verify-test-metadata.json")
                .build();
        mojo.setLoader(loader);
        mojo.setGenerators(new ArrayList<>(List.of(generators)));
        mojo.setGlobals(Collections.emptyMap());
    }

    private GeneratorParam generator(String classname, Path outputDir) {
        GeneratorParam.Builder b = GeneratorParam.builder(classname);
        if (outputDir != null) b.withArg("outputDir", outputDir.toString());
        return b.build();
    }

    private static List<String> files(Path root) throws Exception {
        if (!Files.isDirectory(root)) return List.of();
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(Files::isRegularFile).map(p -> root.relativize(p).toString()).sorted()
                    .collect(Collectors.toList());
        }
    }

    @Test
    public void theDocsGoalRunsTheOwnedGeneratorForItsSurfaceInPlaceOfThePackagedOne() throws Exception {
        DocsMojo docs = new DocsMojo();
        configure(docs, generator(OWNED, null));
        Path docsDir = work.resolve("docs");
        rule.setVariableValueToObject(docs, "outputDirectory", docsDir.toFile());
        rule.setVariableValueToObject(docs, "language", "java");
        docs.execute();

        // The owned generator's page, in the surface subdirectory the goal named, and none of the
        // packaged reference's.
        assertEquals(List.of("api/java/OWNED.md"), files(docsDir));
        assertEquals("owned docs for project\n", Files.readString(docsDir.resolve("api/java/OWNED.md")));
    }

    @Test
    public void aSurfaceNoGeneratorOwnsStillGetsThePackagedReference() throws Exception {
        DocsMojo docs = new DocsMojo();
        configure(docs, generator(OWNED, null));
        Path docsDir = work.resolve("docs");
        rule.setVariableValueToObject(docs, "outputDirectory", docsDir.toFile());
        rule.setVariableValueToObject(docs, "language", "java,kotlin");
        docs.execute();

        List<String> written = files(docsDir);
        assertTrue(written.toString(), written.contains("api/java/OWNED.md"));
        assertTrue(written.toString(), written.contains("api/kotlin/README.md"));
        assertTrue(written.toString(), written.contains("api/kotlin/AGENT-API.md"));
        assertFalse(written.toString(), written.contains("api/java/README.md"));
    }

    @Test
    public void theGenerateGoalSkipsADocsGeneratorAndRunsTheRest() throws Exception {
        Path out = work.resolve("generated");
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, generator(ENTITY, out), generator(OWNED, out));
        gen.execute();

        List<String> written = files(out);
        assertTrue("the code generator ran: " + written, written.stream().anyMatch(f -> f.endsWith(".kt")));
        assertFalse("the docs generator was skipped: " + written, written.stream().anyMatch(f -> f.endsWith("OWNED.md")));
    }

    @Test
    public void theVerifyGoalSkipsADocsGeneratorEvenWithNoOutputDirOrCommittedPages() throws Exception {
        Path committed = work.resolve("committed");
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, generator(ENTITY, committed));
        gen.execute();

        // A docs generator with no outputDir would fail verify as unverifiable, and one with an
        // outputDir would read as a page the repository lacks, if verify ran it.
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, generator(ENTITY, committed), generator(OWNED, null));
        verify.execute();

        MetaDataVerifyMojo withDir = new MetaDataVerifyMojo();
        configure(withDir, generator(ENTITY, committed), generator(OWNED, work.resolve("docs-not-committed")));
        withDir.execute();
    }
}
