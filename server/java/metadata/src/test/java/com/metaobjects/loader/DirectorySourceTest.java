package com.metaobjects.loader;

import org.junit.Test;
import java.io.IOException;
import java.io.UncheckedIOException;
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

    @Test public void excludePendingIsOffByDefault() throws IOException {
        // Loader-level default is OFF (matches TS's loader-level DirectorySource,
        // which has no _pending concept at all) — only the CLI-facing SourceResolver
        // turns it on. A runtime app embedding `new DirectorySource(dir)` directly
        // must see every file, _pending/ included.
        Path dir = Files.createTempDirectory("ds-");
        try {
            Files.writeString(dir.resolve("meta.live.json"), "{}");
            Path pending = Files.createDirectory(dir.resolve("_pending"));
            Files.writeString(pending.resolve("meta.draft.json"), "{}");

            DirectorySource src = new DirectorySource(dir);
            List<FileSource> expanded = src.expand().collect(Collectors.toList());

            assertEquals(2, expanded.size());
        } finally {
            deleteRecursively(dir);
        }
    }

    @Test public void excludesPendingDirAtAnyDepthWhenOptedIn() throws IOException {
        // Mirrors TypeScript's PENDING_DIR exclusion (metadata-files.ts) — a draft
        // entity under _pending/ must be invisible to codegen, not merely a file
        // that happens to be NAMED "_pending". SourceResolver (the CLI-facing
        // caller) opts in via setExcludePending(true); this test exercises the
        // option directly.
        Path dir = Files.createTempDirectory("ds-");
        try {
            Files.writeString(dir.resolve("meta.live.json"), "{}");
            Path pending = Files.createDirectory(dir.resolve("_pending"));
            Files.writeString(pending.resolve("meta.draft.json"), "{}");
            // Nested: _pending/ excluded at ANY depth, not just top-level.
            Path nestedPending = Files.createDirectories(dir.resolve("nested").resolve("_pending"));
            Files.writeString(nestedPending.resolve("meta.deep-draft.json"), "{}");

            DirectorySource src = new DirectorySource(dir,
                new DirectorySource.Options().setExcludePending(true));
            List<FileSource> expanded = src.expand().collect(Collectors.toList());

            assertEquals(1, expanded.size());
            assertEquals("meta.live.json", expanded.get(0).getId());
        } finally {
            deleteRecursively(dir);
        }
    }

    @Test public void followsASymlinkedRoot() throws IOException {
        // I1: the SOURCE path itself is a symlink to a directory. Files.isDirectory
        // follows symlinks (the existence guard passes), so the walk must too, or
        // the root resolves to zero files, silently.
        Path real = Files.createTempDirectory("ds-real-");
        Path parent = Files.createTempDirectory("ds-link-parent-");
        Path link = parent.resolve("link");
        try {
            Files.writeString(real.resolve("meta.a.json"), "{}");
            Files.createSymbolicLink(link, real);

            List<FileSource> expanded = new DirectorySource(link).expand().collect(Collectors.toList());

            assertEquals(1, expanded.size());
            assertEquals("meta.a.json", expanded.get(0).getId());
        } finally {
            deleteRecursively(parent);
            deleteRecursively(real);
        }
    }

    @Test public void followsASymlinkedSubdirectory() throws IOException {
        // I1, second arm: a symlinked SUBDIRECTORY inside a walked tree.
        Path dir = Files.createTempDirectory("ds-");
        Path external = Files.createTempDirectory("ds-external-");
        try {
            Files.writeString(dir.resolve("meta.top.json"), "{}");
            Files.writeString(external.resolve("meta.linked.json"), "{}");
            Files.createSymbolicLink(dir.resolve("linked"), external);

            List<FileSource> expanded = new DirectorySource(dir).expand().collect(Collectors.toList());

            assertEquals(2, expanded.size());
        } finally {
            deleteRecursively(dir);
            deleteRecursively(external);
        }
    }

    @Test public void aSymlinkCycleFailsLoudlyRatherThanHanging() throws IOException {
        Path dir = Files.createTempDirectory("ds-");
        try {
            Files.writeString(dir.resolve("meta.top.json"), "{}");
            // A directory symlinked to its own ancestor — a cycle.
            Files.createSymbolicLink(dir.resolve("loop"), dir);

            try {
                new DirectorySource(dir).expand().collect(Collectors.toList());
                fail("expected a symlink-loop failure, not a completed walk");
            } catch (UncheckedIOException expected) {
                // Files.walk(FOLLOW_LINKS) detects the cycle and throws
                // FileSystemLoopException, naming the looping path.
                assertNotNull(expected.getCause());
            }
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
        // NOFOLLOW_LINKS: a symlink (incl. one deliberately cyclic, as in
        // aSymlinkCycleFailsLoudlyRatherThanHanging above) is a leaf to delete
        // outright, never a directory to recurse INTO — Files.isDirectory's default
        // symlink-following would walk right back into the loop during cleanup.
        if (Files.isDirectory(p, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
            try (var s = Files.list(p)) {
                for (Path c : s.collect(Collectors.toList())) deleteRecursively(c);
            }
        }
        Files.deleteIfExists(p);
    }
}
