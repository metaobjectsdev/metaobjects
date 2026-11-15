package com.metaobjects.mojo;

import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.project.MavenProject;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/**
 * ADR-0062: an output a generator writes straight through {@code writeIfChanged} is in no hash
 * manifest, yet a run that finds it gone must render again rather than skip.
 */
public class UnrecordedOutputSkipTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    public static class DirectWriteGenerator extends GeneratorBase {
        static int runs;

        @Override
        public void execute(MetaDataLoader loader) {
            runs++;
            try {
                GeneratedFileWriter.writeIfChanged(getOutputDir().toPath().resolve("plain.json"), "{}\n");
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        }
    }

    private Path project;
    private Path engine;

    @Before
    public void setUp() throws IOException {
        project = tmp.getRoot().toPath();
        engine = tmp.newFolder("engine").toPath();
        DirectWriteGenerator.runs = 0;
        Files.createDirectories(project.resolve("metaobjects"));
        Files.copy(Path.of("src/test/resources/mojo/verify-test-metadata.json"),
                project.resolve("metaobjects/meta.shop.json"));
        Files.writeString(engine.resolve("engine.class"), "v1");
    }

    @After
    public void tearDown() {
        DirectWriteGenerator.runs = 0;
    }

    private void gen() throws Exception {
        MetaDataGeneratorMojo m = new MetaDataGeneratorMojo() {
            @Override
            protected List<Path> engineClasspath() {
                return List.of(engine);
            }
        };
        MavenProject p = Mockito.mock(MavenProject.class);
        Mockito.when(p.getBasedir()).thenReturn(project.toFile());
        m.project = p;
        m.setLoader(LoaderParam.builder("unrecorded")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(project.resolve("metaobjects").toString())
                .build());
        GeneratorParam g = new GeneratorParam();
        g.setClassname(DirectWriteGenerator.class.getName());
        g.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, "gen"));
        m.setGenerators(List.of(g));
        m.execute();
    }

    @Test
    public void aDeletedUnrecordedOutputMakesTheNextRunRender() throws Exception {
        gen();
        assertEquals(1, DirectWriteGenerator.runs);
        Path out = project.resolve("gen/plain.json");
        assertTrue(Files.isRegularFile(out));

        gen();
        assertEquals("nothing changed: the second run skips", 1, DirectWriteGenerator.runs);

        Files.delete(out);
        gen();
        assertEquals("the output is gone: the run must render", 2, DirectWriteGenerator.runs);
        assertTrue("the output is back", Files.isRegularFile(out));
    }
}
