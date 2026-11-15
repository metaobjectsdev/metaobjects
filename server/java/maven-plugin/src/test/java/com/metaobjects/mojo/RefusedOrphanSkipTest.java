package com.metaobjects.mojo;

import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.project.MavenProject;
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
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * ADR-0062: a run whose orphan sweep kept an edited orphan is incomplete. It stores no key, so
 * the next run renders again and repeats the refusal instead of printing "nothing changed".
 */
public class RefusedOrphanSkipTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    public static class TwoFileGenerator extends GeneratorBase {
        static int runs;

        @Override
        public void execute(MetaDataLoader loader) {
            runs++;
            try {
                Path dir = getOutputDir().toPath();
                GeneratedFileWriter.write(dir.resolve("Keep.java"), "/** GENERATED */\nclass Keep {}\n");
                if ("both".equals(getArg("mode"))) {
                    GeneratedFileWriter.write(dir.resolve("Gone.java"), "/** GENERATED */\nclass Gone {}\n");
                }
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
        TwoFileGenerator.runs = 0;
        Files.createDirectories(project.resolve("metaobjects"));
        Files.copy(Path.of("src/test/resources/mojo/verify-test-metadata.json"),
                project.resolve("metaobjects/meta.shop.json"));
        Files.writeString(engine.resolve("engine.class"), "v1");
    }

    private void gen(String mode) throws Exception {
        MetaDataGeneratorMojo m = new MetaDataGeneratorMojo() {
            @Override
            protected List<Path> engineClasspath() {
                return List.of(engine);
            }
        };
        MavenProject p = Mockito.mock(MavenProject.class);
        Mockito.when(p.getBasedir()).thenReturn(project.toFile());
        m.project = p;
        m.setLoader(LoaderParam.builder("refused-orphan")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(project.resolve("metaobjects").toString())
                .build());
        GeneratorParam g = new GeneratorParam();
        g.setClassname(TwoFileGenerator.class.getName());
        g.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, "gen", "mode", mode));
        m.setGenerators(List.of(g));
        m.execute();
    }

    private boolean hasFingerprint() throws IOException {
        Path state = project.resolve(".metaobjects/.gen-state");
        if (!Files.isDirectory(state)) return false;
        try (var s = Files.list(state)) {
            return s.anyMatch(p -> p.getFileName().toString().startsWith(".fingerprint-"));
        }
    }

    @Test
    public void anEditedOrphanTheSweepKeepsStoresNoKey() throws Exception {
        gen("both");
        assertTrue(hasFingerprint());
        Path orphan = project.resolve("gen/Gone.java");
        Files.writeString(orphan, Files.readString(orphan) + "// mine\n");

        gen("one");
        assertTrue("the edited orphan is kept", Files.isRegularFile(orphan));
        assertEquals(2, TwoFileGenerator.runs);
        assertFalse("a run whose sweep refused stored a key", hasFingerprint());

        gen("one");
        assertEquals("nothing is stored, so the next run renders again", 3, TwoFileGenerator.runs);
    }
}
