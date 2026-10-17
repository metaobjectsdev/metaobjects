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

    private static final String OWNER = "app:generate";

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
        HashManifest.record(genState, "src/X.java", content, OWNER);

        assertTrue(HashManifest.exists(genState));
        assertEquals(HashManifest.contentHash(content), HashManifest.recordedHash(genState, "src/X.java"));
    }

    @Test
    public void recordMergesRatherThanOverwritingOtherKeys() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        HashManifest.record(genState, "src/A.java", "a", OWNER);
        HashManifest.record(genState, "src/B.java", "b", OWNER);

        Map<String, String> loaded = HashManifest.load(genState);
        assertEquals(2, loaded.size());
        assertEquals(HashManifest.contentHash("a"), loaded.get("src/A.java"));
        assertEquals(HashManifest.contentHash("b"), loaded.get("src/B.java"));
    }

    @Test
    public void savedFileIsSortedPrettyAndTrailingNewline() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        HashManifest.record(genState, "src/Z.java", "z", OWNER);
        HashManifest.record(genState, "src/A.java", "a", OWNER);

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
        HashManifest.record(genState, "src/X.java", "original", OWNER);

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

    @Test
    public void ownedEntryIsWrittenWithItsOwner_plainEntryReadsAsUnowned() throws Exception {
        Path genState = tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
        Files.createDirectories(genState);
        // The plain form, as the TypeScript, Python and C# ports write it.
        Files.writeString(genState.resolve(".hashes.json"), "{\n  \"src/Plain.java\": \"abc\"\n}\n");

        HashManifest.record(genState, "src/Owned.java", "owned", OWNER);

        Map<String, String> hashes = HashManifest.load(genState);
        assertEquals("abc", hashes.get("src/Plain.java"));
        assertEquals(HashManifest.contentHash("owned"), hashes.get("src/Owned.java"));
        Map<String, String> owners = HashManifest.loadOwners(genState);
        assertEquals(OWNER, owners.get("src/Owned.java"));
        assertFalse(owners.containsKey("src/Plain.java"));

        com.google.gson.JsonObject raw = com.google.gson.JsonParser.parseString(
            Files.readString(genState.resolve(".hashes.json"))).getAsJsonObject();
        assertEquals("abc", raw.get("src/Plain.java").getAsString());
        com.google.gson.JsonObject owned = raw.getAsJsonObject("src/Owned.java");
        assertEquals(HashManifest.contentHash("owned"), owned.get("hash").getAsString());
        assertEquals(OWNER, owned.get("owner").getAsString());
    }
}
