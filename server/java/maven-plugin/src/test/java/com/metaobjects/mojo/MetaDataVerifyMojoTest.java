package com.metaobjects.mojo;

import com.metaobjects.generator.kotlin.KotlinEntityGenerator;
import com.metaobjects.generator.kotlin.KotlinExposedTableGenerator;
import org.apache.maven.plugin.MojoFailureException;
import org.junit.Before;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
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
    /** A SECOND file-emitting generator, for the shared-outputDir cases. */
    private static final String TABLE_GEN_CLASS = KotlinExposedTableGenerator.class.getName();

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

    // === shared-outputDir (two generators, one committed tree) ===============

    /**
     * Two file-emitting generators MAY share one {@code outputDir} — nothing in the gen
     * goal forbids it, and it is idiomatic elsewhere in the ecosystem (buf, graphql-codegen,
     * and the TypeScript port's per-target codegen, whose drift check Set-dedupes outDirs).
     * verify must therefore compute drift per UNIQUE output directory over the whole
     * generator selection: minting a temp dir per GENERATOR makes each generator's compare
     * see only its own half of the tree, so the other generator's committed files read as
     * {@code [stale-in-repo]} — permanent, unfixable false drift.
     */
    @Test
    public void verifyPassesWhenTwoGeneratorsShareOneOutputDir() throws Exception {
        Path sharedDir = Files.createTempDirectory("verify-shared-outdir");
        genBaseline(sharedDir, GEN_CLASS, TABLE_GEN_CLASS);

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, sharedDir, GEN_CLASS, TABLE_GEN_CLASS);
        // Both generators' output IS committed — no drift, so no exception.
        verify.execute();
    }

    /**
     * The shared-outputDir union must not be achieved by going blind to extra files:
     * a genuinely orphaned committed file is still drift when generators share a dir.
     */
    @Test
    public void verifyStillFailsOnStaleFileWhenGeneratorsShareOneOutputDir() throws Exception {
        Path sharedDir = Files.createTempDirectory("verify-shared-outdir-stale");
        genBaseline(sharedDir, GEN_CLASS, TABLE_GEN_CLASS);
        Files.writeString(sharedDir.resolve("Orphan.kt"), "// produced by neither generator\n",
                StandardCharsets.UTF_8);

        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, sharedDir, GEN_CLASS, TABLE_GEN_CLASS);
        try {
            verify.execute();
            fail("expected MojoFailureException for a stale file in a shared outputDir");
        } catch (MojoFailureException e) {
            assertTrue(e.getMessage().contains("stale-in-repo"));
            assertTrue(e.getMessage().contains("Orphan.kt"));
        }
    }

    // === helpers ============================================================

    /** Produce the "committed" baseline in {@code outputDir} via the gen goal. */
    private void genBaseline(Path outputDir, String... generatorClasses) throws Exception {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, outputDir, generatorClasses);
        gen.execute();
        assertTrue("expected the Kotlin generators to emit .kt files",
                countKtFiles(outputDir) > 0);
    }

    /**
     * Wire the loader (test metadata source) + one or more generators, all pointed at the
     * SAME {@code outputDir}. Shared by the gen baseline and every verify variant.
     */
    private void configure(AbstractMetaDataMojo mojo, Path outputDir, String... generatorClasses) {
        LoaderParam loader = LoaderParam.builder("verify-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir("./src/test/resources")
                .withSource("mojo/verify-test-metadata.json")
                .build();
        mojo.setLoader(loader);

        List<GeneratorParam> gens = new ArrayList<>();
        for (String cls : generatorClasses) {
            gens.add(GeneratorParam.builder(cls)
                    .withArg("outputDir", outputDir.toString())
                    .build());
        }
        mojo.setGenerators(gens);
        mojo.setGlobals(Collections.emptyMap());
    }

    private void configure(AbstractMetaDataMojo mojo, Path outputDir) {
        configure(mojo, outputDir, GEN_CLASS);
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
