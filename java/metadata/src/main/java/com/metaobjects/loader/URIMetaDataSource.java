package com.metaobjects.loader;

import com.metaobjects.loader.uri.URIHelper;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;

/**
 * A {@link MetaDataSource} that reads content via
 * {@link com.metaobjects.loader.uri.URIHelper}.
 *
 * <p>The URI must follow the {@code model:<sourceType>:<source>} scheme
 * understood by {@link URIHelper} (e.g. {@code model:file:/path/to/meta.json},
 * {@code model:resource:com/example/meta.xml}).  The {@link MetaDataFormat}
 * is inferred from the URI string: if it ends with {@code .xml} (case-insensitive)
 * the format is {@link MetaDataFormat#XML}; everything else defaults to
 * {@link MetaDataFormat#JSON}.</p>
 *
 * <p>Mirrors the TypeScript {@code FileSource} class introduced in H3a,
 * adapted to Java's URI-based addressing scheme already used by
 * {@link com.metaobjects.loader.simple.SimpleLoader}.</p>
 *
 * <p>Example usage:</p>
 * <pre>{@code
 * URI uri = URIHelper.toURI("model:file:/opt/app/meta.json");
 * MetaDataSource source = new URIMetaDataSource(uri);
 * String content = source.read();
 * }</pre>
 */
public class URIMetaDataSource implements MetaDataSource {

    private final URI uri;
    private final String id;
    private final MetaDataFormat format;

    /**
     * Constructs a URI-backed source.
     *
     * @param uri the model URI to read from; must not be {@code null} and must
     *            be parseable by {@link URIHelper}
     */
    public URIMetaDataSource(URI uri) {
        if (uri == null) throw new IllegalArgumentException("uri must not be null");
        this.uri = uri;
        this.id = uri.toString();
        this.format = inferFormat(id);
    }

    /**
     * Infers the document format from the URI string.
     * A URI ending in {@code .xml} (case-insensitive) is treated as
     * {@link MetaDataFormat#XML}; everything else is {@link MetaDataFormat#JSON}.
     */
    private static MetaDataFormat inferFormat(String uriString) {
        String lower = uriString.toLowerCase();
        // Strip any query args after ';' before checking extension
        int semi = lower.indexOf(';');
        if (semi > 0) lower = lower.substring(0, semi);
        return lower.endsWith(".xml") ? MetaDataFormat.XML : MetaDataFormat.JSON;
    }

    @Override
    public String getId() {
        return id;
    }

    @Override
    public MetaDataFormat getFormat() {
        return format;
    }

    /**
     * Opens an {@link InputStream} via {@link URIHelper#getInputStream(URI)}
     * and reads the full content into a {@code String} using UTF-8 encoding.
     *
     * @return the document content
     * @throws IOException if the URI cannot be opened or read
     */
    @Override
    public String read() throws IOException {
        try (InputStream is = URIHelper.getInputStream(uri);
             Scanner scanner = new Scanner(is, StandardCharsets.UTF_8)) {
            scanner.useDelimiter("\\Z");
            if (!scanner.hasNext()) {
                throw new IOException("No content at URI: " + id);
            }
            return scanner.next();
        }
    }

    /**
     * Returns the underlying URI.
     *
     * @return the URI supplied at construction time
     */
    public URI getUri() {
        return uri;
    }

    @Override
    public String toString() {
        return "URIMetaDataSource{uri='" + id + "', format=" + format + "}";
    }
}
