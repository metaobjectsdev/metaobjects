package com.metaobjects.loader;

/**
 * A {@link MetaDataSource} backed by an in-memory string.
 *
 * <p>Useful for unit tests and for loaders that have already read content
 * into memory and need to pass it through the pipeline as a source.
 * Mirrors the cross-language {@code InMemoryStringSource} class across all ports
 * (TS / Java / C# / Python).</p>
 *
 * <p>Example usage:</p>
 * <pre>{@code
 * MetaDataSource source = new InMemoryStringSource(
 *     "{\"metadata\": {}}", "<inline>", MetaDataSource.MetaDataFormat.JSON);
 * String content = source.read(); // returns the string immediately
 * }</pre>
 */
public class InMemoryStringSource implements MetaDataSource {

    private static final String DEFAULT_ID = "<inline>";

    private final String content;
    private final String id;
    private final MetaDataFormat format;

    /**
     * Constructs an in-memory source with an explicit id and format.
     *
     * @param content the raw document content; must not be {@code null}
     * @param id      human-readable identifier used in error messages; must not be {@code null}
     * @param format  the document format; must not be {@code null}
     */
    public InMemoryStringSource(String content, String id, MetaDataFormat format) {
        if (content == null) throw new IllegalArgumentException("content must not be null");
        if (id == null)      throw new IllegalArgumentException("id must not be null");
        if (format == null)  throw new IllegalArgumentException("format must not be null");
        this.content = content;
        this.id = id;
        this.format = format;
    }

    /**
     * Constructs an in-memory source with a default id of {@code "<inline>"}
     * and {@link MetaDataFormat#JSON} format.
     *
     * @param content the raw document content; must not be {@code null}
     */
    public InMemoryStringSource(String content) {
        this(content, DEFAULT_ID, MetaDataFormat.JSON);
    }

    /**
     * Constructs an in-memory source with an explicit id and {@link MetaDataFormat#JSON} format.
     *
     * @param content the raw document content; must not be {@code null}
     * @param id      human-readable identifier used in error messages; must not be {@code null}
     */
    public InMemoryStringSource(String content, String id) {
        this(content, id, MetaDataFormat.JSON);
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
     * Returns the in-memory content immediately; no I/O is performed.
     *
     * @return the content string supplied at construction time
     */
    @Override
    public String read() {
        return content;
    }

    @Override
    public String toString() {
        return "InMemoryStringSource{id='" + id + "', format=" + format + "}";
    }
}
