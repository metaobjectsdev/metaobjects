package com.metaobjects.integration;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * A throwaway SQLite database file for one test. SQLite is embedded, so there is no container:
 * the file lives in a temp directory and {@link #close()} removes it.
 */
public final class SqliteDatabase implements JdbcTarget, AutoCloseable {
    private final Path dir;
    private final String jdbcUrl;

    public SqliteDatabase() {
        try {
            dir = Files.createTempDirectory("mo-sqlite-");
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
        jdbcUrl = "jdbc:sqlite:" + dir.resolve("test.db");
    }

    @Override public String jdbcUrl()  { return jdbcUrl; }
    @Override public String username() { return ""; }
    @Override public String password() { return ""; }

    @Override public void close() {
        try (var files = Files.walk(dir)) {
            files.sorted(java.util.Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
        } catch (IOException ignored) {
            // a leftover temp file is harmless
        }
    }
}
