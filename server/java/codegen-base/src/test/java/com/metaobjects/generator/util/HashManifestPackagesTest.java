package com.metaobjects.generator.util;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/** ADR-0064 Amendment 1: the hash manifest is one file per model package. Runs the shared vectors. */
public class HashManifestPackagesTest {

    private static final Path VECTORS = Path.of("../../../fixtures/codegen-skip-conformance/manifests.json");
    private static final FileTime LONG_AGO = FileTime.fromMillis(1_000_000_000_000L);
    private static final HashManifest.Owner OWNER = new HashManifest.Owner("entity", "gen");

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private JsonObject vectors() throws IOException {
        return JsonParser.parseString(Files.readString(VECTORS)).getAsJsonObject();
    }

    private HashManifest.Placement placement(JsonObject v) {
        List<HashManifest.ModelObject> objects = new ArrayList<>();
        for (JsonElement el : v.getAsJsonArray("objects")) {
            JsonObject o = el.getAsJsonObject();
            objects.add(new HashManifest.ModelObject(o.get("name").getAsString(), o.get("package").getAsString()));
        }
        return new HashManifest.Placement(objects);
    }

    private static String nullable(JsonElement el) {
        return el == null || el.isJsonNull() ? null : el.getAsString();
    }

    private Path genState() {
        return tmp.getRoot().toPath().resolve(".metaobjects/.gen-state");
    }

    private static String textOf(Path file) throws IOException {
        return Files.readString(file);
    }

    private Map<String, String> filesIn(Path dir) throws IOException {
        Map<String, String> out = new LinkedHashMap<>();
        try (var s = Files.list(dir)) {
            for (Path p : s.sorted().toList()) out.put(p.getFileName().toString(), Files.readString(p));
        }
        return out;
    }

    @Test
    public void fileNames() throws Exception {
        for (JsonElement el : vectors().getAsJsonArray("fileNames")) {
            JsonObject c = el.getAsJsonObject();
            assertEquals(nullable(c.get("package")), c.get("file").getAsString(),
                    HashManifest.fileName(nullable(c.get("package"))));
        }
    }

    @Test
    public void placement() throws Exception {
        JsonObject v = vectors();
        HashManifest.Placement placement = placement(v);
        for (JsonElement el : v.getAsJsonArray("placement")) {
            JsonObject c = el.getAsJsonObject();
            JsonObject entry = c.has("entry") ? c.getAsJsonObject("entry") : null;
            assertEquals(c.get("path").getAsString() + ": " + nullable(c.get("why")),
                    nullable(c.get("package")), placement.packageOf(c.get("path").getAsString(), entry));
        }
    }

    @Test
    public void legacySplit() throws Exception {
        JsonObject v = vectors();
        JsonObject split = v.getAsJsonObject("legacySplit");
        Path gs = genState();
        Files.createDirectories(gs);
        Files.writeString(gs.resolve(".hashes.json"), split.getAsJsonObject("legacy").toString());
        Path gitignore = gs.getParent().resolve(".gitignore");
        Files.writeString(gitignore, split.get("gitignoreBefore").getAsString());

        Map<String, String> hashes = HashManifest.load(gs);
        Map<String, HashManifest.Owner> owners = HashManifest.loadOwners(gs);
        HashManifest.save(gs, hashes, owners, placement(v));

        assertFalse("the legacy file is removed", Files.exists(gs.resolve(".hashes.json")));
        Map<String, String> written = filesIn(gs.resolve(".hashes"));
        JsonObject expected = split.getAsJsonObject("files");
        assertEquals(new TreeSet<>(expected.keySet()), new TreeSet<>(written.keySet()));
        for (String name : expected.keySet()) {
            assertEquals(name, expected.get(name), JsonParser.parseString(written.get(name)));
        }
        assertEquals(split.get("goldenText").getAsString(), written.get(split.get("goldenFile").getAsString()));
        assertEquals(split.get("gitignoreAfter").getAsString(), Files.readString(gitignore));

        // A second identical write changes no file.
        for (Path p : Files.list(gs.resolve(".hashes")).toList()) Files.setLastModifiedTime(p, LONG_AGO);
        HashManifest.save(gs, HashManifest.load(gs), HashManifest.loadOwners(gs), placement(v));
        assertEquals(written, filesIn(gs.resolve(".hashes")));
        for (Path p : Files.list(gs.resolve(".hashes")).toList()) {
            assertEquals(p.toString(), LONG_AGO, Files.getLastModifiedTime(p));
        }
        assertEquals(split.get("gitignoreAfter").getAsString(), Files.readString(gitignore));
    }

    @Test
    public void gitignoreAlreadyMigratedOrWithoutTheRuleIsLeftAlone() throws Exception {
        Path gs = genState();
        Files.createDirectories(gs);
        Path gitignore = gs.getParent().resolve(".gitignore");
        String other = "node_modules/\n";
        Files.writeString(gitignore, other);
        HashManifest.record(gs, "gen/A.java", "a", OWNER);
        assertEquals(other, Files.readString(gitignore));
        String migrated = ".gen-state/*\n!.gen-state/.hashes/\n";
        Files.writeString(gitignore, migrated);
        HashManifest.record(gs, "gen/B.java", "b", OWNER);
        assertEquals(migrated, Files.readString(gitignore));
    }

    private HashManifest.Placement twoPackages() {
        return new HashManifest.Placement(List.of(
                new HashManifest.ModelObject("Order", "acme::shop"),
                new HashManifest.ModelObject("Customer", "acme::crm")));
    }

    private void save(Path gs, Map<String, String> hashes, HashManifest.Placement p) {
        Map<String, HashManifest.Owner> owners = new LinkedHashMap<>();
        for (String k : hashes.keySet()) owners.put(k, OWNER);
        HashManifest.save(gs, hashes, owners, p);
    }

    @Test
    public void differentPackagesDifferentFiles() throws Exception {
        Path gs = genState();
        Map<String, String> hashes = new LinkedHashMap<>();
        hashes.put("gen/Order.java", "h1");
        hashes.put("gen/Customer.java", "h2");
        hashes.put("gen/index.java", "h3");
        save(gs, hashes, twoPackages());
        Path dir = gs.resolve(".hashes");
        assertEquals(new TreeSet<>(List.of(".root.json", "acme.crm.json", "acme.shop.json")),
                new TreeSet<>(filesIn(dir).keySet()));
        for (Path p : Files.list(dir).toList()) Files.setLastModifiedTime(p, LONG_AGO);
        Map<String, String> before = filesIn(dir);

        // A no-op save writes nothing.
        save(gs, hashes, twoPackages());
        assertEquals(before, filesIn(dir));
        for (Path p : Files.list(dir).toList()) assertEquals(LONG_AGO, Files.getLastModifiedTime(p));

        // A change in one package changes only that package's file.
        hashes.put("gen/Order.java", "h1b");
        save(gs, hashes, twoPackages());
        Map<String, String> after = filesIn(dir);
        assertTrue(after.get("acme.shop.json").contains("h1b"));
        assertEquals(before.get("acme.crm.json"), after.get("acme.crm.json"));
        assertEquals(before.get(".root.json"), after.get(".root.json"));
        assertTrue(Files.getLastModifiedTime(dir.resolve("acme.shop.json")).compareTo(LONG_AGO) > 0);
        assertEquals(LONG_AGO, Files.getLastModifiedTime(dir.resolve("acme.crm.json")));
        assertEquals(LONG_AGO, Files.getLastModifiedTime(dir.resolve(".root.json")));

        // Removing a package's last entry deletes its file.
        hashes.remove("gen/Customer.java");
        save(gs, hashes, twoPackages());
        assertFalse(Files.exists(dir.resolve("acme.crm.json")));
        assertTrue(Files.exists(dir.resolve("acme.shop.json")));

        // An empty manifest keeps the root file as {}.
        save(gs, new LinkedHashMap<>(), twoPackages());
        assertEquals(java.util.Set.of(".root.json"), filesIn(dir).keySet());
        assertEquals("{}\n", textOf(dir.resolve(".root.json")));
        assertTrue(HashManifest.exists(gs));
    }

    @Test
    public void withoutAModelAnEntryStaysWhereItIs() throws Exception {
        Path gs = genState();
        save(gs, new LinkedHashMap<>(Map.of("gen/Order.java", "h1", "gen/Other.java", "h2")), twoPackages());
        Path dir = gs.resolve(".hashes");
        assertTrue(Files.exists(dir.resolve("acme.shop.json")));
        HashManifest.record(gs, "gen/New.java", "n", OWNER);   // no model: a new entry is root, the rest stay
        assertTrue(textOf(dir.resolve("acme.shop.json")).contains("gen/Order.java"));
        assertTrue(textOf(dir.resolve(".root.json")).contains("gen/New.java"));
        assertTrue(textOf(dir.resolve(".root.json")).contains("gen/Other.java"));
    }

    @Test
    public void readOnlyLoadOfALegacyManifestMigratesNothing() throws Exception {
        Path gs = genState();
        Files.createDirectories(gs);
        String legacy = "{\"gen/A.java\":\"h\"}";
        Files.writeString(gs.resolve(".hashes.json"), legacy);
        Files.writeString(gs.getParent().resolve(".gitignore"), ".gen-state/*\n!.gen-state/.hashes.json\n");

        assertTrue(HashManifest.exists(gs));
        assertTrue(HashManifest.hasLegacy(gs));
        assertEquals("h", HashManifest.load(gs).get("gen/A.java"));
        HashManifest.loadOwners(gs);

        assertEquals(legacy, Files.readString(gs.resolve(".hashes.json")));
        assertFalse(Files.exists(gs.resolve(".hashes")));
        assertEquals(".gen-state/*\n!.gen-state/.hashes.json\n", Files.readString(gs.getParent().resolve(".gitignore")));
    }

    @Test
    public void aPackageFileWinsOverTheLegacyFile() throws Exception {
        Path gs = genState();
        Files.createDirectories(gs.resolve(".hashes"));
        Files.writeString(gs.resolve(".hashes.json"), "{\"gen/A.java\":\"old\",\"gen/B.java\":\"b\"}");
        Files.writeString(gs.resolve(".hashes/acme.shop.json"), "{\"gen/A.java\":\"new\"}\n");
        Map<String, String> loaded = HashManifest.load(gs);
        assertEquals("new", loaded.get("gen/A.java"));
        assertEquals("b", loaded.get("gen/B.java"));
    }
}
