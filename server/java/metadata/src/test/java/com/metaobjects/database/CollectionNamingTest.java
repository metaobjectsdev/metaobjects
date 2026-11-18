package com.metaobjects.database;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.MetaDataException;
import com.metaobjects.config.NeutralConfig;
import org.junit.After;
import org.junit.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Comparator;
import java.util.List;
import java.util.stream.Stream;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

/**
 * {@code naming.collections} names the pluralizer an object without {@code @collectionName}
 * takes its collection name from. Java generates nothing from it yet, but a project shared with
 * a port that does carries the key, so Java reads it, refuses an unknown name like
 * {@code columns} and {@code tables}, and keeps the selected name on the loaded naming.
 */
public class CollectionNamingTest {

    @After
    public void reset() {
        NamingStrategies.resetForTesting();
    }

    private static PhysicalNaming readNaming(String naming) throws IOException {
        Path dir = Files.createTempDirectory("mo-collection-naming-");
        try {
            Files.createDirectory(dir.resolve(".metaobjects"));
            Files.writeString(dir.resolve(".metaobjects").resolve("config.json"),
                "{ \"schema_version\": 1, \"naming\": " + naming + " }");
            return NeutralConfig.read(dir).orElseThrow().getPhysicalNaming();
        } finally {
            try (Stream<Path> paths = Files.walk(dir)) {
                paths.sorted(Comparator.reverseOrder()).forEach(p -> p.toFile().delete());
            }
        }
    }

    @Test
    public void theBuiltInsPluralizeOrKeepTheName() {
        assertEquals(List.of("standard", "none"), NamingStrategies.BUILT_IN_PLURALIZERS);
        assertEquals("standard", NamingStrategies.DEFAULT_PLURALIZER);
        assertEquals("CaseHistories", NamingStrategies.pluralizer("standard").apply("CaseHistory"));
        assertEquals("CaseHistory", NamingStrategies.pluralizer("none").apply("CaseHistory"));
    }

    @Test
    public void standardMatchesTheSharedNamingConformanceCorpus() throws IOException {
        Path repoRoot = Path.of(System.getProperty("user.dir")).resolve("../../..").normalize();
        Path fixture = repoRoot.resolve("fixtures/naming-conformance/already-plural-pluralize.json");
        JsonArray cases = JsonParser.parseString(Files.readString(fixture)).getAsJsonObject().getAsJsonArray("cases");
        assertFalse(cases.isEmpty());
        for (int i = 0; i < cases.size(); i++) {
            JsonObject c = cases.get(i).getAsJsonObject();
            String name = c.get("name").getAsString();
            assertEquals(name, c.get("apiPlural").getAsString(), NamingStrategies.standardPluralize(name));
        }
    }

    @Test
    public void theConfigReadsABuiltIn() throws IOException {
        assertEquals("none", readNaming("{ \"collections\": \"none\" }").collections());
    }

    @Test
    public void absentNamesNoPluralizer() throws IOException {
        assertNull(readNaming("{ \"columns\": \"snake_case\" }").collections());
    }

    @Test
    public void anUnknownPluralizerIsRefusedNamingTheKind() {
        MetaDataException ex = assertThrows(MetaDataException.class,
            () -> readNaming("{ \"collections\": \"latin\" }"));
        assertTrue(ex.getMessage(), ex.getMessage().contains("\"naming.collections\" names \"latin\""));
        assertTrue(ex.getMessage(), ex.getMessage().contains("Java port"));
    }

    @Test
    public void anApplicationPluralizerIsSelectable() throws IOException {
        NamingStrategies.registerPluralizer("java-test-shout", n -> n.toUpperCase() + "S");
        assertTrue(NamingStrategies.registeredPluralizers().contains("java-test-shout"));
        assertEquals("java-test-shout", readNaming("{ \"collections\": \"java-test-shout\" }").collections());
        NamingStrategies.resetForTesting();
        assertFalse(NamingStrategies.isPluralizer("java-test-shout"));
    }

    @Test
    public void aBuiltInPluralizerCannotBeReplaced() {
        assertThrows(IllegalArgumentException.class, () -> NamingStrategies.registerPluralizer("none", n -> n));
        assertThrows(IllegalArgumentException.class, () -> NamingStrategies.registerPluralizer("standard", n -> n));
    }
}
