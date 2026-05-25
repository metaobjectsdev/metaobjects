package com.metaobjects.loader;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * A directory of metadata files. Expands into a deterministically-ordered
 * stream of {@link FileSource} — discovers {@code .json}, {@code .yaml}, and
 * {@code .yml} files (case-insensitive). Recurses into subdirectories by default.
 *
 * <p>Mirrors the cross-language {@code DirectorySource} class across all ports
 * (TS / Java / C# / Python). Replaces the old
 * {@code LocalFileMetaDataSources} / {@code URIFileMetaDataSources} helper hierarchy.</p>
 *
 * <p>Example usage:</p>
 * <pre>{@code
 * DirectorySource src = new DirectorySource(Path.of("metadata"));
 * List<MetaDataSource> sources = src.expand()
 *     .map(fs -> (MetaDataSource) fs)
 *     .collect(Collectors.toList());
 * }</pre>
 */
public final class DirectorySource {

    /**
     * Options controlling directory expansion.
     */
    public static final class Options {
        private List<String> exclude = List.of();
        private boolean recurse = true;

        /**
         * Sets filenames to exclude from expansion (exact filename match).
         */
        public Options setExclude(List<String> excludeNames) {
            this.exclude = excludeNames == null ? List.of() : List.copyOf(excludeNames);
            return this;
        }

        /**
         * Sets whether to recurse into subdirectories. Default: {@code true}.
         */
        public Options setRecurse(boolean recurse) {
            this.recurse = recurse;
            return this;
        }

        public List<String> getExclude() { return exclude; }
        public boolean isRecurse() { return recurse; }
    }

    private static final Set<String> EXTENSIONS = Set.of(".json", ".yaml", ".yml");

    private final Path directory;
    private final Options opts;

    public DirectorySource(Path directory) {
        this(directory, new Options());
    }

    public DirectorySource(Path directory, Options opts) {
        this.directory = Objects.requireNonNull(directory, "directory");
        this.opts = Objects.requireNonNull(opts, "opts");
    }

    /**
     * Returns the configured directory.
     */
    public Path getDirectory() {
        return directory;
    }

    /**
     * Returns the configured options.
     */
    public Options getOptions() {
        return opts;
    }

    /**
     * Expands this directory into a sorted stream of {@link FileSource}.
     * Sorted by full path (ordinal) for deterministic ordering across runs.
     *
     * @return stream of file sources; caller should close if iteration is partial
     * @throws UncheckedIOException if the directory cannot be listed
     */
    public Stream<FileSource> expand() {
        try {
            Stream<Path> walk = opts.isRecurse()
                ? Files.walk(directory)
                : Files.list(directory);
            return walk
                .filter(Files::isRegularFile)
                .filter(p -> hasSupportedExtension(p.getFileName().toString()))
                .filter(p -> !opts.getExclude().contains(p.getFileName().toString()))
                .sorted(Comparator.comparing(p -> p.getFileName().toString()))
                .map(FileSource::new);
        } catch (IOException e) {
            throw new UncheckedIOException("Failed to list " + directory, e);
        }
    }

    /**
     * Convenience: expand and collect to a list of {@link MetaDataSource}.
     */
    public List<MetaDataSource> expandToList() {
        return expand().map(fs -> (MetaDataSource) fs).collect(Collectors.toList());
    }

    private static boolean hasSupportedExtension(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String ext : EXTENSIONS) {
            if (lower.endsWith(ext)) return true;
        }
        return false;
    }
}
