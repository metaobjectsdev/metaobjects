package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugin.MojoFailureException;
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
}
