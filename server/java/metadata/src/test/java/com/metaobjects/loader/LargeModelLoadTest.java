package com.metaobjects.loader;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import com.metaobjects.object.MetaObject;
import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.lang.management.ThreadMXBean;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.AfterClass;
import org.junit.BeforeClass;
import org.junit.Test;

/**
 * A large model must load, and load in time that scales with its size.
 *
 * <p>The model is the canonical persistence-conformance model copied {@value #COPIES} times,
 * each copy in its own package, so every top-level object appears {@value #COPIES} times and
 * every reference still resolves inside its copy (the canonical model names no other package).
 * That is roughly 1,200 top-level objects, the scale at which the loader used to hit its
 * initialization timeout.</p>
 *
 * <p>The budget is on the loading thread's CPU time, not wall-clock, so a machine busy with
 * other work does not fail it: the load runs on the calling thread (no sources are queued for
 * {@code init()}). It is deliberately loose: the linear loader needs a few seconds of CPU here,
 * and the quadratic one it guards against needed over 30. Override it with
 * {@code -Dmetaobjects.test.largeModelBudgetMs=...} when profiling.</p>
 */
public class LargeModelLoadTest {

    static final int COPIES = 20;
    private static final long BUDGET_MS = Long.getLong("metaobjects.test.largeModelBudgetMs", 15_000L);

    private static Path modelDir;
    private static int objectsPerCopy;

    private static Path canonicalModel() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null) {
            Path candidate = dir.resolve("fixtures/persistence-conformance/canonical/meta.fitness.json");
            if (Files.isRegularFile(candidate)) return candidate;
            dir = dir.getParent();
        }
        throw new AssertionError("fixtures/persistence-conformance/canonical/meta.fitness.json not found");
    }

    @BeforeClass
    public static void writeModel() throws IOException {
        String canonical = Files.readString(canonicalModel(), StandardCharsets.UTF_8);
        String packageDecl = "\"package\": \"fitness\"";
        assertTrue("canonical model declares package fitness", canonical.contains(packageDecl));
        modelDir = Files.createTempDirectory("mo-large-model");
        for (int i = 0; i < COPIES; i++) {
            Files.writeString(modelDir.resolve("meta.fitness" + i + ".json"),
                    canonical.replace(packageDecl, "\"package\": \"fitness" + i + "\""),
                    StandardCharsets.UTF_8);
        }
        MetaDataLoader one = MetaDataLoader.fromUris("large-model-baseline",
                List.of(canonicalModel().toUri()));
        objectsPerCopy = one.getRoot().getChildren(MetaObject.class, false).size();
    }

    @AfterClass
    public static void deleteModel() throws IOException {
        if (modelDir == null) return;
        try (var files = Files.list(modelDir)) {
            for (Path p : (Iterable<Path>) files::iterator) Files.deleteIfExists(p);
        }
        Files.deleteIfExists(modelDir);
    }

    @Test
    public void loadsALargeModelWithinBudget() throws IOException {
        List<URI> uris = modelUris();
        ThreadMXBean threads = ManagementFactory.getThreadMXBean();
        long cpuStart = threads.getCurrentThreadCpuTime();
        long start = System.nanoTime();
        MetaDataLoader loader = MetaDataLoader.fromUris("large-model", uris);
        long wallMs = (System.nanoTime() - start) / 1_000_000;
        long cpuMs = (threads.getCurrentThreadCpuTime() - cpuStart) / 1_000_000;

        assertTrue("no load errors: " + loader.getErrors(), loader.getErrors().isEmpty());
        assertEquals(objectsPerCopy * COPIES, loader.getRoot().getChildren(MetaObject.class, false).size());
        String report = objectsPerCopy * COPIES + " objects loaded in " + cpuMs + " ms CPU (" + wallMs + " ms wall)";
        System.out.println("[LargeModelLoadTest] " + report);
        assertTrue(report + "; budget " + BUDGET_MS + " ms CPU", cpuMs <= BUDGET_MS);
    }

    private List<URI> modelUris() throws IOException {
        List<URI> uris = new ArrayList<>();
        try (var files = Files.list(modelDir)) {
            files.sorted().forEach(p -> uris.add(p.toUri()));
        }
        return uris;
    }

    @Test
    public void theInitTimeoutDefaultsToThirtySeconds() {
        assertEquals(30_000L, new LoaderOptions().getInitTimeoutMs());
        assertEquals(LoaderOptions.DEFAULT_INIT_TIMEOUT_MS, new LoaderOptions().getInitTimeoutMs());
    }

    @Test
    public void theInitTimeoutRejectsANonPositiveValue() {
        assertThrows(IllegalArgumentException.class, () -> new LoaderOptions().setInitTimeoutMs(0));
        assertThrows(IllegalArgumentException.class, () -> new LoaderOptions().setInitTimeoutMs(-5));
    }

    @Test
    public void theLoaderArgumentSetsTheInitTimeout() {
        MetaDataLoader loader = MetaDataLoader.createManual(false, "timeout-arg");
        loader.processArguments(Map.of(LoaderConfigurationConstants.ARG_INIT_TIMEOUT_MS, " 90000 "));
        assertEquals(90_000L, loader.getLoaderOptions().getInitTimeoutMs());
        assertThrows(IllegalArgumentException.class, () ->
            loader.processArguments(Map.of(LoaderConfigurationConstants.ARG_INIT_TIMEOUT_MS, "soon")));
    }

    /** A load that outlasts the setting fails, and the failure names how to raise it. */
    @Test
    public void aLoadOutlastingTheTimeoutNamesTheSetting() throws IOException {
        MetaDataLoader loader = MetaDataLoader.createManual(false, "timeout-short");
        loader.getLoaderOptions().setInitTimeoutMs(1);
        loader.setSourceURIs(modelUris());
        MetaDataLoadingException e = assertThrows(MetaDataLoadingException.class, loader::init);
        assertTrue(e.getMessage(), e.getMessage().contains(LoaderConfigurationConstants.ARG_INIT_TIMEOUT_MS));
        assertTrue(e.getMessage(), e.getMessage().contains(LoaderOptions.INIT_TIMEOUT_PROPERTY));
    }
}
