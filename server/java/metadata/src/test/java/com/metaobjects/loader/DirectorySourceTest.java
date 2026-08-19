package com.metaobjects.loader;

import org.junit.Test;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import static org.junit.Assert.*;

/**
 * Tests for {@link DirectorySource} — directory-expansion MetaDataSource impl.
 */
public class DirectorySourceTest {

    @Test public void expandReturnsFileSourcesSortedByOrdinalName() throws IOException {
        Path dir = Files.createTempDirectory("ds-");
        try {
            Files.writeString(dir.resolve("b.json"), "{}");
            Files.writeString(dir.resolve("a.yaml"), "");
            Files.writeString(dir.resolve("ignored.txt"), "x");

            DirectorySource src = new DirectorySource(dir);
            List<FileSource> expanded = src.expand().collect(Collectors.toList());

            assertEquals(2, expanded.size());
            assertEquals("a.yaml", expanded.get(0).getId());
            assertEquals(MetaDataSource.MetaDataFormat.YAML, expanded.get(0).getFormat());
            assertEquals("b.json", expanded.get(1).getId());
            assertEquals(MetaDataSource.MetaDataFormat.JSON, expanded.get(1).getFormat());
        } finally {
            deleteRecursively(dir);
        }
    }

    @Test public void honorsExcludeNames() throws IOException {
        Path dir = Files.createTempDirectory("ds-");
        try {
            Files.writeString(dir.resolve("meta.alpha.json"), "{}");
            Files.writeString(dir.resolve("meta.beta.json"), "{}");
            DirectorySource src = new DirectorySource(dir,
                new DirectorySource.Options().setExclude(List.of("meta.beta.json")));
            List<FileSource> expanded = src.expand().collect(Collectors.toList());
            assertEquals(1, expanded.size());
            assertEquals("meta.alpha.json", expanded.get(0).getId());
        } finally {
            deleteRecursively(dir);
        }
    }

    @Test public void recursesIntoSubdirectoriesByDefault() throws IOException {
        Path dir = Files.createTempDirectory("ds-");
        try {
            Path sub = Files.createDirectory(dir.resolve("sub"));
            Files.writeString(dir.resolve("top.json"), "{}");
            Files.writeString(sub.resolve("nested.json"), "{}");
            DirectorySource src = new DirectorySource(dir);
            List<FileSource> expanded = src.expand().collect(Collectors.toList());
            assertEquals(2, expanded.size());
        } finally {
            deleteRecursively(dir);
        }
    }

    @Test public void excludesPendingDirAtAnyDepth() throws IOException {
        // Mirrors TypeScript's PENDING_DIR exclusion (metadata-files.ts) — a draft
        // entity under _pending/ must be invisible to codegen, not merely a file
        // that happens to be NAMED "_pending". Before this fix, only TypeScript
        // knew about this directory; a draft would generate a live table under
        // `mvn metaobjects:generate`.
        Path dir = Files.createTempDirectory("ds-");
        try {
            Files.writeString(dir.resolve("meta.live.json"), "{}");
            Path pending = Files.createDirectory(dir.resolve("_pending"));
            Files.writeString(pending.resolve("meta.draft.json"), "{}");
            // Nested: _pending/ excluded at ANY depth, not just top-level.
            Path nestedPending = Files.createDirectories(dir.resolve("nested").resolve("_pending"));
            Files.writeString(nestedPending.resolve("meta.deep-draft.json"), "{}");

            DirectorySource src = new DirectorySource(dir);
            List<FileSource> expanded = src.expand().collect(Collectors.toList());

            assertEquals(1, expanded.size());
            assertEquals("meta.live.json", expanded.get(0).getId());
        } finally {
            deleteRecursively(dir);
        }
    }

    @Test public void nonRecursiveSkipsSubdirectories() throws IOException {
        Path dir = Files.createTempDirectory("ds-");
        try {
            Path sub = Files.createDirectory(dir.resolve("sub"));
            Files.writeString(dir.resolve("top.json"), "{}");
            Files.writeString(sub.resolve("nested.json"), "{}");
            DirectorySource src = new DirectorySource(dir,
                new DirectorySource.Options().setRecurse(false));
            List<FileSource> expanded = src.expand().collect(Collectors.toList());
            assertEquals(1, expanded.size());
            assertEquals("top.json", expanded.get(0).getId());
        } finally {
            deleteRecursively(dir);
        }
    }

    private static void deleteRecursively(Path p) throws IOException {
        if (Files.isDirectory(p)) {
            try (var s = Files.list(p)) {
                for (Path c : s.collect(Collectors.toList())) deleteRecursively(c);
            }
        }
        Files.deleteIfExists(p);
    }
}
