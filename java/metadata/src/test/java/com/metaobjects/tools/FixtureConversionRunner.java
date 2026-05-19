package com.metaobjects.tools;

// H3b-1 Task 4 one-shot conversion runner.
// Run once via:
//   cd java && mvn test -pl metadata -Dtest=FixtureConversionRunner -Dmaven.test.failure.ignore=true
// DELETED in H3b-1 Task 5 together with LegacyMetadataConverter.

import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.attr.*;
import com.metaobjects.field.*;
import com.metaobjects.identity.PrimaryIdentity;
import com.metaobjects.io.json.CanonicalJsonSerializer;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.parser.json.JsonMetaDataParser;
import com.metaobjects.loader.parser.xml.XMLMetaDataParser;
import com.metaobjects.object.mapped.MappedMetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Before;
import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * One-shot runner that converts every legacy metadata fixture to canonical JSON.
 *
 * <p>Strategy:
 * <ul>
 *   <li>Standalone files (no cross-file super) → {@link LegacyMetadataConverter#convertToCanonical}.</li>
 *   <li>Cross-file super files → load dependencies first, then load target; serialize the FULL
 *       merged root, then extract only children NOT already present in the dep-only serialization.</li>
 *   <li>Produce XML files → use XML parser (the companion JSON has legacy quirks).</li>
 * </ul>
 */
public class FixtureConversionRunner extends SharedRegistryTestBase {

    private static final String JAVA_ROOT = System.getProperty("java.fixtures.root",
            resolveJavaRoot());

    private static String resolveJavaRoot() {
        Path here = Paths.get("").toAbsolutePath();
        if (here.getFileName() != null && "metadata".equals(here.getFileName().toString())) {
            return here.getParent().toString();
        }
        return here.toString();
    }

    @Before
    public void setUp() {
        try {
            new StringField("testString");
            new IntegerField("testInt");
            new LongField("testLong");
            new DoubleField("testDouble");
            new BooleanField("testBoolean");
            new PrimaryIdentity("testPrimary");
            new StringAttribute("testStringAttr");
            new IntAttribute("testIntAttr");
            new BooleanAttribute("testBoolAttr");
            new DoubleAttribute("testDoubleAttr");
            new LongAttribute("testLongAttr");
            MappedMetaObject.create("setup::Boot");
        } catch (Exception e) { /* already registered */ }
    }

    @Test
    public void convertAllFixtures() throws Exception {
        System.out.println("=== FixtureConversionRunner (JAVA_ROOT=" + JAVA_ROOT + ") ===");
        Path root = Paths.get(JAVA_ROOT);
        assertTrue("JAVA_ROOT must exist: " + root, Files.isDirectory(root));

        int[] ok = {0}, err = {0};

        // ---- core/produce/v1 — use XML sources (JSON has legacy quirks) ----
        {
            Path dir = root.resolve("core/src/test/resources/metadata/test/produce/v1");
            doXml(dir, "meta.common", ok, err, List.of());
            doXml(dir, "meta.fruit", ok, err, List.of());
            doXml(dir, "meta.vegetable", ok, err, List.of());
            doXml(dir, "meta.basket", ok, err,
                    List.of(dir.resolve("meta.common.xml"),
                            dir.resolve("meta.fruit.xml"),
                            dir.resolve("meta.vegetable.xml")));
            doXml(dir, "meta.fruit.overlay", ok, err, List.of());

            deleteXml(dir.resolve("meta.common.xml"));
            deleteXml(dir.resolve("meta.fruit.xml"));
            deleteXml(dir.resolve("meta.vegetable.xml"));
            deleteXml(dir.resolve("meta.basket.xml"));
            deleteXml(dir.resolve("meta.fruit.overlay.xml"));
        }

        // ---- metadata simple / metaobjects namespace ----
        {
            Path dir = root.resolve("metadata/src/test/resources/com/metaobjects/loader/simple");
            doJson(dir, "acme-common-metadata.json", ok, err, List.of());
            doJson(dir, "acme-vehicle-metadata.json", ok, err,
                    List.of(dir.resolve("acme-common-metadata.json")));
            doJson(dir, "acme-vehicle-overlay-metadata.json", ok, err, List.of());
            doJson(dir, "fruitbasket-metadata.json", ok, err, List.of());
            doJson(dir, "fruitbasket-proxy-metadata.json", ok, err, List.of());
            doJson(dir, "test-common.json", ok, err, List.of());
            doJson(dir, "test-concrete.json", ok, err,
                    List.of(dir.resolve("test-common.json")));
        }

        // ---- metadata simple / draagon namespace ----
        {
            Path dir = root.resolve("metadata/src/test/resources/com/draagon/meta/loader/simple");
            doJson(dir, "acme-common-metadata.json", ok, err, List.of());
            doJson(dir, "acme-vehicle-metadata.json", ok, err,
                    List.of(dir.resolve("acme-common-metadata.json")));
            doJson(dir, "acme-vehicle-overlay-metadata.json", ok, err, List.of());
            doJson(dir, "fruitbasket-metadata.json", ok, err, List.of());
            doJson(dir, "fruitbasket-proxy-metadata.json", ok, err, List.of());
            doJson(dir, "test-common.json", ok, err, List.of());
            doJson(dir, "test-concrete.json", ok, err,
                    List.of(dir.resolve("test-common.json")));
        }

        // ---- relationship-examples ----
        {
            Path dir = root.resolve("metadata/src/test/resources/relationship-examples");
            doJson(dir, "simple-relationship-patterns.json", ok, err, List.of());
            doJson(dir, "blog-relationships.json", ok, err, List.of());
            doJson(dir, "ecommerce-relationships.json", ok, err, List.of());
        }

        // ---- archetype ----
        {
            Path dir = root.resolve("archetype/src/main/resources/archetype-resources/src/main/resources/metadata");
            doJson(dir, "application-metadata.json", ok, err, List.of());
            doJson(dir, "database-overlay.json", ok, err, List.of());
        }

        // ---- examples ----
        {
            Path dir = root.resolve("examples/shared-resources/src/main/resources/metadata");
            doJson(dir, "examples-metadata.json", ok, err, List.of());
        }

        // ---- maven-plugin ----
        {
            Path dir = root.resolve("maven-plugin/src/test/resources/mojo");
            doJson(dir, "mojo-test-metadata.json", ok, err, List.of());
            deleteXml(dir.resolve("mojo-test-metadata.xml"));
        }

        System.out.printf("=== done: %d ok, %d errors ===%n", ok[0], err[0]);
        if (err[0] > 0) fail(err[0] + " conversion error(s) — see stdout");
    }

    // -----------------------------------------------------------------------
    // per-format entry points
    // -----------------------------------------------------------------------

    private void doJson(Path dir, String filename, int[] ok, int[] err, List<Path> deps) {
        Path f = dir.resolve(filename);
        if (!Files.exists(f)) { System.out.println("  SKIP (missing): " + f); return; }

        if (isCanonical(f)) {
            System.out.println("  SKIP (already canonical): " + f.getFileName()); ok[0]++; return;
        }
        try {
            String canonical = deps.isEmpty()
                    ? convertJsonStandalone(f)
                    : convertJsonWithDeps(f, deps);
            Files.writeString(f, canonical, StandardCharsets.UTF_8);
            System.out.println("  OK: " + f.getFileName());
            ok[0]++;
        } catch (Exception e) {
            System.err.println("  ERROR: " + f.getFileName() + " — " + e.getMessage());
            e.printStackTrace(System.err);
            err[0]++;
        }
    }

    private void doXml(Path dir, String stem, int[] ok, int[] err, List<Path> depXmls) {
        Path xml = dir.resolve(stem + ".xml");
        Path outJson = dir.resolve(stem + ".json");
        if (!Files.exists(xml)) { System.out.println("  SKIP (missing): " + xml); return; }
        try {
            String canonical = depXmls.isEmpty()
                    ? convertXmlStandalone(xml)
                    : convertXmlWithDeps(xml, outJson, depXmls);
            Files.writeString(outJson, canonical, StandardCharsets.UTF_8);
            System.out.println("  OK: " + xml.getFileName() + " → " + outJson.getFileName());
            ok[0]++;
        } catch (Exception e) {
            System.err.println("  ERROR: " + xml.getFileName() + " — " + e.getMessage());
            e.printStackTrace(System.err);
            err[0]++;
        }
    }

    // -----------------------------------------------------------------------
    // Conversion implementations
    // -----------------------------------------------------------------------

    private String convertJsonStandalone(Path f) throws IOException {
        return LegacyMetadataConverter.convertToCanonical(f);
    }

    /**
     * Convert a JSON file that requires pre-loaded dependencies.
     * Strategy: load deps into a loader; serialize to get "baseline" children;
     * then load the target file and re-serialize; extract children NOT in baseline.
     */
    private String convertJsonWithDeps(Path targetFile, List<Path> deps) throws IOException {
        byte[] targetBytes = Files.readAllBytes(targetFile);
        String declaredPkg = LegacyMetadataConverter.peekJsonPackage(targetBytes);

        MetaDataLoader loader = freshLoader(declaredPkg);

        // Load dependencies (may already be canonical → use CanonicalJsonParser;
        // or legacy → use JsonMetaDataParser)
        for (Path dep : deps) {
            if (Files.exists(dep)) loadFile(loader, dep);
        }

        // Snapshot of children keys after loading deps only
        Set<String> depChildrenKeys = childrenKeys(loader);

        // Load target file
        new JsonMetaDataParser(loader, targetFile.getFileName().toString())
                .loadFromStream(new ByteArrayInputStream(targetBytes));

        // Serialize full merged root
        String mergedCanonical = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());

        // Extract only children added by target (not in baseline)
        String canonical = filterNewChildren(mergedCanonical, depChildrenKeys, declaredPkg);

        if (declaredPkg == null || declaredPkg.isEmpty()) {
            canonical = LegacyMetadataConverter.stripRootPackageKey(canonical);
        }

        return canonical;
    }

    private String convertXmlStandalone(Path xml) throws IOException {
        byte[] bytes = Files.readAllBytes(xml);
        String pkg = LegacyMetadataConverter.peekXmlPackage(bytes);
        MetaDataLoader loader = freshLoader(pkg);
        new XMLMetaDataParser(loader, xml.getFileName().toString())
                .loadFromStream(new ByteArrayInputStream(bytes));
        String canonical = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        if (pkg == null || pkg.isEmpty()) canonical = LegacyMetadataConverter.stripRootPackageKey(canonical);
        return canonical;
    }

    private String convertXmlWithDeps(Path xml, Path outJson, List<Path> depXmls) throws IOException {
        byte[] bytes = Files.readAllBytes(xml);
        String pkg = LegacyMetadataConverter.peekXmlPackage(bytes);
        MetaDataLoader loader = freshLoader(pkg);

        for (Path dep : depXmls) {
            if (Files.exists(dep)) {
                byte[] db = Files.readAllBytes(dep);
                new XMLMetaDataParser(loader, dep.getFileName().toString())
                        .loadFromStream(new ByteArrayInputStream(db));
            }
        }

        Set<String> depChildrenKeys = childrenKeys(loader);

        new XMLMetaDataParser(loader, xml.getFileName().toString())
                .loadFromStream(new ByteArrayInputStream(bytes));

        String mergedCanonical = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
        String canonical = filterNewChildren(mergedCanonical, depChildrenKeys, pkg);

        if (pkg == null || pkg.isEmpty()) canonical = LegacyMetadataConverter.stripRootPackageKey(canonical);
        return canonical;
    }

    // -----------------------------------------------------------------------
    // Filter helpers
    // -----------------------------------------------------------------------

    /**
     * Returns the set of canonical node "keys" for the root's children.
     * Each key is {@code "<typeKey>|<fqName>"} to uniquely identify a child.
     */
    private Set<String> childrenKeys(MetaDataLoader loader) {
        try {
            String canonical = CanonicalJsonSerializer.canonicalSerialize(loader.getRoot());
            Set<String> keys = new LinkedHashSet<>();
            JsonObject root = JsonParser.parseString(canonical).getAsJsonObject();
            for (String rk : root.keySet()) {
                JsonObject body = root.getAsJsonObject(rk);
                if (body.has("children")) {
                    for (JsonElement el : body.getAsJsonArray("children")) {
                        if (el.isJsonObject()) {
                            JsonObject w = el.getAsJsonObject();
                            for (String tk : w.keySet()) {
                                JsonObject cb = w.getAsJsonObject(tk);
                                String name = cb.has("name") ? cb.get("name").getAsString() : "";
                                String cpkg = cb.has("package") ? cb.get("package").getAsString() : "";
                                keys.add(tk + "|" + cpkg + "|" + name);
                            }
                        }
                    }
                }
            }
            return keys;
        } catch (Exception e) {
            return new LinkedHashSet<>();
        }
    }

    /**
     * From a merged canonical JSON, reconstruct a single-file canonical
     * containing only the children NOT present in {@code depChildrenKeys}.
     */
    private String filterNewChildren(String mergedCanonical, Set<String> depChildrenKeys,
            String declaredPkg) {
        JsonObject root = JsonParser.parseString(mergedCanonical).getAsJsonObject();
        String rootKey = null;
        for (String k : root.keySet()) { if (!"$schema".equals(k)) { rootKey = k; break; } }
        if (rootKey == null) return mergedCanonical;

        JsonObject rootBody = root.getAsJsonObject(rootKey).deepCopy();
        JsonArray allChildren = rootBody.has("children")
                ? rootBody.getAsJsonArray("children") : new JsonArray();

        JsonArray filteredChildren = new JsonArray();
        for (JsonElement childEl : allChildren) {
            if (!childEl.isJsonObject()) continue;
            JsonObject childWrapper = childEl.getAsJsonObject();
            String typeKey = null;
            for (String k : childWrapper.keySet()) { typeKey = k; break; }
            if (typeKey == null) continue;
            JsonObject childBody = childWrapper.getAsJsonObject(typeKey);
            String name = childBody.has("name") ? childBody.get("name").getAsString() : "";
            String cpkg = childBody.has("package") ? childBody.get("package").getAsString() : "";
            String key = typeKey + "|" + cpkg + "|" + name;
            if (!depChildrenKeys.contains(key)) {
                filteredChildren.add(childEl);
            }
        }

        rootBody.add("children", filteredChildren);
        if (declaredPkg != null && !declaredPkg.isEmpty()) {
            rootBody.addProperty("package", declaredPkg);
        }

        JsonObject out = new JsonObject();
        out.add(rootKey, rootBody);
        return prettyPrint(out);
    }

    // -----------------------------------------------------------------------
    // Low-level helpers
    // -----------------------------------------------------------------------

    private void loadFile(MetaDataLoader loader, Path f) throws IOException {
        byte[] bytes = Files.readAllBytes(f);
        String name = f.getFileName().toString();
        if (isCanonicalBytes(bytes)) {
            new com.metaobjects.loader.parser.json.CanonicalJsonParser(loader, name)
                    .loadFromStream(new ByteArrayInputStream(bytes));
        } else if (name.toLowerCase().endsWith(".xml")) {
            new XMLMetaDataParser(loader, name).loadFromStream(new ByteArrayInputStream(bytes));
        } else {
            new JsonMetaDataParser(loader, name).loadFromStream(new ByteArrayInputStream(bytes));
        }
    }

    private boolean isCanonical(Path f) {
        try { return isCanonicalBytes(Files.readAllBytes(f)); } catch (Exception e) { return false; }
    }

    private boolean isCanonicalBytes(byte[] bytes) {
        String s = new String(bytes, StandardCharsets.UTF_8);
        if (!s.isEmpty() && s.charAt(0) == '﻿') s = s.substring(1);
        s = s.stripLeading();
        return s.startsWith("{") && s.contains("\"metadata.") && !s.contains("\"metadata\":");
    }

    private MetaDataLoader freshLoader(String pkg) {
        String name = (pkg != null && !pkg.isEmpty()) ? pkg : "no-package-root";
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, name);
        loader.init();
        return loader;
    }

    private String prettyPrint(JsonObject obj) {
        String raw = new GsonBuilder().setPrettyPrinting().disableHtmlEscaping().create().toJson(obj);
        return raw.stripTrailing() + "\n";
    }

    private void deleteXml(Path p) {
        try {
            if (Files.exists(p)) { Files.delete(p); System.out.println("  DELETED: " + p.getFileName()); }
        } catch (Exception e) { System.err.println("  WARN: " + e.getMessage()); }
    }
}
