package com.metaobjects.generator;

import com.metaobjects.config.SharedModel;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.RegistryManifest;
import org.junit.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * FR-023 publish: the {@code shared-model} generator writes the two files the shared corpus
 * ({@code fixtures/shared-model-conformance/}) pins, byte for byte, through the same path the Maven
 * goal takes (args in, files out, version from the project). The artifact's bytes themselves are
 * gated by {@code SharedModelConformanceTest} in the metadata module.
 */
public class SharedModelGeneratorTest {

    private static Path corpus() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        assertNotNull("could not locate the repository fixtures/ directory", dir);
        return dir.resolve("fixtures/shared-model-conformance");
    }

    private static MetaDataLoader loader() {
        MetaDataLoader l = new MetaDataLoader(LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "publisher");
        l.init();
        return l;
    }

    /** {@code base} plus one override, as a fresh mutable copy so the shared {@link #args} map stays untouched. */
    private static Map<String, String> with(Map<String, String> base, String key, String value) {
        Map<String, String> copy = new java.util.HashMap<>(base);
        copy.put(key, value);
        return copy;
    }

    private static Map<String, String> args(Path out) {
        return Map.of(
            "outputDir", out.toString(),
            "name", "acme-common",
            "include", "acme::common::**",
            "exclude", "acme::common::Secret",
            "files", corpus().resolve("source/meta.base.json") + "," + corpus().resolve("source/meta.customer.json"));
    }

    @Test public void writesTheArtifactAndManifestTheCorpusPins() throws Exception {
        Path out = Files.createTempDirectory("shared-model-gen-");
        SharedModelGenerator g = new SharedModelGenerator();
        g.setArgs(with(args(out), "version", "1.0.0")); // what the Maven plugin supplies from ${project.version}
        g.execute(loader());

        String artifact = Files.readString(out.resolve("acme-common.metaobjects.json"), StandardCharsets.UTF_8);
        String manifest = Files.readString(out.resolve("metaobjects.pkg.json"), StandardCharsets.UTF_8);
        assertEquals(Files.readString(corpus().resolve("../dependency-conformance/artifacts/acme-common-v1.json").normalize(), StandardCharsets.UTF_8), artifact);
        assertEquals(Files.readString(corpus().resolve("expected/acme-common-v1/metaobjects.pkg.json"), StandardCharsets.UTF_8)
            .replace("@@METAMODEL_VERSION@@", RegistryManifest.METAMODEL_VERSION), manifest);
    }

    @Test public void theRequirementsArgPublishesTheLedgerTheCorpusPins() throws Exception {
        Path out = Files.createTempDirectory("shared-model-gen-");
        SharedModelGenerator g = new SharedModelGenerator();
        Map<String, String> a = with(with(with(args(out), "version", "1.1.0"), "requirements", "true"),
            "exclude", "acme::common::KeepSecretsSafe,acme::common::Secret");
        g.setArgs(with(a, "files", a.get("files") + "," + corpus().resolve("source/meta.ledger.json")));
        g.execute(loader());

        assertEquals(Files.readString(corpus().resolve("../dependency-conformance/artifacts/acme-common-v1-requirements.json").normalize(), StandardCharsets.UTF_8),
            Files.readString(out.resolve("acme-common.metaobjects.json"), StandardCharsets.UTF_8));
        assertEquals(Files.readString(corpus().resolve("expected/with-requirements/metaobjects.pkg.json"), StandardCharsets.UTF_8)
            .replace("@@METAMODEL_VERSION@@", RegistryManifest.METAMODEL_VERSION),
            Files.readString(out.resolve("metaobjects.pkg.json"), StandardCharsets.UTF_8));
    }

    @Test public void aBlankVersionArgIsRefused() throws Exception {
        Path out = Files.createTempDirectory("shared-model-gen-");
        SharedModelGenerator g = new SharedModelGenerator();
        g.setArgs(with(args(out), "version", " "));
        GeneratorException e = assertThrows(GeneratorException.class, () -> g.execute(loader()));
        assertTrue(e.getMessage(), e.getMessage().contains("no version available"));
        assertFalse(Files.exists(out.resolve("metaobjects.pkg.json")));
    }

    @Test public void noVersionAnywhereIsRefusedAfterTheSelectionPasses() throws Exception {
        Path out = Files.createTempDirectory("shared-model-gen-");
        SharedModelGenerator g = new SharedModelGenerator();
        g.setArgs(args(out));
        GeneratorException e = assertThrows(GeneratorException.class, () -> g.execute(loader()));
        assertTrue(e.getMessage(), e.getMessage().contains("no version available"));
        assertFalse(Files.exists(out.resolve("metaobjects.pkg.json")));
    }

    @Test public void aRefusedSelectionWritesNothing() throws Exception {
        Path out = Files.createTempDirectory("shared-model-gen-");
        SharedModelGenerator g = new SharedModelGenerator();
        g.setArgs(with(with(args(out), "include", "nothing::**"), "exclude", ""));
        SharedModel.Refusal r = assertThrows(SharedModel.Refusal.class, () -> g.execute(loader()));
        assertEquals(SharedModel.Reason.EMPTY_SELECTION, r.reason());
        assertFalse(Files.exists(out.resolve("acme-common.metaobjects.json")));
    }

    @Test public void aMissingArgNamesTheArg() throws Exception {
        SharedModelGenerator g = new SharedModelGenerator();
        g.setArgs(Map.of("outputDir", Files.createTempDirectory("shared-model-gen-").toString()));
        GeneratorException e = assertThrows(GeneratorException.class, () -> g.execute(loader()));
        assertTrue(e.getMessage(), e.getMessage().contains("'name'"));
    }
}
