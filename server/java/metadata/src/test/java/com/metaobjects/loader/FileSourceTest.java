package com.metaobjects.loader;

import org.junit.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import static org.junit.Assert.*;

/**
 * Tests for {@link FileSource} — single-file MetaDataSource impl.
 */
public class FileSourceTest {

    @Test public void readsJsonFileWithInferredFormat() throws IOException {
        Path p = Files.createTempFile("fs-", ".json");
        Files.writeString(p, "{\"metadata.root\":{}}");
        try {
            FileSource src = new FileSource(p);
            assertEquals(MetaDataSource.MetaDataFormat.JSON, src.getFormat());
            assertEquals(p.getFileName().toString(), src.getId());
            assertEquals("{\"metadata.root\":{}}", src.read());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test public void inferFormatFromYamlExtension() throws IOException {
        Path p = Files.createTempFile("fs-", ".yaml");
        try {
            FileSource src = new FileSource(p);
            assertEquals(MetaDataSource.MetaDataFormat.YAML, src.getFormat());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test public void inferFormatFromYmlExtension() throws IOException {
        Path p = Files.createTempFile("fs-", ".yml");
        try {
            FileSource src = new FileSource(p);
            assertEquals(MetaDataSource.MetaDataFormat.YAML, src.getFormat());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test public void explicitFormatOverridesInference() throws IOException {
        Path p = Files.createTempFile("fs-", ".txt");
        try {
            FileSource src = new FileSource(p, MetaDataSource.MetaDataFormat.YAML);
            assertEquals(MetaDataSource.MetaDataFormat.YAML, src.getFormat());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test(expected = NullPointerException.class)
    public void rejectsNullPath() {
        new FileSource(null);
    }
}
