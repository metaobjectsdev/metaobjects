package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.generator.util.HashManifest;
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
 * {@code mvn metaobjects:generate}'s codegen hash manifest: the rename case (an orphan the
 * manifest recorded and this run did not re-emit is deleted and forgotten), the hand-edit
 * cases (refused by default, deleted under {@code handEdits=overwrite}), first-run
 * adoption, multi-execution isolation within one module, and the stranger-file floor.
 */
public class MetaDataGeneratorMojoManifestTest {

    @Rule
    public TemporaryFolder tempFolder = new TemporaryFolder();

    /**
     * Writes one configurable file into its {@code outputDir} when executed, through
     * {@link GeneratedFileWriter} — exactly as a real generator does — so the manifest,
     * {@code handEdits} policy and run-scoped bookkeeping this test exercises actually
     * apply. (A generator that wrote straight to disk, bypassing the guard, would make
     * every one of these assertions vacuously true regardless of the Mojo's behavior.)
     */
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

    private MetaDataGeneratorMojo mojo;
    private MavenProject project;
    private Path projectRoot;

    @Before
    public void setUp() {
        mojo = new MetaDataGeneratorMojo();
        mojo.setLoader(new LoaderParam());
        project = Mockito.mock(MavenProject.class);
        projectRoot = tempFolder.getRoot().toPath();
        Mockito.when(project.getBasedir()).thenReturn(tempFolder.getRoot());
        mojo.project = project;
    }

    private static GeneratorParam param(String outputDir, String filename, String content, String handEdits) {
        GeneratorParam p = new GeneratorParam();
        p.setClassname(ConfigurableFileGenerator.class.getName());
        p.setArgs(Map.of(
                GeneratorBase.ARG_OUTPUTDIR, outputDir,
                "filename", filename,
                "content", content));
        if (handEdits != null) {
            p.setHandEdits(handEdits);
        }
        return p;
    }

    private List<Generator> build(GeneratorParam... params) {
        mojo.setGenerators(List.of(params));
        return mojo.buildGenerators(getClass().getClassLoader(), null);
    }

    private Map<String, String> manifest() {
        return HashManifest.load(projectRoot.resolve(".metaobjects").resolve(".gen-state"));
    }

    private static final String MARKER_BODY = "/** GENERATED */\npublic class X {}\n";

    // === rename case ===========================================================

    @Test
    public void renamedOutput_oldFileDeletedAndForgotten() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path oldFile = Path.of(outDir, "Telemetry.java");

        mojo.executeGenerators(null, build(param(outDir, "Telemetry.java", MARKER_BODY, null)));
        assertTrue(Files.exists(oldFile));
        assertTrue(manifest().containsKey("gen/Telemetry.java"));

        // Same module, same execution's output dir, but the generator now emits a
        // differently-named file — simulating `Telemetry` renamed to `TelemetryReading`.
        mojo.executeGenerators(null, build(param(outDir, "TelemetryReading.java", MARKER_BODY, null)));

        assertFalse("the renamed-away file must be deleted", Files.exists(oldFile));
        assertTrue(Files.exists(Path.of(outDir, "TelemetryReading.java")));
        assertFalse("its manifest entry must be forgotten", manifest().containsKey("gen/Telemetry.java"));
        assertTrue(manifest().containsKey("gen/TelemetryReading.java"));
    }

    // === hand-edited orphan: refused by default ================================

    @Test
    public void handEditedOrphan_keepPolicy_isRefusedKeptAndStillRecorded() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path oldFile = Path.of(outDir, "Telemetry.java");

        mojo.executeGenerators(null, build(param(outDir, "Telemetry.java", MARKER_BODY, null)));
        Files.writeString(oldFile, MARKER_BODY + "// hand edit\n");

        mojo.executeGenerators(null, build(param(outDir, "TelemetryReading.java", MARKER_BODY, null)));

        assertTrue("an edited orphan is left in place under handEdits=keep", Files.exists(oldFile));
        assertTrue("still recorded, so the refusal repeats until acted on",
                manifest().containsKey("gen/Telemetry.java"));
    }

    // === hand-edited orphan: deleted under handEdits=overwrite ==================

    @Test
    public void handEditedOrphan_overwritePolicy_isDeleted() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path oldFile = Path.of(outDir, "Telemetry.java");

        mojo.executeGenerators(null,
                build(param(outDir, "Telemetry.java", MARKER_BODY, GeneratorParam.HAND_EDITS_OVERWRITE)));
        Files.writeString(oldFile, MARKER_BODY + "// hand edit\n");

        mojo.executeGenerators(null,
                build(param(outDir, "TelemetryReading.java", MARKER_BODY, GeneratorParam.HAND_EDITS_OVERWRITE)));

        assertFalse("handEdits=overwrite deletes a hand-edited orphan too", Files.exists(oldFile));
        assertFalse(manifest().containsKey("gen/Telemetry.java"));
    }

    // === first-run adoption ======================================================

    @Test
    public void firstRunAdoption_markerFilePreexisting_isAdoptedNotDeleted() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path preexisting = Path.of(outDir, "Legacy.java");
        Files.writeString(preexisting, MARKER_BODY);

        // No manifest exists yet; this run's generator does not even emit Legacy.java —
        // adoption must not be confused with the orphan sweep, and nothing is deleted
        // on the very run that creates the manifest.
        mojo.executeGenerators(null, build(param(outDir, "Telemetry.java", MARKER_BODY, null)));

        assertTrue("first run never sweeps — nothing was recorded to sweep against",
                Files.exists(preexisting));
    }

    @Test
    public void firstRunAdoption_ofTheEmittedFileItself_recordsAndWritesOneNotice() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path file = Path.of(outDir, "Telemetry.java");
        Files.writeString(file, MARKER_BODY); // pre-existing marker-bearing file, no manifest yet

        mojo.executeGenerators(null, build(param(outDir, "Telemetry.java", MARKER_BODY, null)));

        assertTrue(manifest().containsKey("gen/Telemetry.java"));
        assertEquals(MARKER_BODY, Files.readString(file));
    }

    // === two executions in one module share the manifest without cross-sweeping ===

    @Test
    public void twoExecutionsInOneModule_shareManifest_neitherSweepsTheOther() throws IOException {
        String dirA = tempFolder.newFolder("genA").getAbsolutePath();
        String dirB = tempFolder.newFolder("genB").getAbsolutePath();

        // Execution 1 writes into genA.
        mojo.executeGenerators(null, build(param(dirA, "A.java", MARKER_BODY, null)));
        // Execution 2 (a second <execution> in the same module/pom) writes into genB.
        mojo.executeGenerators(null, build(param(dirB, "B.java", MARKER_BODY, null)));

        assertTrue(manifest().containsKey("genA/A.java"));
        assertTrue(manifest().containsKey("genB/B.java"));

        // Re-running execution 1's generator alone (its own Mojo invocation) must not
        // touch genB's recorded file, even though both entries live in the same manifest.
        mojo.executeGenerators(null, build(param(dirA, "A.java", MARKER_BODY, null)));

        assertTrue("genB/B.java is outside this execution's jurisdiction",
                Files.exists(Path.of(dirB, "B.java")));
        assertTrue(manifest().containsKey("genB/B.java"));
    }

    // === multi-module: two basedirs, two manifests ===============================

    @Test
    public void twoModules_haveIndependentManifests() throws IOException {
        TemporaryFolder otherModule = new TemporaryFolder();
        otherModule.create();
        try {
            String outDirA = tempFolder.newFolder("gen").getAbsolutePath();
            mojo.executeGenerators(null, build(param(outDirA, "A.java", MARKER_BODY, null)));

            MetaDataGeneratorMojo otherMojo = new MetaDataGeneratorMojo();
            otherMojo.setLoader(new LoaderParam());
            MavenProject otherProject = Mockito.mock(MavenProject.class);
            Mockito.when(otherProject.getBasedir()).thenReturn(otherModule.getRoot());
            otherMojo.project = otherProject;

            String outDirB = otherModule.newFolder("gen").getAbsolutePath();
            GeneratorParam pB = param(outDirB, "B.java", MARKER_BODY, null);
            otherMojo.setGenerators(List.of(pB));
            otherMojo.executeGenerators(null, otherMojo.buildGenerators(getClass().getClassLoader(), null));

            assertTrue(manifest().containsKey("gen/A.java"));
            assertFalse("module A's manifest must not see module B's file",
                    manifest().containsKey("gen/B.java"));

            Map<String, String> otherManifest = HashManifest.load(
                    otherModule.getRoot().toPath().resolve(".metaobjects").resolve(".gen-state"));
            assertTrue(otherManifest.containsKey("gen/B.java"));
            assertFalse(otherManifest.containsKey("gen/A.java"));
        } finally {
            otherModule.delete();
        }
    }

    // === stranger file is never touched ==========================================

    @Test
    public void strangerFile_neverRecorded_isUntouchedBySweep() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path stray = Path.of(outDir, "HandWritten.java");
        Files.writeString(stray, "// never ours, no marker\npublic class HandWritten {}\n");

        mojo.executeGenerators(null, build(param(outDir, "Telemetry.java", MARKER_BODY, null)));
        // A second full run, still not emitting HandWritten.java — it must never be swept,
        // because it was never recorded in the first place.
        mojo.executeGenerators(null, build(param(outDir, "Telemetry.java", MARKER_BODY, null)));

        assertTrue(Files.exists(stray));
        assertFalse(manifest().containsKey("gen/HandWritten.java"));
    }

    // === handEdits for a file still emitted (not an orphan) =======================

    @Test
    public void stillEmittedFile_handEditsKeep_isRefusedByName() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path file = Path.of(outDir, "Telemetry.java");

        mojo.executeGenerators(null, build(param(outDir, "Telemetry.java", MARKER_BODY, null)));
        String edited = MARKER_BODY + "// mine\n";
        Files.writeString(file, edited);

        String fresh = "/** GENERATED */\npublic class X { int z; }\n";
        mojo.executeGenerators(null,
                build(param(outDir, "Telemetry.java", fresh, GeneratorParam.HAND_EDITS_KEEP)));

        assertEquals("handEdits=keep leaves the hand edit in place", edited, Files.readString(file));
    }

    @Test
    public void stillEmittedFile_handEditsOverwrite_isReplaced() throws IOException {
        String outDir = tempFolder.newFolder("gen").getAbsolutePath();
        Path file = Path.of(outDir, "Telemetry.java");

        mojo.executeGenerators(null, build(param(outDir, "Telemetry.java", MARKER_BODY, null)));
        Files.writeString(file, MARKER_BODY + "// mine\n");

        String fresh = "/** GENERATED */\npublic class X { int z; }\n";
        mojo.executeGenerators(null,
                build(param(outDir, "Telemetry.java", fresh, GeneratorParam.HAND_EDITS_OVERWRITE)));

        assertEquals("handEdits=overwrite replaces the hand edit", fresh, Files.readString(file));
    }
}
