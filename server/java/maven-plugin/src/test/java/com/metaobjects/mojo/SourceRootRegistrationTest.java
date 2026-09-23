package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.project.MavenProject;
import org.junit.Before;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import org.junit.Rule;
import org.mockito.Mockito;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;

/**
 * F23 — {@code metaobjects:generate} never registered its {@code outputDir} as a Maven
 * source root, so {@code mvn compile} in an adopter module compiled zero of the classes it
 * had just written unless the adopter hand-added {@code build-helper-maven-plugin}. These
 * tests hold {@link MetaDataGeneratorMojo#executeGenerators} to the fix: after running the
 * declared generators, it must tell the {@link MavenProject} about every {@code outputDir}
 * that actually holds compilable ({@code .java}/{@code .kt}) output — and only those.
 */
public class SourceRootRegistrationTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** Writes one file into its {@code outputDir} arg when executed. */
    public static class FileWritingGenerator extends GeneratorBase {
        private final String filename;

        public FileWritingGenerator() {
            this("Foo.java");
        }

        protected FileWritingGenerator(String filename) {
            this.filename = filename;
        }

        @Override
        public void execute(MetaDataLoader loader) {
            try {
                Path dir = getOutputDir().toPath();
                Files.writeString(dir.resolve(filename), "// GENERATED\n", StandardCharsets.UTF_8);
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        }
    }

    /** Same, but the file it writes is not Java/Kotlin source. */
    public static class DocsOnlyGenerator extends FileWritingGenerator {
        public DocsOnlyGenerator() {
            super("notes.md");
        }
    }

    /** Writes a {@code .kt} file, standing in for a Kotlin generator's output. */
    public static class KotlinFileWritingGenerator extends FileWritingGenerator {
        public KotlinFileWritingGenerator() {
            super("Foo.kt");
        }
    }

    private MetaDataGeneratorMojo mojo;
    private MavenProject project;

    @Before
    public void setUp() {
        mojo = new MetaDataGeneratorMojo();
        mojo.setLoader(new LoaderParam());
        project = Mockito.mock(MavenProject.class);
        mojo.project = project;
    }

    private static GeneratorParam param(Class<?> impl, String outputDir) {
        GeneratorParam p = new GeneratorParam();
        p.setClassname(impl.getName());
        p.setArgs(Map.of(GeneratorBase.ARG_OUTPUTDIR, outputDir));
        return p;
    }

    private List<Generator> build(GeneratorParam... params) {
        mojo.setGenerators(List.of(params));
        return mojo.buildGenerators(getClass().getClassLoader(), null);
    }

    @Test
    public void aGeneratorThatWritesJavaRegistersItsOutputDirAsACompileSourceRoot() throws IOException {
        String outDir = tempFolder.newFolder("gen-java").getAbsolutePath();
        List<Generator> impls = build(param(FileWritingGenerator.class, outDir));

        mojo.executeGenerators(null, impls);

        Mockito.verify(project).addCompileSourceRoot(
                Path.of(outDir).toAbsolutePath().normalize().toString());
        Mockito.verify(project, Mockito.never()).addTestCompileSourceRoot(Mockito.anyString());
    }

    @Test
    public void aGeneratorThatWritesKotlinRegistersItsOutputDirToo() throws IOException {
        String outDir = tempFolder.newFolder("gen-kotlin").getAbsolutePath();
        List<Generator> impls = build(param(KotlinFileWritingGenerator.class, outDir));

        mojo.executeGenerators(null, impls);

        Mockito.verify(project).addCompileSourceRoot(
                Path.of(outDir).toAbsolutePath().normalize().toString());
    }

    @Test
    public void aGeneratorThatWritesOnlyNonSourceFilesRegistersNothing() throws IOException {
        String outDir = tempFolder.newFolder("gen-docs").getAbsolutePath();
        List<Generator> impls = build(param(DocsOnlyGenerator.class, outDir));

        mojo.executeGenerators(null, impls);

        Mockito.verify(project, Mockito.never()).addCompileSourceRoot(Mockito.anyString());
        Mockito.verify(project, Mockito.never()).addTestCompileSourceRoot(Mockito.anyString());
    }

    @Test
    public void twoGeneratorsSharingAnOutputDirRegisterItOnlyOnce() throws IOException {
        String outDir = tempFolder.newFolder("gen-shared").getAbsolutePath();
        List<Generator> impls = build(
                param(FileWritingGenerator.class, outDir),
                param(DocsOnlyGenerator.class, outDir));

        mojo.executeGenerators(null, impls);

        Mockito.verify(project, Mockito.times(1)).addCompileSourceRoot(
                Path.of(outDir).toAbsolutePath().normalize().toString());
    }

    @Test
    public void aGeneratorWithNoOutputDirArgIsSkippedWithoutError() {
        GeneratorParam p = new GeneratorParam();
        p.setClassname(com.metaobjects.mojo.test.GeneratorTest.class.getName());
        List<Generator> impls = build(p);

        mojo.executeGenerators(null, impls);

        Mockito.verify(project, Mockito.never()).addCompileSourceRoot(Mockito.anyString());
    }

    @Test
    public void generateTestSourcesPhaseRegistersATestCompileSourceRootInstead() throws IOException {
        String outDir = tempFolder.newFolder("gen-test").getAbsolutePath();
        List<Generator> impls = build(param(FileWritingGenerator.class, outDir));

        MojoExecution execution = Mockito.mock(MojoExecution.class);
        Mockito.when(execution.getLifecyclePhase())
                .thenReturn(AbstractMetaDataMojo.PHASE_GENERATE_TEST_SOURCES);
        mojo.execution = execution;

        mojo.executeGenerators(null, impls);

        String abs = Path.of(outDir).toAbsolutePath().normalize().toString();
        Mockito.verify(project).addTestCompileSourceRoot(abs);
        Mockito.verify(project, Mockito.never()).addCompileSourceRoot(Mockito.anyString());
    }
}
