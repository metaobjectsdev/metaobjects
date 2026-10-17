package com.metaobjects.generator.util;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

/** The committed hash manifest: shape, merge semantics, fail-closed reads. */
public class HashManifestTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    @Test
    public void absentManifestDoesNotExistAndLoadsEmpty() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        assertFalse(HashManifest.exists(genState));
        assertTrue(HashManifest.load(genState).isEmpty());
        assertNull(HashManifest.recordedHash(genState, "src/X.java"));
    }

    @Test
    public void recordThenExistsThenRecordedHash() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        String content = "public class X {}\n";
        HashManifest.record(genState, "src/X.java", content);

        assertTrue(HashManifest.exists(genState));
        assertEquals(HashManifest.contentHash(content), HashManifest.recordedHash(genState, "src/X.java"));
    }

    @Test
    public void recordMergesRatherThanOverwritingOtherKeys() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        HashManifest.record(genState, "src/A.java", "a");
        HashManifest.record(genState, "src/B.java", "b");

        Map<String, String> loaded = HashManifest.load(genState);
        assertEquals(2, loaded.size());
        assertEquals(HashManifest.contentHash("a"), loaded.get("src/A.java"));
        assertEquals(HashManifest.contentHash("b"), loaded.get("src/B.java"));
    }

    @Test
    public void savedFileIsSortedPrettyAndTrailingNewline() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        HashManifest.record(genState, "src/Z.java", "z");
        HashManifest.record(genState, "src/A.java", "a");

        String raw = Files.readString(genState.resolve(".hashes.json"));
        assertTrue("expected a trailing newline", raw.endsWith("\n"));
        // Sorted: A before Z.
        assertTrue(raw.indexOf("src/A.java") < raw.indexOf("src/Z.java"));
        // Pretty-printed: not a single line.
        assertTrue(raw.contains("\n  "));
    }

    @Test
    public void isPristineFailsClosedWhenNeverRecorded() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        assertFalse(HashManifest.isPristine(genState, "src/Never.java", "anything"));
    }

    @Test
    public void isPristineTrueOnlyForExactRecordedContent() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        HashManifest.record(genState, "src/X.java", "original");

        assertTrue(HashManifest.isPristine(genState, "src/X.java", "original"));
        assertFalse(HashManifest.isPristine(genState, "src/X.java", "edited"));
    }

    @Test
    public void contentHashIsStableAndLowercaseHex() {
        String h1 = HashManifest.contentHash("hello");
        String h2 = HashManifest.contentHash("hello");
        assertEquals(h1, h2);
        assertEquals(64, h1.length());
        assertEquals(h1, h1.toLowerCase());
    }
}
