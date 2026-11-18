package com.metaobjects.mojo;

import com.metaobjects.MetaDataException;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.HashManifest;
import com.metaobjects.loader.LoaderConfigurationConstants;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.mojo.MetaDataGeneratorMojoManifestTest.ConfigurableFileGenerator;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * {@code -Dmeta.entities}: which names it accepts, what it refuses, that it reaches every
 * generator, and that a narrowed run leaves the files it did not regenerate alone. What a
 * narrowed generator writes is covered beside the generators (SpringSelectionTest,
 * KotlinSelectionTest).
 */
public class MetaDataGeneratorMojoEntitiesTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    private static final String BODY = "/** GENERATED */\npublic class X {}\n";

    private MetaDataGeneratorMojo mojo;
    private Path projectRoot;

    @Before
    public void setUp() {
        mojo = new MetaDataGeneratorMojo();
        mojo.setLoader(new LoaderParam());
        MavenProject project = Mockito.mock(MavenProject.class);
        projectRoot = tempFolder.getRoot().toPath();
        Mockito.when(project.getBasedir()).thenReturn(tempFolder.getRoot());
        mojo.project = project;
    }

    private static MetaDataLoader canonicalModel() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/persistence-conformance/canonical/meta.fitness.json");
            if (Files.isRegularFile(candidate)) {
                return MetaDataLoader.fromUris("entities-test", List.of(candidate.toUri()));
            }
            dir = dir.getParent();
        }
        throw new AssertionError("fixtures/persistence-conformance/canonical/meta.fitness.json not found");
    }

    private List<Generator> build(String outDir, String filename) {
        GeneratorParam p = new GeneratorParam();
        p.setClassname(ConfigurableFileGenerator.class.getName());
        p.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, outDir, "filename", filename, "content", BODY));
        mojo.setGenerators(List.of(p));
        return mojo.buildGenerators(getClass().getClassLoader(), null);
    }

    @Test
    public void noSelectionSelectsEverything() {
        assertNull(mojo.selectedEntities(canonicalModel()));
    }

    @Test
    public void namesAreTrimmedAndCountedOnce() {
        mojo.entities = " Person , Week,Person ";
        assertEquals(List.of("Person", "Week"), mojo.selectedEntities(canonicalModel()));
    }

    @Test
    public void aBlankSelectionIsRefused() {
        mojo.entities = " , ";
        MetaDataException e = assertThrows(MetaDataException.class, () -> mojo.selectedEntities(null));
        assertEquals("mvn metaobjects:generate: meta.entities names no object.", e.getMessage());
    }

    @Test
    public void aNameMatchingNoObjectIsRefused() {
        mojo.entities = "Person,Nope,fitness::Week";
        MetaDataException e = assertThrows(MetaDataException.class, () -> mojo.selectedEntities(canonicalModel()));
        assertEquals("mvn metaobjects:generate: meta.entities names 'Nope', 'fitness::Week',"
                + " which matches no object in the metadata.", e.getMessage());
    }

    @Test
    public void theSelectionReachesEveryGenerator() throws IOException {
        mojo.entities = "Person";
        List<Generator> gens = build(tempFolder.newFolder("gen").getAbsolutePath(), "Person.java");
        mojo.executeGenerators(null, gens);
        assertEquals(java.util.Set.of("Person"), ((GeneratorBase) gens.get(0)).getEntities());
    }

    /** A narrowed run did not try to produce the other files, so it neither deletes nor forgets them. */
    @Test
    public void aNarrowedRunDeletesNoOrphan() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path week = Path.of(outDir, "Week.java");
        mojo.executeGenerators(null, build(outDir, "Week.java"));
        assertTrue(Files.exists(week));

        mojo.entities = "Person";
        mojo.executeGenerators(null, build(outDir, "Person.java"));

        assertTrue("a narrowed run deletes nothing", Files.exists(week));
        Map<String, String> manifest = HashManifest.load(projectRoot.resolve(".metaobjects").resolve(".gen-state"));
        assertTrue("and forgets nothing", manifest.containsKey("gen/Week.java"));
        assertTrue(manifest.containsKey("gen/Person.java"));

        // The same change without a selection is a real orphan, and is swept.
        mojo.entities = null;
        mojo.executeGenerators(null, build(outDir, "Person.java"));
        assertFalse(Files.exists(week));
    }

    @Test
    public void theLoaderTimeoutReachesTheLoader() {
        assertFalse(mojo.loaderArgs(true).containsKey(LoaderConfigurationConstants.ARG_INIT_TIMEOUT_MS));
        mojo.setLoaderTimeoutMs(120_000L);
        assertEquals("120000", mojo.loaderArgs(true).get(LoaderConfigurationConstants.ARG_INIT_TIMEOUT_MS));
    }
}
