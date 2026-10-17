package com.metaobjects.generator.util;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** The orphan sweep: classify, delete, refuse, forget — against a real manifest and tree. */
public class OrphanSweepTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Rule
    public TemporaryFolder elsewhere = new TemporaryFolder();

    private Path projectRoot;
    private Path genStateDir;
    private Path outDir;

    private void setUpProject() throws Exception {
        projectRoot = tmp.getRoot().toPath();
        genStateDir = projectRoot.resolve(".metaobjects/.gen-state");
        outDir = projectRoot.resolve("gen");
        Files.createDirectories(outDir);
    }

    // === classify ============================================================

    @Test
    public void classifyStrangerWhenNotRecorded() throws Exception {
        setUpProject();
        Path file = outDir.resolve("Stray.java");
        Files.writeString(file, "// not ours\n");

        assertEquals(OrphanSweep.Verdict.STRANGER,
            OrphanSweep.classify(Collections.emptyMap(), projectRoot, file));
    }

    @Test
    public void classifyPristineWhenContentMatchesRecordedHash() throws Exception {
        setUpProject();
        Path file = outDir.resolve("Telemetry.java");
        String content = "/** GENERATED */\npublic class Telemetry {}\n";
        Files.writeString(file, content);
        HashManifest.record(genStateDir, "gen/Telemetry.java", content);

        assertEquals(OrphanSweep.Verdict.PRISTINE,
            OrphanSweep.classify(HashManifest.load(genStateDir), projectRoot, file));
    }

    @Test
    public void classifyEditedWhenContentDiffersFromRecordedHash() throws Exception {
        setUpProject();
        Path file = outDir.resolve("Telemetry.java");
        HashManifest.record(genStateDir, "gen/Telemetry.java", "/** GENERATED */\npublic class Telemetry {}\n");
        Files.writeString(file, "/** GENERATED */\npublic class Telemetry { int extra; }\n");

        assertEquals(OrphanSweep.Verdict.EDITED,
            OrphanSweep.classify(HashManifest.load(genStateDir), projectRoot, file));
    }

    @Test
    public void keyForIsNullOutsideProjectRoot() throws Exception {
        setUpProject();
        Path outside = elsewhere.getRoot().toPath().resolve("X.java");
        assertEquals(null, OrphanSweep.keyFor(projectRoot, outside));
    }

    // === sweep: the rename case — pristine orphan deleted + forgotten =========

    @Test
    public void renameCase_pristineOrphanIsDeletedAndForgotten() throws Exception {
        setUpProject();
        String oldContent = "/** GENERATED */\npublic class Telemetry {}\n";
        Path oldFile = outDir.resolve("Telemetry.java");
        Files.writeString(oldFile, oldContent);
        HashManifest.record(genStateDir, "gen/Telemetry.java", oldContent);

        Path newFile = outDir.resolve("TelemetryReading.java");
        Files.writeString(newFile, "/** GENERATED */\npublic class TelemetryReading {}\n");
        Set<Path> emitted = new LinkedHashSet<>(Set.of(newFile.toAbsolutePath().normalize()));

        OrphanSweep.Entry entry = new OrphanSweep.Entry(outDir, "gen/", false);
        OrphanSweep.Result result = OrphanSweep.sweep(genStateDir, projectRoot, List.of(entry), emitted);

        assertFalse("old file should be deleted", Files.exists(oldFile));
        assertTrue(result.removed.contains("gen/Telemetry.java"));
        assertTrue(result.refused.isEmpty());
        assertTrue(result.overwrittenDeleted.isEmpty());
        assertFalse(HashManifest.load(genStateDir).containsKey("gen/Telemetry.java"));
    }

    // === sweep: hand-edited orphan is refused, stays recorded =================

    @Test
    public void handEditedOrphan_isRefused_keptAndStillRecorded() throws Exception {
        setUpProject();
        Path oldFile = outDir.resolve("Telemetry.java");
        Files.writeString(oldFile, "/** GENERATED */\npublic class Telemetry {}\n");
        HashManifest.record(genStateDir, "gen/Telemetry.java", "/** GENERATED */\npublic class Telemetry {}\n");
        // Hand-edit after generation.
        Files.writeString(oldFile, "/** GENERATED */\npublic class Telemetry { /* mine */ }\n");

        OrphanSweep.Entry entry = new OrphanSweep.Entry(outDir, "gen/", false);
        OrphanSweep.Result result = OrphanSweep.sweep(genStateDir, projectRoot, List.of(entry), Set.of());

        assertTrue("edited orphan must be left in place", Files.exists(oldFile));
        assertTrue(result.refused.contains("gen/Telemetry.java"));
        assertTrue(result.removed.isEmpty());
        assertTrue(result.overwrittenDeleted.isEmpty());
        assertTrue("still recorded so the refusal repeats until acted on",
            HashManifest.load(genStateDir).containsKey("gen/Telemetry.java"));
    }

    @Test
    public void handEditedOrphan_underAllowOverwrite_isDeleted() throws Exception {
        setUpProject();
        Path oldFile = outDir.resolve("Telemetry.java");
        Files.writeString(oldFile, "/** GENERATED */\npublic class Telemetry {}\n");
        HashManifest.record(genStateDir, "gen/Telemetry.java", "/** GENERATED */\npublic class Telemetry {}\n");
        Files.writeString(oldFile, "/** GENERATED */\npublic class Telemetry { /* mine */ }\n");

        OrphanSweep.Entry entry = new OrphanSweep.Entry(outDir, "gen/", true);
        OrphanSweep.Result result = OrphanSweep.sweep(genStateDir, projectRoot, List.of(entry), Set.of());

        assertFalse("overwrite policy deletes a hand-edited orphan", Files.exists(oldFile));
        assertTrue(result.overwrittenDeleted.contains("gen/Telemetry.java"));
        assertTrue(result.refused.isEmpty());
        assertFalse(HashManifest.load(genStateDir).containsKey("gen/Telemetry.java"));
    }

    // === sweep: stranger file is never touched =================================

    @Test
    public void strangerFile_isNeverTouched() throws Exception {
        setUpProject();
        Path stray = outDir.resolve("HandWritten.java");
        Files.writeString(stray, "// never generated, never recorded\n");
        // Manifest exists (so sweep actually runs) but has nothing for this file.
        HashManifest.record(genStateDir, "gen/Other.java", "x");

        OrphanSweep.Entry entry = new OrphanSweep.Entry(outDir, "gen/", false);
        OrphanSweep.Result result = OrphanSweep.sweep(genStateDir, projectRoot, List.of(entry), Set.of());

        assertTrue(Files.exists(stray));
        assertFalse(result.removed.contains("gen/HandWritten.java"));
        assertFalse(result.refused.contains("gen/HandWritten.java"));
    }

    @Test
    public void noManifestAtAll_sweepIsANoOp() throws Exception {
        setUpProject();
        Path stray = outDir.resolve("Whatever.java");
        Files.writeString(stray, "whatever\n");

        OrphanSweep.Entry entry = new OrphanSweep.Entry(outDir, "gen/", false);
        OrphanSweep.Result result = OrphanSweep.sweep(genStateDir, projectRoot, List.of(entry), Set.of());

        assertTrue(result.removed.isEmpty());
        assertTrue(result.refused.isEmpty());
        assertTrue(result.overwrittenDeleted.isEmpty());
        assertTrue(Files.exists(stray));
    }

    // === sweep: a recorded path whose file is already gone is forgotten ========

    @Test
    public void alreadyGoneRecordedFile_isForgotten() throws Exception {
        setUpProject();
        HashManifest.record(genStateDir, "gen/Deleted.java", "irrelevant");

        OrphanSweep.Entry entry = new OrphanSweep.Entry(outDir, "gen/", false);
        OrphanSweep.Result result = OrphanSweep.sweep(genStateDir, projectRoot, List.of(entry), Set.of());

        assertFalse(HashManifest.load(genStateDir).containsKey("gen/Deleted.java"));
    }

    // === sweep: two directories (two executions sharing one manifest) =========

    @Test
    public void twoDirectories_neitherSweepsTheOthersFiles() throws Exception {
        setUpProject();
        Path dirA = projectRoot.resolve("genA");
        Path dirB = projectRoot.resolve("genB");
        Files.createDirectories(dirA);
        Files.createDirectories(dirB);

        Path fileA = dirA.resolve("A.java");
        Path fileB = dirB.resolve("B.java");
        Files.writeString(fileA, "a");
        Files.writeString(fileB, "b");
        HashManifest.record(genStateDir, "genA/A.java", "a");
        HashManifest.record(genStateDir, "genB/B.java", "b");

        // Only dirA's execution runs this sweep (dirB's execution's generators did not run
        // this time), and dirA emitted nothing — A.java is now an orphan of dirA only.
        OrphanSweep.Entry entryA = new OrphanSweep.Entry(dirA, "genA/", false);
        OrphanSweep.Result result = OrphanSweep.sweep(genStateDir, projectRoot, List.of(entryA), Set.of());

        assertFalse("A.java is dirA's orphan", Files.exists(fileA));
        assertTrue("B.java is untouched — outside dirA's jurisdiction", Files.exists(fileB));
        assertTrue(HashManifest.load(genStateDir).containsKey("genB/B.java"));
    }

    // === messages ===============================================================

    @Test
    public void refusedMessageNamesEveryPathAndTheOwner() {
        String msg = OrphanSweep.refusedMessage(List.of("gen/A.java", "gen/B.java"), "mvn metaobjects:generate");
        assertTrue(msg.contains("mvn metaobjects:generate"));
        assertTrue(msg.contains("gen/A.java"));
        assertTrue(msg.contains("gen/B.java"));
        assertTrue(msg.contains("NOT deleted"));
    }

    @Test
    public void overwrittenOrphanMessageNamesThePathAndPolicy() {
        String msg = OrphanSweep.overwrittenOrphanMessage("gen/Telemetry.java");
        assertTrue(msg.contains("gen/Telemetry.java"));
        assertTrue(msg.contains("handEdits: overwrite"));
    }
}
