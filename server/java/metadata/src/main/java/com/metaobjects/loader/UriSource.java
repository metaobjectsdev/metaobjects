package com.metaobjects.loader;

import com.metaobjects.loader.uri.URIHelper;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;

/**
 * A URI-backed metadata source. Supports {@code file://}, {@code http://},
 * {@code https://}, and the project's {@code model:} URI schemes (resolved via
 * {@link URIHelper}). Format is inferred from the URI path's extension
 * ({@code .yaml}/{@code .yml} → YAML, else JSON) unless overridden via constructor.
 *
 * <p>Example usage:</p>
 * <pre>{@code
 * URI uri = URIHelper.toURI("model:file:/opt/app/meta.json");
 * MetaDataSource source = new UriSource(uri);
 * String content = source.read();
 * }</pre>
 */
public class UriSource implements MetaDataSource {

    private final URI uri;
    private final String id;
    private final MetaDataFormat format;

    /**
     * Constructs a URI-backed source.
     *
     * @param uri the model URI to read from; must not be {@code null} and must
     *            be parseable by {@link URIHelper}
     */
    public UriSource(URI uri) {
        if (uri == null) throw new IllegalArgumentException("uri must not be null");
        this.uri = uri;
        this.id = uri.toString();
        this.format = inferFormat(id);
    }

    /**
     * Infers the document format from the URI string by extension:
     * {@code .yaml} / {@code .yml} → {@link MetaDataFormat#YAML} (sigil-free authoring
     * front-end, ADR-0006); everything else falls back to {@link MetaDataFormat#JSON}
     * (the canonical interchange format).
     */
    private static MetaDataFormat inferFormat(String uriString) {
        if (uriString != null) {
            String lower = uriString.toLowerCase();
            if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
                return MetaDataFormat.YAML;
            }
        }
        return MetaDataFormat.JSON;
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
        // TODO(OSGi): UriSource currently consults only URIHelper's default + system CL.
        // The pre-unification FileMetaDataSources chained source-class CL → loader CL → system CL.
        // If/when OSGi adopters need that chain back, add a UriSource constructor variant
        // that accepts a List<ClassLoader> and threads it into URIHelper.getInputStream.
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
        return "UriSource{uri='" + id + "', format=" + format + "}";
    }
}
