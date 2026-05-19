package com.metaobjects.loader;

import java.io.IOException;

/**
 * One unit of raw metadata input consumed by the loader pipeline.
 *
 * <p>A source encapsulates a single document (file, classpath resource, or
 * in-memory string) together with the format hint that selects the parser.
 * Mirrors the TypeScript {@code MetaDataSource} interface introduced in H3a.</p>
 *
 * <p>Concrete implementations:
 * <ul>
 *   <li>{@link InMemoryMetaDataSource} — a pre-loaded string (useful in tests)</li>
 *   <li>{@link URIMetaDataSource} — reads via {@link com.metaobjects.loader.uri.URIHelper}</li>
 * </ul>
 * </p>
 *
 * @see InMemoryMetaDataSource
 * @see URIMetaDataSource
 */
public interface MetaDataSource {

    /**
     * The raw-document formats understood by the loader pipeline.
     * Maps directly to the parsers registered in the pipeline.
     */
    enum MetaDataFormat {
        /** JavaScript Object Notation — the default format. */
        JSON,
        /** Extensible Markup Language — legacy format supported by {@link com.metaobjects.loader.parser.xml.XMLMetaDataParser}. */
        XML
    }

    /**
     * Returns a human-readable identifier for this source.
     * Used in parse-error messages (e.g. a filename or URI string).
     *
     * @return non-null identifier string
     */
    String getId();

    /**
     * Returns the format of this source's raw content.
     * Selects the parser that will process the document.
     *
     * @return non-null format value
     */
    MetaDataFormat getFormat();

    /**
     * Reads and returns the full raw content of this source.
     * May perform I/O; callers should be prepared for {@link IOException}.
     *
     * @return the raw document content as a {@code String}
     * @throws IOException if the content cannot be read
     */
    String read() throws IOException;
}
