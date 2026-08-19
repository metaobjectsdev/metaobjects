package com.metaobjects.loader;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.FileSystemLoopException;
import java.nio.file.FileVisitOption;
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
        private boolean excludePending = false;

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

        /**
         * Sets whether {@code _pending/} (at any depth) is excluded from expansion.
         * Default: {@code false} — this is a LOADER-level primitive, and
         * {@code _pending/} is a CLI/pending-workflow concept (TypeScript's
         * {@code metadata-files.ts}, not its loader-level {@code DirectorySource}).
         * {@link com.metaobjects.config.SourceResolver}, the CLI-facing caller, turns
         * this ON explicitly rather than the exclusion being baked into every
         * embedder of this class (a runtime app calling {@code new DirectorySource(dir)}
         * directly gets every file back, matching the reference loader).
         */
        public Options setExcludePending(boolean excludePending) {
            this.excludePending = excludePending;
            return this;
        }

        public List<String> getExclude() { return exclude; }
        public boolean isRecurse() { return recurse; }
        public boolean isExcludePending() { return excludePending; }
    }

    private static final Set<String> EXTENSIONS = Set.of(".json", ".yaml", ".yml");

    /**
     * Directory excluded at every level of {@link #expand()} — drafts that are
     * deliberately not part of the loaded model. Mirrors TypeScript's
     * {@code PENDING_DIR} in {@code metadata-files.ts}.
     */
    private static final String PENDING_DIR = "_pending";

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
     * <p>Follows symlinked directories — including when {@code directory} itself
     * is a symlink — matching TypeScript ({@code stat}, not {@code lstat}) and C#
     * ({@code EnumerateFiles(..., AllDirectories)}), both of which have always
     * followed symlinks this way. A symlink CYCLE is a loud error rather than a
     * hang: {@code Files.walk}'s own traversal detects it and throws
     * {@link FileSystemLoopException} (naming the looping path), which the JDK
     * wraps in {@link UncheckedIOException} and surfaces from whichever stream
     * operation is consuming this method's lazily-returned {@link Stream} — not
     * from this method itself, since the walk has not actually run yet when
     * {@code expand()} returns.</p>
     *
     * @return stream of file sources; caller should close if iteration is partial
     * @throws UncheckedIOException if the directory cannot be listed
     */
    public Stream<FileSource> expand() {
        try {
            Stream<Path> walk = opts.isRecurse()
                ? Files.walk(directory, FileVisitOption.FOLLOW_LINKS)
                : Files.list(directory);
            return walk
                .filter(Files::isRegularFile)
                .filter(p -> hasSupportedExtension(p.getFileName().toString()))
                .filter(p -> !opts.getExclude().contains(p.getFileName().toString()))
                // Excludes _pending/ at ANY depth — every ancestor path component
                // between `directory` and `p` is checked, not merely `p`'s own
                // basename, so the whole subtree is skipped. Off by default — see
                // Options.setExcludePending.
                .filter(p -> !opts.isExcludePending() || !isUnderPendingDir(directory, p))
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

    /**
     * True when any ancestor path component between {@code base} and {@code file}
     * (i.e. excluding {@code file}'s own name) is exactly {@link #PENDING_DIR}.
     */
    private static boolean isUnderPendingDir(Path base, Path file) {
        Path rel = base.relativize(file).getParent();
        if (rel == null) return false;
        for (Path part : rel) {
            if (part.toString().equals(PENDING_DIR)) return true;
        }
        return false;
    }

    private static boolean hasSupportedExtension(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        for (String ext : EXTENSIONS) {
            if (lower.endsWith(ext)) return true;
        }
        return false;
    }
}
