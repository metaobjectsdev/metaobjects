package com.metaobjects.render;

import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

public class FilesystemProviderTest {

    @Test
    public void resolvesExistingFile() throws IOException {
        Path root = Files.createTempDirectory("fp-");
        Path dir = Files.createDirectories(root.resolve("g"));
        Path file = dir.resolve("s.mustache");
        Files.writeString(file, "hello");
        try {
            Provider p = new FilesystemProvider(root);
            assertEquals("hello", p.resolve("g/s"));
        } finally {
            Files.deleteIfExists(file);
            Files.deleteIfExists(dir);
            Files.deleteIfExists(root);
        }
    }

    @Test
    public void returnsNullForMissingFile() throws IOException {
        Path root = Files.createTempDirectory("fp-");
        try {
            Provider p = new FilesystemProvider(root);
            assertNull(p.resolve("nope/none"));
        } finally {
            Files.deleteIfExists(root);
        }
    }

    @Test
    public void rejectsPathTraversal() throws IOException {
        Path root = Files.createTempDirectory("fp-");
        try {
            Provider p = new FilesystemProvider(root);
            assertNull(p.resolve("../escape/from-root"));   // null, not exception
        } finally {
            Files.deleteIfExists(root);
        }
    }

    @Test
    public void customExtension() throws IOException {
        Path root = Files.createTempDirectory("fp-");
        Path dir = Files.createDirectories(root.resolve("g"));
        Path file = dir.resolve("s.txt");
        Files.writeString(file, "hello");
        try {
            Provider p = new FilesystemProvider(root, ".txt");
            assertEquals("hello", p.resolve("g/s"));
        } finally {
            Files.deleteIfExists(file);
            Files.deleteIfExists(dir);
            Files.deleteIfExists(root);
        }
    }
}
