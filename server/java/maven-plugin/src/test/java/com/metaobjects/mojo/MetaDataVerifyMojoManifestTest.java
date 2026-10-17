package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.model.Build;
import org.apache.maven.model.Plugin;
import org.apache.maven.model.PluginExecution;
import org.apache.maven.plugin.MojoExecution;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugin.descriptor.MojoDescriptor;
import org.apache.maven.project.MavenProject;
import org.codehaus.plexus.util.xml.Xpp3Dom;
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

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * {@code mvn metaobjects:verify}'s codegen-drift goal, once a project has a committed
 * codegen hash manifest: an extra committed file is classified against it (stranger /
 * pristine / edited) rather than reported blindly, and the failure message's remedy
 * matches what {@code mvn metaobjects:generate} will actually do about it.
 */
public class MetaDataVerifyMojoManifestTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /** Writes one configurable file through the real write guard, same as
     *  {@link MetaDataGeneratorMojoManifestTest}'s generator. */
    public static class ConfigurableFileGenerator extends GeneratorBase {
        @Override
        public void execute(MetaDataLoader loader) {
            try {
                Path dir = getOutputDir().toPath();
                String filename = getArg("filename", "Foo.java");
                String content = getArg("content", "/** GENERATED */\npublic class Foo {}\n");
                GeneratedFileWriter.write(dir.resolve(filename), content);
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        }
    }

    private static final String MARKER_BODY = "/** GENERATED */\npublic class X {}\n";

    private MavenProject mavenProject(Path basedir) {
        MavenProject project = Mockito.mock(MavenProject.class);
        Mockito.when(project.getBasedir()).thenReturn(basedir.toFile());
        return project;
    }

    private GeneratorParam param(String outDir, String filename, String content, String handEdits) {
        GeneratorParam p = new GeneratorParam();
        p.setClassname(ConfigurableFileGenerator.class.getName());
        p.setArgs(Map.of(
                GeneratorBase.ARG_OUTPUTDIR, outDir,
                "filename", filename,
                "content", content));
        if (handEdits != null) p.setHandEdits(handEdits);
        return p;
    }

    /** A loader pointed at the same tiny test metadata source
     *  {@code MetaDataVerifyMojoTest} uses — these tests never read its content, only need
     *  {@code createLoader()} to succeed. */
    private static LoaderParam testLoader() {
        // Absolute, not "./src/test/resources" like MetaDataVerifyMojoTest — that path is
        // resolved against the MOJO's project basedir, which here is a throwaway temp dir,
        // not this module's working directory.
        String sourceDir = Path.of("src/test/resources").toAbsolutePath().toString();
        return LoaderParam.builder("verify-manifest-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir(sourceDir)
                .withSource("mojo/verify-test-metadata.json")
                .build();
    }

    private void generate(Path basedir, GeneratorParam... params) {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        gen.setLoader(new LoaderParam());
        gen.project = mavenProject(basedir);
        gen.setGenerators(List.of(params));
        List<Generator> impls = gen.buildGenerators(getClass().getClassLoader(), null);
        gen.executeGenerators(null, impls);
    }

    /** Drives {@link MetaDataVerifyMojo#compareTrees} directly — the regenerate+compare
     *  internals this test wants, without a loader or a real generator execution. */
    private List<String> compare(Path realDir, Path tempDir, Map<String, String> hashes,
                                  Path projectRoot, boolean allOverwrite, List<String> editedOrphans)
            throws Exception {
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        java.lang.reflect.Method m = MetaDataVerifyMojo.class.getDeclaredMethod(
                "compareTrees", MetaDataVerifyMojo.GenTarget.class, Map.class, Path.class, List.class);
        m.setAccessible(true);
        var targetCtor = MetaDataVerifyMojo.GenTarget.class.getDeclaredConstructor(Path.class, Path.class);
        targetCtor.setAccessible(true);
        Object target = targetCtor.newInstance(realDir, tempDir);
        java.lang.reflect.Field f = MetaDataVerifyMojo.GenTarget.class.getDeclaredField("allOverwrite");
        f.setAccessible(true);
        f.setBoolean(target, allOverwrite);
        @SuppressWarnings("unchecked")
        List<String> result = (List<String>) m.invoke(verify, target, hashes, projectRoot, editedOrphans);
        return result;
    }

    @Test
    public void pristineOrphan_reportsTheDeletesItRemedy() throws Exception {
        Path basedir = tempFolder.getRoot().toPath();
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        generate(basedir, param(outDir, "Telemetry.java", MARKER_BODY, null));

        Map<String, String> hashes = com.metaobjects.generator.util.HashManifest.load(
                basedir.resolve(".metaobjects").resolve(".gen-state"));

        Path tempDir = Files.createTempDirectory("verify-temp"); // empty: generator did not re-emit this run
        List<String> editedOrphans = new java.util.ArrayList<>();
        List<String> drift = compare(Path.of(outDir), tempDir, hashes, basedir, false, editedOrphans);

        assertTrue(drift.toString(), drift.stream().anyMatch(d -> d.contains("stale-in-repo")
                && d.contains("'mvn metaobjects:generate' deletes it")));
        assertTrue(editedOrphans.isEmpty());
    }

    @Test
    public void strangerFile_isNotDrift() throws Exception {
        Path basedir = tempFolder.getRoot().toPath();
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        generate(basedir, param(outDir, "Telemetry.java", MARKER_BODY, null));
        Files.writeString(Path.of(outDir, "Stray.java"), "// never recorded\n");

        Map<String, String> hashes = com.metaobjects.generator.util.HashManifest.load(
                basedir.resolve(".metaobjects").resolve(".gen-state"));
        Path tempDir = Files.createTempDirectory("verify-temp");
        List<String> editedOrphans = new java.util.ArrayList<>();
        List<String> drift = compare(Path.of(outDir), tempDir, hashes, basedir, false, editedOrphans);

        assertFalse(drift.toString(), drift.stream().anyMatch(d -> d.contains("Stray.java")));
    }

    @Test
    public void editedOrphan_handEditsKeep_isReportedAsNotDeletable() throws Exception {
        Path basedir = tempFolder.getRoot().toPath();
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        generate(basedir, param(outDir, "Telemetry.java", MARKER_BODY, null));
        Files.writeString(Path.of(outDir, "Telemetry.java"), MARKER_BODY + "// hand edit\n");

        Map<String, String> hashes = com.metaobjects.generator.util.HashManifest.load(
                basedir.resolve(".metaobjects").resolve(".gen-state"));
        Path tempDir = Files.createTempDirectory("verify-temp");
        List<String> editedOrphans = new java.util.ArrayList<>();
        List<String> drift = compare(Path.of(outDir), tempDir, hashes, basedir, false, editedOrphans);

        assertTrue(drift.toString(), drift.stream().anyMatch(d ->
                d.contains("edited by hand: delete it")));
        assertTrue(editedOrphans.stream().anyMatch(p -> p.contains("Telemetry.java")));
    }

    @Test
    public void editedOrphan_allOverwrite_reportsTheOverwriteRemedy_andIsNotAnEditedOrphan() throws Exception {
        Path basedir = tempFolder.getRoot().toPath();
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        generate(basedir, param(outDir, "Telemetry.java", MARKER_BODY, GeneratorParam.HAND_EDITS_OVERWRITE));
        Files.writeString(Path.of(outDir, "Telemetry.java"), MARKER_BODY + "// hand edit\n");

        Map<String, String> hashes = com.metaobjects.generator.util.HashManifest.load(
                basedir.resolve(".metaobjects").resolve(".gen-state"));
        Path tempDir = Files.createTempDirectory("verify-temp");
        List<String> editedOrphans = new java.util.ArrayList<>();
        List<String> drift = compare(Path.of(outDir), tempDir, hashes, basedir, true, editedOrphans);

        assertTrue(drift.toString(), drift.stream().anyMatch(d ->
                d.contains("will overwrite and delete it, handEdits: overwrite")));
        assertTrue("an overwrite-policy orphan is drift `generate` fixes, not a kept edited orphan",
                editedOrphans.isEmpty());
    }

    @Test
    public void noManifestAtAll_keepsTheOldBlanketWording() throws Exception {
        Path tempDirReal = tempFolder.newFolder("gen").toPath();
        Files.writeString(tempDirReal.resolve("Orphan.java"), "// not produced\n");
        Path tempDir = Files.createTempDirectory("verify-temp");

        List<String> editedOrphans = new java.util.ArrayList<>();
        List<String> drift = compare(tempDirReal, tempDir, null, tempFolder.getRoot().toPath(), false, editedOrphans);

        assertTrue(drift.toString(), drift.stream().anyMatch(d ->
                d.contains("stale-in-repo") && d.contains("(committed; generator no longer produces it)")));
        assertTrue(editedOrphans.isEmpty());
    }

    /**
     * End-to-end through {@code verify()}: when EVERY drifted file is a keep-policy edited
     * orphan, the failure message must not tell the reader to regenerate (regenerating
     * would refuse the same file again) and must append the "will NOT delete them" footer.
     */
    @Test
    public void verifyFailureMessage_allEditedOrphans_suppressesRegenerateLeadIn() throws Exception {
        Path basedir = tempFolder.getRoot().toPath();
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        // Two generators commit two files; "Extra.java" is then dropped from the verify
        // run's generator selection (simulating it no longer being produced) and hand-edited,
        // so it is the ONLY drift — "Telemetry.java" still matches exactly.
        generate(basedir,
                param(outDir, "Telemetry.java", MARKER_BODY, null),
                param(outDir, "Extra.java", MARKER_BODY, null));
        Files.writeString(Path.of(outDir, "Extra.java"), MARKER_BODY + "// hand edit\n");

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        verify.project = mavenProject(basedir);
        verify.setLoader(testLoader());
        verify.setGenerators(List.of(param(outDir, "Telemetry.java", MARKER_BODY, null)));

        try {
            verify.execute();
            fail("expected MojoFailureException");
        } catch (MojoFailureException e) {
            String msg = e.getMessage();
            assertFalse("must not send the reader in a circle with 'regenerate'",
                    msg.contains("generated code is stale"));
            assertTrue(msg.contains("will NOT delete them"));
        }
    }

    public static class DtoGenerator extends ConfigurableFileGenerator {}
    public static class RepositoryGenerator extends ConfigurableFileGenerator {}

    private GeneratorParam gen(Class<?> generator, String outDir, String filename) {
        GeneratorParam p = param(outDir, filename, MARKER_BODY, null);
        p.setClassname(generator.getName());
        return p;
    }

    /** This module with {@code metaobjects:generate} configured to run {@code generators}
     *  in one execution, as Maven's effective model presents it. */
    private MavenProject module(Path basedir, GeneratorParam... generators) {
        Xpp3Dom configuration = new Xpp3Dom("configuration");
        Xpp3Dom list = new Xpp3Dom("generators");
        for (GeneratorParam p : generators) {
            Xpp3Dom generator = new Xpp3Dom("generator");
            Xpp3Dom classname = new Xpp3Dom("classname");
            classname.setValue(p.getClassname());
            generator.addChild(classname);
            Xpp3Dom args = new Xpp3Dom("args");
            Xpp3Dom outputDir = new Xpp3Dom(GeneratorBase.ARG_OUTPUTDIR);
            outputDir.setValue(p.getArgs().get(GeneratorBase.ARG_OUTPUTDIR));
            args.addChild(outputDir);
            generator.addChild(args);
            list.addChild(generator);
        }
        configuration.addChild(list);
        Plugin plugin = new Plugin();
        plugin.setGroupId("com.metaobjects");
        plugin.setArtifactId("metaobjects-maven-plugin");
        PluginExecution execution = new PluginExecution();
        execution.setId("codegen");
        execution.addGoal("generate");
        execution.setConfiguration(configuration);
        plugin.addExecution(execution);
        Build build = new Build();
        build.addPlugin(plugin);
        MavenProject module = new MavenProject();
        module.setArtifactId("app");
        module.setFile(basedir.resolve("pom.xml").toFile());
        module.getModel().setBuild(build);
        return module;
    }

    private void generateIn(MavenProject module, GeneratorParam... params) {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        gen.setLoader(new LoaderParam());
        gen.project = module;
        gen.execution = new MojoExecution(new MojoDescriptor(), "codegen");
        gen.setGenerators(List.of(params));
        gen.executeGenerators(null, gen.buildGenerators(getClass().getClassLoader(), null));
    }

    /**
     * Two generators share one output dir; a verify that regenerates only the first must
     * not report the second's files as stale, because {@code generate} never deletes a
     * configured generator's file for another.
     */
    @Test
    public void sharedOutputDir_anotherConfiguredGeneratorsFiles_areNotDrift() throws Exception {
        Path basedir = tempFolder.getRoot().toPath();
        String shared = tempFolder.newFolder("generated-sources").getAbsolutePath();
        GeneratorParam dto = gen(DtoGenerator.class, shared, "Dto.java");
        GeneratorParam repository = gen(RepositoryGenerator.class, shared, "Repository.java");
        MavenProject module = module(basedir, dto, repository);
        generateIn(module, dto, repository);

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        verify.project = module;
        verify.setLoader(testLoader());
        verify.setGenerators(List.of(dto));

        verify.execute();
    }

    /** A generator removed from the configuration leaves files only {@code generate}
     *  deletes; verify reports them with that remedy, wherever they live. */
    @Test
    public void removedGeneratorsFiles_areDriftThatGenerateDeletes() throws Exception {
        Path basedir = tempFolder.getRoot().toPath();
        String genDir = tempFolder.newFolder("gen").getAbsolutePath();
        String webDir = tempFolder.newFolder("web").getAbsolutePath();
        GeneratorParam dto = gen(DtoGenerator.class, genDir, "Dto.java");
        GeneratorParam route = gen(RepositoryGenerator.class, webDir, "Route.java");
        generateIn(module(basedir, dto, route), dto, route);

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        verify.project = module(basedir, dto);
        verify.setLoader(testLoader());
        verify.setGenerators(List.of(dto));

        try {
            verify.execute();
            fail("expected MojoFailureException");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage(), e.getMessage().contains("Route.java")
                    && e.getMessage().contains("'mvn metaobjects:generate' deletes it"));
        }
    }
}
