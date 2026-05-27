package com.metaobjects.generator.spring;

import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * Test-only helper: write a literal JSON fixture string to a temp file and
 * spin up a {@link MetaDataLoader} pointed at it. Mirrors the
 * {@code loadString} helper in {@code metadata-ktx} (Kotlin), reimplemented
 * inline here because the Spring module is a plain Java module and pulling
 * {@code metadata-ktx} into its test scope would force Kotlin into the
 * test classpath for no other reason.
 *
 * <p>Each call creates a fresh, isolated loader so tests don't bleed state.
 * The shared registry (via {@code SharedRegistryTestBase}) is still picked
 * up because {@code MetaDataLoader} delegates to the same singleton
 * {@code MetaDataRegistry}.</p>
 */
final class SpringTestFixtures {

    private SpringTestFixtures() { /* no instances */ }

    /**
     * Write {@code fixtureJson} to a temp file under {@code parent} and return
     * a fresh {@link MetaDataLoader} initialised against it.
     *
     * @param parent     test-local temp directory the fixture file is written under
     * @param baseName   filename stem (will be suffixed with {@code .json})
     * @param fixtureJson literal canonical-JSON fixture text
     */
    static MetaDataLoader loadFixture(Path parent, String baseName, String fixtureJson) throws IOException {
        Path fixture = parent.resolve(baseName + ".json");
        Files.writeString(fixture, fixtureJson);
        URI uri = URIHelper.toURI("model:file:" + fixture.toAbsolutePath().toString().replace('\\', '/'));
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true),
            MetaDataLoader.SUBTYPE_MANUAL,
            "spring-test-" + baseName);
        loader.setSourceURIs(List.of(uri));
        loader.init();
        return loader;
    }
}
