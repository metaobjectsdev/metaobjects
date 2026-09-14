package com.metaobjects.loader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Objects;

/**
 * A single-file {@link MetaDataSource} that reads its content from a local
 * filesystem path on demand.
 *
 * <p>The format is inferred from the filename extension
 * ({@code .yaml}/{@code .yml} → {@link MetaDataFormat#YAML}; everything else →
 * {@link MetaDataFormat#JSON}) unless an explicit format is supplied.</p>
 *
 * <p>Mirrors the cross-language {@code FileSource} class across all ports
 * (TS / Java / C# / Python). For URI-addressed sources (resource:, http:),
 * use {@link UriSource} instead.</p>
 *
 * <p>Example usage:</p>
 * <pre>{@code
 * MetaDataSource src = new FileSource(Path.of("metadata/meta.users.json"));
 * String content = src.read();
 * }</pre>
 */
public final class FileSource implements MetaDataSource {

    private final Path path;
    private final MetaDataFormat format;
    /** Explicit id, or {@code null} to derive it from the file name. */
    private final String id;

    /**
     * Constructs a file source with format inferred from the extension.
     *
     * @param path the filesystem path; must not be {@code null}
     */
    public FileSource(Path path) {
        this(path, inferFormat(path));
    }

    /**
     * Constructs a file source with an explicit ID, overriding the file-name default.
     *
     * <p>For a file whose identity in diagnostics should not depend on where it sits on
     * disk — a shipped library's YAML, whose envelope must read the same from a checkout
     * and from an installed jar, and must not collide with an adopter file of the same
     * basename.</p>
     *
     * @param path the filesystem path; must not be {@code null}
     * @param id   the source id to report; must not be {@code null}
     */
    public FileSource(Path path, String id) {
        this(path, inferFormat(path), id);
    }

    /**
     * Constructs a file source with an explicit format (overrides extension inference).
     *
     * @param path   the filesystem path; must not be {@code null}
     * @param format the document format; must not be {@code null}
     */
    public FileSource(Path path, MetaDataFormat format) {
        this(path, format, null);
    }

    /**
     * Constructs a file source with an explicit format AND id.
     *
     * @param path   the filesystem path; must not be {@code null}
     * @param format the document format; must not be {@code null}
     * @param id     the source id to report, or {@code null} to use the file name
     */
    public FileSource(Path path, MetaDataFormat format, String id) {
        this.path = Objects.requireNonNull(path, "path");
        this.format = Objects.requireNonNull(format, "format");
        this.id = id;
    }

    @Override
    public String getId() {
        return id != null ? id : path.getFileName().toString();
    }

    @Override
    public MetaDataFormat getFormat() {
        return format;
    }

    @Override
    public String read() throws IOException {
        return Files.readString(path, StandardCharsets.UTF_8);
    }

    /**
     * Returns the underlying filesystem path.
     *
     * @return the path supplied at construction time
     */
    public Path getPath() {
        return path;
    }

    private static MetaDataFormat inferFormat(Path path) {
        Objects.requireNonNull(path, "path");
        String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
        return (name.endsWith(".yaml") || name.endsWith(".yml"))
            ? MetaDataFormat.YAML
            : MetaDataFormat.JSON;
    }

    @Override
    public String toString() {
        return "FileSource{path='" + path + "', format=" + format + "}";
    }
}
