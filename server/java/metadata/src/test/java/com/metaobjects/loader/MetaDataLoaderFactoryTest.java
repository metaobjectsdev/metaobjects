package com.metaobjects.loader;

import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.Assert.*;

/**
 * Tests for the unified static factories on {@link MetaDataLoader}:
 * {@link MetaDataLoader#fromDirectory(String, Path)},
 * {@link MetaDataLoader#fromUris(String, java.util.List)},
 * {@link MetaDataLoader#fromString(String, String, MetaDataSource.MetaDataFormat)}.
 *
 * <p>These factories match the cross-language convention — every port
 * (TS/Java/C#/Python) exposes the same shape.</p>
 */
public class MetaDataLoaderFactoryTest extends SharedRegistryTestBase {

    @Test public void fromDirectoryLoadsCanonicalJson() throws IOException {
        Path dir = Files.createTempDirectory("mdl-");
        Path file = dir.resolve("meta.tiny.json");
        Files.writeString(file, "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}");
        try {
            MetaDataLoader loader = MetaDataLoader.fromDirectory("factoryTestDir", dir);
            assertNotNull(loader.getRoot());
        } finally {
            Files.deleteIfExists(file);
            Files.deleteIfExists(dir);
        }
    }

    @Test public void fromStringLoadsInlineJson() {
        MetaDataLoader loader = MetaDataLoader.fromString(
            "factoryTestString",
            "{\"metadata.root\":{\"package\":\"x\",\"children\":[]}}",
            MetaDataSource.MetaDataFormat.JSON);
        assertNotNull(loader.getRoot());
    }

    @Test(expected = MetaDataLoadingException.class)
    public void fromDirectoryThrowsOnMissingDirectory() {
        MetaDataLoader.fromDirectory(
            "missing",
            Path.of("/nonexistent/path/that/should/not/exist"));
    }
}
