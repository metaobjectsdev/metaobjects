package com.metaobjects.loader;

import org.junit.Test;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.*;

/**
 * Focused tests for {@link UriSource} — covers the file:// scheme + extension-based
 * format inference. The {@code model:} URI schemes are exercised indirectly via
 * {@link MetaDataLoaderUriTest} and the broader URI helper tests.
 */
public class UriSourceTest {

    @Test public void readsFileScheme() throws IOException {
        Path p = Files.createTempFile("us-", ".json");
        Files.writeString(p, "{\"metadata.root\":{}}");
        try {
            UriSource src = new UriSource(p.toUri());
            assertEquals(MetaDataSource.MetaDataFormat.JSON, src.getFormat());
            assertEquals("{\"metadata.root\":{}}", src.read());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test public void inferFormatFromYamlExtension() throws IOException {
        Path p = Files.createTempFile("us-", ".yaml");
        try {
            UriSource src = new UriSource(p.toUri());
            assertEquals(MetaDataSource.MetaDataFormat.YAML, src.getFormat());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test public void inferFormatFromYmlExtension() throws IOException {
        Path p = Files.createTempFile("us-", ".yml");
        try {
            UriSource src = new UriSource(p.toUri());
            assertEquals(MetaDataSource.MetaDataFormat.YAML, src.getFormat());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test public void readsViaModelFileUri() throws Exception {
        // model:file:<path> URIs route through URIHelper — verify the content
        // resolution path used by fromUris() / fromResources() works end-to-end.
        Path p = Files.createTempFile("us-mf-", ".json");
        Files.writeString(p, "{\"metadata.root\":{}}");
        try {
            URI uri = URI.create("model:file:" + p.toString());
            UriSource src = new UriSource(uri);
            assertNotNull(src.read());
            assertEquals("{\"metadata.root\":{}}", src.read());
        } finally {
            Files.deleteIfExists(p);
        }
    }

    @Test(expected = IllegalArgumentException.class)
    public void nullUriRejected() {
        new UriSource(null);
    }
}
