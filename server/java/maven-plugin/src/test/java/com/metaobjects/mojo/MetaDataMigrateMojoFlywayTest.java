package com.metaobjects.mojo;

import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;

/**
 * Unit tests for the Flyway version-numbering helper on {@link MetaDataMigrateMojo}.
 * Exercises {@code nextFlywayVersion(Path, String)} in isolation — the surrounding mojo
 * execution path requires a live JDBC connection and is covered by integration tests.
 */
public class MetaDataMigrateMojoFlywayTest {

    @Test public void nextVersionStartsAtOneOnEmptyDir() throws Exception {
        Path dir = Files.createTempDirectory("fw-");
        try {
            int v = MetaDataMigrateMojo.nextFlywayVersion(dir, "V");
            assertEquals(1, v);
        } finally {
            Files.deleteIfExists(dir);
        }
    }

    @Test public void nextVersionIncrementsHighest() throws Exception {
        Path dir = Files.createTempDirectory("fw-");
        try {
            Files.writeString(dir.resolve("V001__init.sql"), "");
            Files.writeString(dir.resolve("V003__skip.sql"), "");
            Files.writeString(dir.resolve("V005__latest.sql"), "");
            int v = MetaDataMigrateMojo.nextFlywayVersion(dir, "V");
            assertEquals(6, v);
        } finally {
            try (var s = Files.list(dir)) {
                s.forEach(p -> p.toFile().delete());
            }
            Files.deleteIfExists(dir);
        }
    }

    @Test public void nextVersionIgnoresNonMatchingFiles() throws Exception {
        Path dir = Files.createTempDirectory("fw-");
        try {
            Files.writeString(dir.resolve("README.md"), "");
            Files.writeString(dir.resolve("V002__only.sql"), "");
            int v = MetaDataMigrateMojo.nextFlywayVersion(dir, "V");
            assertEquals(3, v);
        } finally {
            try (var s = Files.list(dir)) {
                s.forEach(p -> p.toFile().delete());
            }
            Files.deleteIfExists(dir);
        }
    }
}
