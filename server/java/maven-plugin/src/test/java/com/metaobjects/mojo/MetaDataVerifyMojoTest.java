package com.metaobjects.mojo;

import com.metaobjects.generator.kotlin.KotlinEntityGenerator;
import org.apache.maven.plugin.MojoFailureException;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * Tests the {@code meta:verify} codegen-drift goal by driving the Mojo's real
 * regenerate+compare logic against a committed output tree.
 *
 * <p>Uses a real {@link KotlinEntityGenerator} as the configured generator — this
 * simultaneously proves the verify goal is generator-neutral (it knows nothing about
 * Kotlin) and that a {@code codegen-kotlin} generator runs through the shared Mojo SPI.</p>
 *
 * <p>The Mojo's {@code project}/{@code execution} fields are left null so
 * {@code createProjectClassLoader()} falls back to the test classloader (which can see the
 * Kotlin generator + metadata module) — no MavenProject scaffolding required, matching the
 * design doc's allowance to test the regenerate+compare logic directly.</p>
 */
public class MetaDataVerifyMojoTest {

    private static final String GEN_CLASS = KotlinEntityGenerator.class.getName();

    private Path committedDir;

    @Before
    public void genCommittedBaseline() throws Exception {
        committedDir = Files.createTempDirectory("verify-committed");
        // Produce the "committed" baseline once via the gen goal, using the same metadata
        // source + generator the verify run will use.
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, committedDir);
        gen.execute();

        // Sanity: the Kotlin generator emitted at least one .kt file through the gen SPI.
        assertTrue("expected the Kotlin generator to emit .kt files",
                countKtFiles(committedDir) > 0);
    }

    @Test
    public void verifyPassesWhenOutputInSync() throws Exception {
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, committedDir);
        // No drift → no exception.
        verify.execute();
    }

    @Test
    public void verifyFailsOnContentDrift() throws Exception {
        Path someKt = firstKtFile(committedDir);
        assertNotNull(someKt);
        // Mutate a committed file so its bytes differ from a fresh regen.
        Files.writeString(someKt, "// HAND-EDITED DRIFT\n", StandardCharsets.UTF_8);

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, committedDir);
        try {
            verify.execute();
            fail("expected MojoFailureException for content drift");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("generated code is stale"));
            assertTrue(e.getMessage().contains("content-differs"));
        }
    }

    @Test
    public void verifyFailsOnStaleExtraFile() throws Exception {
        // A committed file the generator does NOT produce → stale-in-repo drift.
        Path orphan = committedDir.resolve("Orphan.kt");
        Files.writeString(orphan, "// not produced by any generator\n", StandardCharsets.UTF_8);

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, committedDir);
        try {
            verify.execute();
            fail("expected MojoFailureException for stale extra file");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("stale-in-repo"));
        }
    }

    @Test
    public void verifyFailsOnMissingCommittedFile() throws Exception {
        Path someKt = firstKtFile(committedDir);
        assertNotNull(someKt);
        // Delete a committed file the generator DOES produce → missing-from-repo drift.
        Files.delete(someKt);

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, committedDir);
        try {
            verify.execute();
            fail("expected MojoFailureException for missing committed file");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("missing-from-repo"));
        }
    }

    // === helpers ============================================================

    /**
     * Wire the loader (test metadata source) + a single Kotlin generator pointed at
     * {@code outputDir}. Shared by the gen baseline and every verify variant.
     */
    private void configure(AbstractMetaDataMojo mojo, Path outputDir) {
        LoaderParam loader = LoaderParam.builder("verify-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir("./src/test/resources")
                .withSource("mojo/verify-test-metadata.json")
                .build();
        mojo.setLoader(loader);

        GeneratorParam g = GeneratorParam.builder(GEN_CLASS)
                .withArg("outputDir", outputDir.toString())
                .build();
        mojo.setGenerators(Collections.singletonList(g));
        mojo.setGlobals(Collections.emptyMap());
    }

    private long countKtFiles(Path root) throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            return s.filter(p -> p.toString().endsWith(".kt")).count();
        }
    }

    private Path firstKtFile(Path root) throws IOException {
        try (Stream<Path> s = Files.walk(root)) {
            List<Path> kt = s.filter(p -> p.toString().endsWith(".kt"))
                    .sorted()
                    .collect(Collectors.toList());
            assertFalse("expected at least one .kt file", kt.isEmpty());
            return kt.get(0);
        }
    }
}
