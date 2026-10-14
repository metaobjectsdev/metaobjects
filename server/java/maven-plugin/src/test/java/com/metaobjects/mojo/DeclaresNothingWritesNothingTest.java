package com.metaobjects.mojo;

import com.metaobjects.generator.direct.object.javacode.JavaObjectCodeGenerator;
import com.metaobjects.generator.kotlin.KotlinEntityGenerator;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

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
 * Nothing is generated that the pom does not declare (ADR-0034 Amendment 9).
 *
 * <p>The rule has two halves, and each port is held to both. A pom whose {@code <generators>}
 * is empty or absent writes zero files: no default generator set, no documentation. And a
 * pom that lists one generator gets that generator's files and no other's: the Java
 * {@code entity} wrote a {@code <Name>Extractor} beside each class through 8.0, and the api
 * reference was written by a goal of its own.</p>
 */
public class DeclaresNothingWritesNothingTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private Path module;

    @Before
    public void aModuleOfItsOwn() throws Exception {
        module = tmp.newFolder("module").toPath();
    }

    /** A generate goal in a module of its own, so every file the run writes is under it. */
    private MetaDataGeneratorMojo generateGoal(List<GeneratorParam> generators) {
        MetaDataGeneratorMojo mojo = new MetaDataGeneratorMojo();
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(module.toFile());
        mojo.project = project;
        mojo.setLoader(LoaderParam.builder("declares-nothing-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(new File("src/test/resources").getAbsolutePath())
                .withSource("mojo/verify-test-metadata.json")
                .build());
        mojo.setGenerators(generators);
        mojo.setGlobals(Collections.emptyMap());
        return mojo;
    }

    private List<String> written() throws Exception {
        try (Stream<Path> s = Files.walk(module)) {
            return s.filter(Files::isRegularFile)
                    .map(p -> module.relativize(p).toString().replace(File.separatorChar, '/'))
                    .sorted().collect(Collectors.toList());
        }
    }

    @Test
    public void aPomWithNoGeneratorsElementWritesZeroFiles() throws Exception {
        generateGoal(null).execute();
        assertEquals(List.of(), written());
    }

    @Test
    public void aPomWithAnEmptyGeneratorsListWritesZeroFiles() throws Exception {
        generateGoal(new ArrayList<>()).execute();
        assertEquals(List.of(), written());
    }

    @Test
    public void java_aPomThatListsOnlyEntityGetsItsClassesAndNoExtractorOrApiReference() throws Exception {
        generateGoal(new ArrayList<>(List.of(GeneratorParam.builder(JavaObjectCodeGenerator.class.getName())
                .withArg("outputDir", "generated")
                .withArg("type", "class")
                .withArg("flavor", "pojoAware")
                .build()))).execute();

        assertEquals(List.of(
                "generated/META-INF/services/com.metaobjects.registry.ObjectClassBindingProvider",
                "generated/com/metaobjects/generated/GeneratedObjectClassBindingProvider.java",
                "generated/verify/demo/Gadget.java",
                "generated/verify/demo/Widget.java"), written());
    }

    @Test
    public void kotlin_aPomThatListsOnlyEntityGetsItsFilesAndNoApiReference() throws Exception {
        generateGoal(new ArrayList<>(List.of(GeneratorParam.builder(KotlinEntityGenerator.class.getName())
                .withArg("outputDir", "generated")
                .build()))).execute();

        List<String> written = written();
        assertFalse("the listed generator wrote nothing", written.isEmpty());
        assertTrue("a file the entry did not declare: " + written,
                written.stream().allMatch(f -> f.startsWith("generated/verify/demo/") && f.endsWith(".kt")));
    }
}
